#!/usr/bin/env node
/**
 * pre-commit 快速门禁：只看暂存文件，目标 5 秒内结束。
 *
 * 顺序：文件策略/密钥初筛 → oxlint → oxfmt --check。
 * 单测、架构检查、类型检查都放在更后面的层（pre-push / CI），
 * 避免每次提交都付出全仓检查的代价。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { collectStagedFileContents, evaluateFiles, formatViolations } from "./file-policy.mjs";

const JS_LIKE_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/u;
const FORMATTABLE_RE = /\.(?:js|jsx|ts|tsx|mjs|cjs|json|jsonc|md|mdx|yml|yaml|css)$/u;
// 根 oxlint 配置忽略 CLI 目录（它有自己的工具链），显式传文件时保持一致。
const LOCAL_LINT_EXCLUDES = ["apps/zcode-cli/"];

function resolveToolBin(root, name) {
  const candidates = [
    join(root, "node_modules", name, "bin", name),
    join(root, "node_modules", name, "bin", `${name}.js`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function runTool({ root, name, args, label }) {
  const bin = resolveToolBin(root, name);
  if (!bin) {
    console.error(`[git-gate:pre-commit] 未找到 ${name}；请先 pnpm install。`);
    return 1;
  }
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`[git-gate:pre-commit] ${label} 启动失败：${result.error.message}`);
    return 1;
  }
  console.log(`[git-gate:pre-commit] ${label} (${Date.now() - startedAt}ms)`);
  return result.status ?? 1;
}

const root = process.cwd();
const files = collectStagedFileContents(root);
if (files.length === 0) process.exit(0);

const violations = evaluateFiles(files);
if (violations.length > 0) {
  for (const line of formatViolations(violations)) console.error(line);
  console.error("[git-gate:pre-commit] 文件策略未通过，提交已阻止。");
  process.exit(1);
}

const staged = files.map((file) => file.path.split("\\").join("/"));
const lintable = staged.filter(
  (file) => JS_LIKE_RE.test(file) && !LOCAL_LINT_EXCLUDES.some((prefix) => file.startsWith(prefix)),
);
if (lintable.length > 0) {
  const status = runTool({
    root,
    name: "oxlint",
    args: lintable,
    label: `oxlint (${lintable.length} files)`,
  });
  if (status !== 0) process.exit(status);
}

const formattable = staged.filter((file) => FORMATTABLE_RE.test(file));
if (formattable.length > 0) {
  const status = runTool({
    root,
    name: "oxfmt",
    args: ["--check", ...formattable],
    label: `oxfmt --check (${formattable.length} files)`,
  });
  if (status !== 0) {
    console.error(
      "[git-gate:pre-commit] 格式未通过；可执行 pnpm exec oxfmt --write <files> 后重试。",
    );
    process.exit(status);
  }
}
