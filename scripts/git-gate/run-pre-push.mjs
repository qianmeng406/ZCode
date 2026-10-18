#!/usr/bin/env node
/**
 * pre-push 门禁：只检查「这次推送范围」，不跑全量。
 *
 * 顺序：文件策略 → oxlint（改动文件）→ fmt --check（改动文件）→ 架构检查 → 强相关测试。
 * 测试选择见 relevance.mjs：改动测试 + 直接 import 改动源码的测试 + 同包同名测试，
 * 不做传递展开。改动的源码若没有任何测试命中，会在报告里逐条列出。
 *
 * 显式放大：
 *   ZCODE_GATE_SCOPE=package|full   （或 --scope）
 * 全局配置类改动（lockfile、vitest 配置、tsconfig.base、package.json 依赖段）
 * 会自动升级到 full，并在报告里说明原因。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runForkNodeTests } from "../fork-node-test-runner.mjs";
import {
  diffNumstatMap,
  normalizeRange,
  readChangedFiles,
  readFileAtRevision,
  resolveChangeRange,
} from "./changed.mjs";
import { collectRevisionFileContents, evaluateFiles, formatViolations } from "./file-policy.mjs";
import { buildRepoIndex, listCandidateTests, selectRelatedTests } from "./relevance.mjs";

const E2E_GLOB = "packages/desktop/test/e2e/**/*.test.ts";
const JS_LIKE_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/u;
const FORMATTABLE_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|css)$/u;
const LOCAL_LINT_EXCLUDES = ["apps/zcode-cli/"];
const GLOBAL_IMPACT_FILES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig.base.json",
]);

function parseArgs(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    testsOnly: argv.includes("--tests-only"),
    staticOnly: argv.includes("--static-only"),
    dryRun: argv.includes("--dry-run"),
    base: option("--base"),
    head: option("--head") ?? "HEAD",
    scope: option("--scope") ?? process.env.ZCODE_GATE_SCOPE ?? "strong",
  };
}

function elapsedLabel(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function runNodeScript(root, script, args, label) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[git-gate] ${label} 启动失败：${result.error.message}`);
    return 1;
  }
  console.log(`[git-gate] ${label} 完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`);
  return result.status ?? 1;
}

function runVitestSelection(root, files) {
  const cli = join(root, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(cli)) {
    console.error("[git-gate] 未找到本地 vitest；请先 pnpm install。");
    return 1;
  }
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [cli, "run", "--exclude", E2E_GLOB, "--passWithNoTests", ...files],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) {
    console.error(`[git-gate] vitest 启动失败：${result.error.message}`);
    return 1;
  }
  console.log(
    `[git-gate] vitest ${files.length} 个文件完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
  );
  return result.status ?? 1;
}

