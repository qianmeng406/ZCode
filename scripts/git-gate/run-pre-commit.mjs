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

// 大提交（如全仓格式对齐/上游合并）会把几千个文件一次性塞进 spawn 参数，
// 撞 Windows 命令行长度上限（ENAMETOOLONG）。按累计参数长度分批执行，
// 每批单独起进程；任一批失败即返回其退出码。
const SPAWN_ARGS_CHAR_BUDGET = 20000;

function chunkArgs(args) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const arg of args) {
    if (current.length > 0 && currentLength + arg.length + 1 > SPAWN_ARGS_CHAR_BUDGET) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(arg);
    currentLength += arg.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function runToolChunked({ root, name, baseArgs = [], files, label }) {
  const chunks = chunkArgs(files);
  for (const [index, chunk] of chunks.entries()) {
    const status = runTool({
      root,
      name,
      args: [...baseArgs, ...chunk],
      label: `${label} [batch ${index + 1}/${chunks.length}, ${chunk.length} files]`,
    });
    if (status !== 0) return status;
  }
  return 0;
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
  const status = runToolChunked({
    root,
    name: "oxlint",
    files: lintable,
    label: `oxlint (${lintable.length} files)`,
  });
  if (status !== 0) process.exit(status);
}

const formattable = staged.filter((file) => FORMATTABLE_RE.test(file));
if (formattable.length > 0) {
  const status = runToolChunked({
    root,
    name: "oxfmt",
    baseArgs: ["--check", "--no-error-on-unmatched-pattern"],
    files: formattable,
    label: `oxfmt --check (${formattable.length} files)`,
  });
  if (status !== 0) {
    console.error(
      "[git-gate:pre-commit] 格式未通过；可执行 pnpm exec oxfmt --write <files> 后重试。",
    );
    process.exit(status);
  }
}
