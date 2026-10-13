#!/usr/bin/env node
// 本仓库单测双 runner 入口：vitest（上游用例）与 Node 内置 test runner（fork 侧 `node:test` 用例）。
// 二者都必须执行：任一失败不影响另一 runner 继续运行，最终聚合退出码。
// 之所以不能只靠 vitest：fork 的 node:test 文件被 vitest 收集时会报 “No test suite found”，
// 因此 vitest 配置显式排除它们，并由本入口补跑（覆盖不遗漏）。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runForkNodeTests } from "./fork-node-test-runner.mjs";

const root = process.cwd();
const E2E_GLOB = "packages/desktop/test/e2e/**/*.test.ts";

function resolvePnpmCliPath() {
  const npmExecPath = process.env.npm_execpath;
  if (
    npmExecPath &&
    (npmExecPath.toLowerCase().includes("\\pnpm\\") || npmExecPath.toLowerCase().includes("/pnpm/"))
  ) {
    return npmExecPath;
  }
  return undefined;
}

function runVitest() {
  try {
    const entries = readdirSync(join(root, "node_modules", "vitest"));
    if (!entries.includes("vitest.mjs")) {
      throw new Error("vitest.mjs not found");
    }
  } catch {
    console.error("[unit] 未找到本地 vitest；请先 pnpm install。");
    return 1;
  }

  // 优先直接调用 vitest JS 入口，避免 Windows 下 shell 字符串展开问题。
  const vitestCli = join(root, "node_modules", "vitest", "vitest.mjs");
  const args = ["run", "--exclude", E2E_GLOB];
  const result = existsSync(vitestCli)
    ? spawnSync(process.execPath, [vitestCli, ...args], { cwd: root, stdio: "inherit" })
    : spawnSync(resolvePnpmCliPath() ?? "pnpm", ["exec", "vitest", ...args], {
        cwd: root,
        stdio: "inherit",
      });
  if (result.error) {
    console.error(`[unit] failed to spawn vitest: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

console.log("[unit] 1/2 vitest");
const vitestStatus = runVitest();

console.log("[unit] 2/2 fork node:test");
const nodeResult = runForkNodeTests(root);

if (nodeResult.ran === 0) {
  console.log("[unit] 未发现 fork node:test 文件");
}

process.exitCode = vitestStatus !== 0 || nodeResult.status !== 0 ? 1 : 0;
