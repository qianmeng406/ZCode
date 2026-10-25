#!/usr/bin/env node
/**
 * dev-loop 共享执行工具。与 scripts/git-gate/run-pre-push.mjs 的执行逻辑保持镜像
 * （同样的 20000 字符分批预算、同样的 vitest 调用形态），差别只在日志前缀与
 * 消费方：这里服务开发期验证入口，不挂钩子、不参与门禁缓存。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const E2E_GLOB = "packages/desktop/test/e2e/**/*.test.ts";

export function elapsedLabel(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

// 大改动集会把几千个文件一次性塞进 spawn 参数，撞 Windows 命令行长度上限
// （ENAMETOOLONG）。按累计参数长度分批执行，任一批失败即返回其退出码。
const SPAWN_ARGS_CHAR_BUDGET = 20000;

export function chunkArgs(args) {
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

export function runVitestSelection(root, files, { label = "[dev-loop]" } = {}) {
  const cli = join(root, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(cli)) {
    console.error(`${label} 未找到本地 vitest；请先 pnpm install。`);
    return 1;
  }
  for (const [index, chunk] of chunkArgs(files).entries()) {
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [cli, "run", "--exclude", E2E_GLOB, "--passWithNoTests", ...chunk],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) {
      console.error(`${label} vitest 启动失败：${result.error.message}`);
      return 1;
    }
    console.log(
      `${label} vitest batch ${index + 1}（${chunk.length} 个文件）完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
    );
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
}

/** scripts/ 下的 node:test 文件（纯 JS）直接用 node --test 运行。 */
export function runScriptNodeTests(root, files, { label = "[dev-loop]" } = {}) {
  for (const [index, chunk] of chunkArgs(files).entries()) {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ["--test", ...chunk], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`${label} node --test 启动失败：${result.error.message}`);
      return 1;
    }
    console.log(
      `${label} node --test batch ${index + 1}（${chunk.length} 个文件）完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`,
    );
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
}
