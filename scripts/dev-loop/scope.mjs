#!/usr/bin/env node
/**
 * dev-loop 变更范围解析：确定「这次开发迭代」要检查什么、要不要出包。
 *
 * 与 scripts/git-gate/changed.mjs 同哲学：显式 --base 优先（merge-base 语义）；
 * 默认 worktree 模式（HEAD..工作区，含未跟踪文件）；纯 git 读操作，不改任何状态。
 * 与 git-gate 的差别只在于消费方：这里服务开发期验证（dev:check / dev:package /
 * dev:gate），不挂任何钩子，也不改变 pre-commit / pre-push 的行为。
 *
 * fail closed：无法确定范围时抛错，由调用方退出码 2 并提示显式传 base。
 */

import { spawnSync } from "node:child_process";

import { isE2ETestPath, isTestPath } from "../git-gate/relevance.mjs";

export { isTestPath };

/** 桌面产物（packages/desktop 的 out/ 构建 + app.asar）直接消费的包。 */
export const DESKTOP_CONSUMED_PACKAGES = new Set([
  "packages/desktop",
  "packages/shared",
  "packages/rpc",
  "packages/services",
  "packages/client",
  "packages/ui",
  "packages/provider",
]);

/**
 * CLI agent bundle 经 prepare:runtime-assets 进入桌面产物，增量 asar 不覆盖，
 * 只被 --full 完整打包刷新；本前缀同时驱动 classifyDesktopImpact 的 cli 分档。
 */
export const CLI_AGENT_SOURCE_PREFIX = "apps/zcode-cli/";

const DOC_RE = /\.(?:md|mdx|markdown|txt)$/iu;
// 未跟踪的临时/日志 debris 不属于产物层，不参与出包判定。
const DEBRIS_RE = /\.(?:log|tmp)$/iu;

/** 全局影响文件：改动只提示影响面，不自动升级全量（与 git-gate fcee8b40 的行为一致）。 */
export const GLOBAL_IMPACT_FILES = new Set([
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsconfig.base.json",
]);

export function isDocPath(relPath) {
  return DOC_RE.test(relPath) || relPath.startsWith("docs/");
}

/** 文件所属的 workspace 目录（packages/x、apps/dev-docs、apps/zcode-cli/…）。 */
export function packageDirOf(relPath) {
  const parts = relPath.split("/");
  if (parts[0] === "packages" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "apps" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} 启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result.stdout;
}

function splitNullSeparated(stdout) {
  return stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function diffNames(cwd, diffArgs, filter) {
  const stdout = runGit(cwd, ["diff", ...diffArgs, "--name-only", "-z", `--diff-filter=${filter}`]);
  return splitNullSeparated(stdout);
}

/**
 * numstat 增删行解析（与 git-gate 的 diffNumstatMap + `value.deleted === 0` 过滤
 * 语义完全一致）：binary 行的 "-" 映射为 0；「仅新增行」= 没有删除行。
 * 既增又删的枢纽文件不算仅新增——其直接 import 的测试会被 selectRelatedTests
 * 展开（hubExpanded），漏判会让该 barrel 的测试静默漏选。
 */
export function parseNumstatAdditionsOnly(stdout) {
  const additionsOnly = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [, deleted, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const deletedCount = Number.isFinite(Number(deleted)) ? Number(deleted) : 0;
    if (deletedCount === 0) additionsOnly.push(path);
  }
  return additionsOnly;
}

function readAdditionsOnlySources(cwd, diffArgs) {
  const stdout = runGit(cwd, ["diff", ...diffArgs, "--numstat"], { allowFailure: true }) ?? "";
  return parseNumstatAdditionsOnly(stdout);
}

/**
 * 解析本次迭代的变更文件集。
 * - base 显式给出：merge-base(base, head)..head（与 gate 的推送范围语义一致）；
 * - 否则 worktree 模式：HEAD..工作区 + 未跟踪文件（--exclude-standard 已滤掉 gitignore）。
 */
export function resolveChangedFiles({ cwd, base, head = "HEAD" } = {}) {
  if (base) {
    const mergeBase =
      runGit(cwd, ["merge-base", base, head], { allowFailure: true })?.trim() ?? base;
    const diffArgs = [mergeBase, head];
    return {
      label: `范围 ${base}..${head}`,
      comparisonBase: mergeBase,
      head,
      changed: diffNames(cwd, diffArgs, "ACMRTUXB"),
      deleted: diffNames(cwd, diffArgs, "D"),
      additionsOnlySources: readAdditionsOnlySources(cwd, diffArgs),
    };
  }

  const diffArgs = ["HEAD"];
  const untracked = splitNullSeparated(
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  return {
    label: "worktree（HEAD..工作区，含未跟踪）",
    comparisonBase: "HEAD",
    head: "worktree",
    changed: [...diffNames(cwd, diffArgs, "ACMRTUXB"), ...untracked],
    deleted: diffNames(cwd, diffArgs, "D"),
    additionsOnlySources: readAdditionsOnlySources(cwd, diffArgs),
  };
}

/**
 * 桌面产物影响判定（纯函数，边界见 docs/dev-loop.md）：
 * - mode "incremental"：out/ 构建消费的 src 改了，增量 asar 即可；
 * - mode "full"：资源层（desktop config/scripts/resources）或 CLI agent bundle 改了，
 *   增量 asar 不覆盖，需要完整打包；
 * - mode "none"：仅文档 / 测试 / 与桌面产物无关的改动。
 */
export function classifyDesktopImpact(changedFiles) {
  const incremental = [];
  const full = [];
  const cli = [];
  for (const relPath of changedFiles) {
    // e2e 用例属于测试文件（isTestPath 对 e2e 前缀显式返回 false），同样不出包。
    if (DEBRIS_RE.test(relPath)) continue;
    if (isDocPath(relPath) || isTestPath(relPath) || isE2ETestPath(relPath)) continue;
    if (relPath.startsWith(CLI_AGENT_SOURCE_PREFIX)) {
      cli.push(relPath);
      continue;
    }
    const packageDir = packageDirOf(relPath);
    if (!packageDir) continue;
    if (packageDir === "packages/desktop") {
      if (relPath.startsWith("packages/desktop/src/")) {
        incremental.push(relPath);
      } else {
        full.push(relPath);
      }
      continue;
    }
    if (DESKTOP_CONSUMED_PACKAGES.has(packageDir)) {
      if (relPath.includes("/src/")) {
        incremental.push(relPath);
      } else {
        full.push(relPath);
      }
    }
  }
  // cli 改动参与 mode 判定：CLI agent bundle 经 prepare:runtime-assets 进入桌面
  // 产物，只有 --full 会刷新——按增量处理会静默产出不含该改动的包。
  const mode =
    full.length > 0 || cli.length > 0 ? "full" : incremental.length > 0 ? "incremental" : "none";
  return { mode, incremental, full, cli };
}

/** out/ 构建实际消费的 src 目录（watch 集，供出包新鲜度判定）。 */
export const WATCHED_SRC_DIRS = [
  "packages/desktop/src",
  "packages/shared/src",
  "packages/rpc/src",
  "packages/services/src",
  "packages/client/src",
  "packages/ui/src",
  "packages/provider/src",
];

export function isWatchedSrcPath(relPath) {
  return WATCHED_SRC_DIRS.some((dir) => relPath.startsWith(`${dir}/`));
}