/** scripts/ 下的 node:test 文件（门禁自身回归）直接用 node --test 运行。 */
function runScriptNodeTests(root, files) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`[git-gate] node --test 启动失败：${result.error.message}`);
    return 1;
  }
  console.log(
    `[git-gate] node --test ${files.length} 个文件完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
  );
  return result.status ?? 1;
}

function packageJsonDependencySectionChanged(root, base, head) {
  const before = JSON.parse(readFileAtRevision(root, base, "package.json") ?? "null");
  const after = JSON.parse(readFileAtRevision(root, head, "package.json") ?? "null");
  if (!before || !after) return true;
  const pick = (manifest) =>
    JSON.stringify({
      dependencies: manifest.dependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
      overrides: manifest.overrides ?? manifest.pnpm?.overrides ?? {},
    });
  return pick(before) !== pick(after);
}

export async function runGate(argv = process.argv.slice(2)) {
  const root = process.cwd();
  const options = parseArgs(argv);
  const range =
    normalizeRange({ cwd: root, base: options.base, head: options.head }) ??
    resolveChangeRange({ cwd: root, stdin: process.env.ZCODE_PRE_PUSH_STDIN ?? "" });

  if (!range) {
    console.error(
      "[git-gate] 无法确定比较范围（没有 remote sha / upstream / 默认分支）。\n" +
        "  显式指定后再试：ZCODE_GATE_BASE=<sha> git push，或 ZCODE_GATE_SCOPE=full。",
    );
    return 2;
  }

  const { changed, deleted, comparisonBase } = await readChangedFiles(root, range);
  console.log(
    `[git-gate] 范围 ${range.label}：${comparisonBase.slice(0, 8)}..${range.head}，改动 ${changed.length}，删除 ${deleted.length}`,
  );

  if (!options.testsOnly) {
    const policyFiles = await collectRevisionFileContents(root, range);
    const violations = evaluateFiles(policyFiles);
    if (violations.length > 0) {
      for (const line of formatViolations(violations)) console.error(line);
      console.error("[git-gate] 文件策略未通过，推送已阻止。");
      return 1;
    }
    console.log(`[git-gate] 文件策略通过（${policyFiles.length} 个文件）`);

    const lintable = changed.filter(
      (file) =>
        JS_LIKE_RE.test(file) &&
        existsSync(join(root, file)) &&
        !LOCAL_LINT_EXCLUDES.some((prefix) => file.startsWith(prefix)),
    );
    if (lintable.length > 0) {
      const status = runNodeScript(
        root,
        "node_modules/oxlint/bin/oxlint",
        lintable,
        `oxlint（${lintable.length} 个改动文件）`,
      );
      if (status !== 0) return status;
    }

    const formattable = changed.filter(
      (file) => FORMATTABLE_RE.test(file) && existsSync(join(root, file)),
    );
    if (formattable.length > 0) {
      const status = runNodeScript(
        root,
        "node_modules/oxfmt/bin/oxfmt",
        ["--check", ...formattable],
        `oxfmt --check（${formattable.length} 个改动文件）`,
      );
      if (status !== 0) {
        console.error("[git-gate] 格式未通过；可执行 pnpm exec oxfmt --write <files> 后重试。");
        return status;
      }
    }

    const architectureStatus = runNodeScript(
      root,
      "scripts/architecture/architecture-check.mjs",
      ["check", "--changed"],
      "架构检查（--changed）",
    );
    if (architectureStatus !== 0) return architectureStatus;
  }

  if (options.staticOnly) return 0;

  const numstat = diffNumstatMap(root, comparisonBase, range.head);
  const additionsOnlySources = [...numstat.entries()]
    .filter(([, value]) => value.deleted === 0)
    .map(([path]) => path);
  const globalImpact = [];
  for (const file of changed) {
    if (GLOBAL_IMPACT_FILES.has(file)) globalImpact.push({ file, reason: "全局配置" });
  }
  if (
    changed.includes("package.json") &&
    packageJsonDependencySectionChanged(root, comparisonBase, range.head)
  ) {
    globalImpact.push({ file: "package.json", reason: "依赖段变更" });
  }

  let scope = options.scope;
  if (scope !== "full" && globalImpact.length > 0) {
    for (const entry of globalImpact) {
      console.log(`[git-gate] 升级为全量：${entry.file} — ${entry.reason}`);
    }
    scope = "full";
  }

  const index = buildRepoIndex(root);
  const candidates = listCandidateTests({ cwd: root, root });
  const selection = selectRelatedTests({
    index,
    changedFiles: changed,
    deletedFiles: deleted,
    candidates,
    scope,
    additionsOnlySources,
  });

  if (selection.full) {
    for (const entry of selection.escalations) {
      console.log(
        `[git-gate] 升级为全量：${entry.source} — 被 ${entry.importers} 个测试直接 import，` +
          "且本次变更删除了行，import 者可能全部受影响",
      );
    }
    if (options.dryRun) {
      console.log(`[git-gate] --dry-run：范围会升级为全量（${selection.scanned} 个测试文件）。`);
      return 0;
    }
    console.log("[git-gate] 执行全量单测（vitest + fork node:test）");
    return runNodeScript(root, "scripts/run-unit-tests.mjs", [], "全量单测");
  }

  for (const entry of selection.hubSkipped) {
    console.log(
      `[git-gate] 枢纽文件跳过 import 归因（只新增行）：${entry.source}（${entry.importers} 个测试）`,
    );
  }
  console.log(
    `[git-gate] 强相关测试：扫描 ${selection.scanned} 个测试文件，选中 ${selection.selected.length}` +
      `（vitest ${selection.vitest.length} / node:test ${selection.node.length}）`,
  );
  if (selection.changedTests.length > 0) {
    console.log(`[git-gate] 其中直接改动的测试文件 ${selection.changedTests.length} 个`);
  }
  if (selection.uncovered.length > 0) {
    console.log(`[git-gate] 没有命中任何测试的改动源码 ${selection.uncovered.length} 个：`);
    for (const file of selection.uncovered) console.log(`  ? ${file}`);
    console.log(
      "[git-gate] 需要更强覆盖时：ZCODE_GATE_SCOPE=package git push 或 ZCODE_GATE_SCOPE=full git push",
    );
  }

  let status = 0;
  if (options.dryRun) {
    for (const file of selection.selected) console.log(`  + ${file}`);
    console.log("[git-gate] --dry-run：只打印选择结果，未执行测试。");
    return 0;
  }
  if (selection.vitest.length > 0) {
    status = runVitestSelection(root, selection.vitest);
  }
  // node:test 分两类：packages/ 下需要逐包 tsx 解析（fork runner），
  // scripts/ 下是纯 JS，直接用 node --test。空集合必须跳过：
  // runForkNodeTests 收到空数组会退化成「跑全部」。
  const scriptNodeTests = selection.node.filter((file) => file.startsWith("scripts/"));
  const packageNodeTests = selection.node.filter((file) => !file.startsWith("scripts/"));
  if (scriptNodeTests.length > 0 && runScriptNodeTests(root, scriptNodeTests) !== 0) status = 1;
  if (packageNodeTests.length > 0) {
    const nodeResult = runForkNodeTests(root, packageNodeTests);
    if (nodeResult.ran === 0) {
      console.log("[git-gate] 选中的 node:test 文件未被发现，跳过。");
    }
    if (nodeResult.status !== 0) status = 1;
  }
  return status;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exitCode = await runGate();
}
