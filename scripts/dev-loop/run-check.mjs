#!/usr/bin/env node
/**
 * dev:check —— 开发期范围验证入口：类型检查 + 强相关测试，只针对「这次改动」。
 *
 * 边界设计与 git 提交门禁同构（见 docs/dev-loop.md）：
 * - 范围：显式 --base 优先，默认 worktree（HEAD..工作区 + 未跟踪）；
 * - 类型检查：tsconfig 项目图上的直接集 ∪ 反向依赖闭包（--direct 只查直接集）；
 * - 测试：复用 git-gate/relevance.mjs 的强相关选择（--scope package|full 同门禁语义）；
 * - 全局配置文件（lockfile / vitest.config / tsconfig.base / 根依赖段）只提示，
 *   不自动升级全量；全量永远显式（--scope full 或 pnpm test:unit）。
 *
 * 用法：
 *   pnpm dev:check [--base <ref>] [--tests-only] [--typecheck-only]
 *                  [--scope strong|package|full] [--direct] [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runForkNodeTests } from "../fork-node-test-runner.mjs";
import { buildRepoIndex, listCandidateTests, selectRelatedTests } from "../git-gate/relevance.mjs";

import { runScriptNodeTests, runVitestSelection } from "./proc.mjs";
import {
  CLI_AGENT_SOURCE_PREFIX,
  GLOBAL_IMPACT_FILES,
  classifyDesktopImpact,
  isDocPath,
  resolveChangedFiles,
} from "./scope.mjs";
import {
  ROOT_TYPECHECK_EXCLUDED_PROJECTS,
  affectedProjectIds,
  buildTsProjectGraph,
  changedDirsOfFiles,
} from "./tsgraph.mjs";

function parseArgs(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    testsOnly: argv.includes("--tests-only"),
    typecheckOnly: argv.includes("--typecheck-only"),
    dryRun: argv.includes("--dry-run"),
    direct: argv.includes("--direct"),
    base: option("--base"),
    scope: option("--scope") ?? process.env.ZCODE_GATE_SCOPE ?? "strong",
  };
}

function elapsedLabel(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function resolveTscPath(root) {
  const tscJs = join(root, "node_modules", "typescript", "lib", "tsc.js");
  if (existsSync(tscJs)) return tscJs;
  return undefined;
}

function runTypecheck(root, graph, projectIds) {
  const tscJs = resolveTscPath(root);
  if (!tscJs) {
    console.error("[dev-loop] 未找到 node_modules/typescript/lib/tsc.js；请先 pnpm install。");
    return 1;
  }
  let status = 0;
  const bProjects = projectIds.filter((id) => graph.get(id)?.kind === "b");
  if (bProjects.length > 0) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [tscJs, "-b", ...bProjects], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`[dev-loop] tsc -b 启动失败：${result.error.message}`);
      return 1;
    }
    console.log(
      `[dev-loop] 类型检查（tsc -b ${bProjects.length} 个项目）完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
    );
    if ((result.status ?? 1) !== 0) status = result.status ?? 1;
  }
  for (const id of projectIds) {
    if (graph.get(id)?.kind !== "p") continue;
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [tscJs, "-p", join(root, graph.get(id).dir), "--noEmit"],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) {
      console.error(`[dev-loop] tsc -p 启动失败：${result.error.message}`);
      return 1;
    }
    console.log(
      `[dev-loop] 类型检查（tsc -p ${id}）完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
    );
    if ((result.status ?? 1) !== 0) status = result.status ?? 1;
  }
  return status;
}

/**
 * 执行范围检查。返回 { status, scopeReport }；scopeReport 供 dev:gate 链式
 * 决定是否出包（避免二次解析 git 范围）。
 */
export async function runCheck(argv = process.argv.slice(2)) {
  const root = process.cwd();
  const options = parseArgs(argv);

  let range;
  try {
    range = resolveChangedFiles({ cwd: root, base: options.base });
  } catch (error) {
    console.error(`[dev-loop] ${error.message}`);
    console.error("[dev-loop] 显式指定后再试：pnpm dev:check --base <ref>。");
    return { status: 2, scopeReport: undefined };
  }
  const { label, changed, deleted } = range;
  console.log(`[dev-loop] ${label}：改动 ${changed.length}，删除 ${deleted.length}`);

  const changedDirs = changedDirsOfFiles([...changed, ...deleted]);
  const impact = classifyDesktopImpact([...changed, ...deleted]);

  const globalImpact = changed.filter(
    (file) => GLOBAL_IMPACT_FILES.has(file) || file === "package.json",
  );
  for (const file of globalImpact) {
    console.log(
      `[dev-loop] 全局影响文件：${file}；本地仍只做范围检查，全量由 CI 或显式 --scope full 覆盖。`,
    );
  }
  if (changed.some((file) => file.startsWith(CLI_AGENT_SOURCE_PREFIX))) {
    console.log(
      "[dev-loop] apps/zcode-cli 改动：根链路不覆盖，类型检查/测试走 pnpm --dir apps/zcode-cli typecheck|test。",
    );
  }

  const scopeReport = {
    label,
    changed,
    deleted,
    changedDirs: [...changedDirs],
    impact,
    docsOnly: changed.length > 0 && changed.every(isDocPath),
  };

  let status = 0;

  if (!options.testsOnly) {
    const graph = buildTsProjectGraph(root, { exclude: ROOT_TYPECHECK_EXCLUDED_PROJECTS });
    const projectIds = affectedProjectIds(graph, changedDirs, {
      scope: options.direct ? "direct" : "affected",
    });
    if (projectIds.length === 0) {
      console.log("[dev-loop] 类型检查：改动不涉及任何 tsconfig 项目，跳过。");
    } else {
      console.log(
        `[dev-loop] 类型检查：选中 ${projectIds.length} 个 tsconfig 项目（${options.direct ? "direct" : "affected"}）：`,
      );
      for (const id of projectIds) console.log(`  - ${id}`);
      if (options.dryRun) {
        console.log("[dev-loop] --dry-run：类型检查未执行。");
      } else {
        status = runTypecheck(root, graph, projectIds);
      }
    }
  }
  if (options.typecheckOnly) {
    return { status, scopeReport };
  }

  const index = buildRepoIndex(root);
  const candidates = listCandidateTests({ cwd: root, root });
  const selection = selectRelatedTests({
    index,
    changedFiles: changed,
    deletedFiles: deleted,
    candidates,
    scope: options.scope,
    additionsOnlySources: range.additionsOnlySources,
  });

  for (const entry of selection.hubSkipped) {
    console.log(
      `[dev-loop] 枢纽文件跳过 import 归因（只新增行）：${entry.source}（${entry.importers} 个测试）`,
    );
  }
  for (const entry of selection.hubExpanded) {
    console.log(
      `[dev-loop] 枢纽文件含删除行：${entry.source}（${entry.importers} 个直接 import 的测试已全部选中）`,
    );
  }
  console.log(
    `[dev-loop] 强相关测试（scope=${options.scope}）：扫描 ${selection.scanned} 个测试文件，选中 ${selection.selected.length}` +
      `（vitest ${selection.vitest.length} / node:test ${selection.node.length}）`,
  );
  if (selection.uncovered.length > 0) {
    console.log(`[dev-loop] 没有命中任何测试的改动源码 ${selection.uncovered.length} 个：`);
    for (const file of selection.uncovered) console.log(`  ? ${file}`);
    console.log("[dev-loop] 需要更强覆盖时：pnpm dev:check --scope package 或 --scope full");
  }

  if (options.dryRun) {
    for (const file of selection.selected) console.log(`  + ${file}`);
    console.log("[dev-loop] --dry-run：只打印选择结果，未执行测试。");
    return { status, scopeReport };
  }

  if (selection.full) {
    console.log("[dev-loop] 执行全量单测（vitest + fork node:test）");
    const result = spawnSync(process.execPath, [join(root, "scripts", "run-unit-tests.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`[dev-loop] 全量单测启动失败：${result.error.message}`);
      return { status: status !== 0 ? status : 1, scopeReport };
    }
    // 类型检查早已失败时不能被全量单测的通过掩盖（fail closed）。
    const unitStatus = result.status ?? 1;
    return { status: status !== 0 ? status : unitStatus, scopeReport };
  }

  if (selection.vitest.length > 0) {
    const vitestStatus = runVitestSelection(root, selection.vitest);
    if (vitestStatus !== 0) status = vitestStatus;
  }
  // node:test 分两类（与 gate 一致）：packages/ 下逐包 tsx 解析（fork runner），
  // scripts/ 下纯 JS 直接 node --test。空集合必须跳过：runForkNodeTests 收到
  // 空数组会退化成「跑全部」。
  const scriptNodeTests = selection.node.filter((file) => file.startsWith("scripts/"));
  const packageNodeTests = selection.node.filter((file) => !file.startsWith("scripts/"));
  if (scriptNodeTests.length > 0 && runScriptNodeTests(root, scriptNodeTests) !== 0) status = 1;
  if (packageNodeTests.length > 0) {
    const nodeResult = runForkNodeTests(root, packageNodeTests);
    if (nodeResult.ran === 0) {
      console.log("[dev-loop] 选中的 node:test 文件未被发现，跳过。");
    }
    if (nodeResult.status !== 0) status = 1;
  }

  if (status === 0) {
    console.log("[dev-loop] 检查通过。");
  }
  return { status, scopeReport };
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const { status } = await runCheck();
  process.exitCode = status;
}
