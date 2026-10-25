#!/usr/bin/env node
/**
 * dev:gate —— 开发期链式入口：范围检查通过后，按桌面产物影响判定自动出包。
 *
 * 流程：resolveScope → dev:check（类型检查 + 强相关测试）→ 通过且需要出包 →
 * dev:package（增量 asar；资源层 / CLI agent bundle 改动会要求 --full 并非零
 * 退出，由调用方显式重跑 dev:gate --full）。任一步失败即停，不静默跳过。
 *
 * 用法：pnpm dev:gate [--base <ref>] [--scope ...] [--direct] [--dry-run]
 *                     [--full] [--force-build] [--dist <dir>]
 */

import { pathToFileURL } from "node:url";

import { runCheck } from "./run-check.mjs";
import { runPackage } from "./run-package.mjs";

const PACKAGE_FLAGS = new Set(["--full", "--force-build", "--dist", "--os", "--arch"]);

/** 从混合参数里挑出打包旗标（带值旗标连同值一起带上）。 */
function extractPackageArgs(argv) {
  const packageArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!PACKAGE_FLAGS.has(arg)) continue;
    packageArgs.push(arg);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      packageArgs.push(next);
      index += 1;
    }
  }
  return packageArgs;
}

export async function runGate(argv = process.argv.slice(2)) {
  const checkArgs = argv.filter((arg) => !PACKAGE_FLAGS.has(arg));
  const packageArgs = extractPackageArgs(argv);

  const { status, scopeReport } = await runCheck(checkArgs);
  if (status !== 0) {
    console.error("[dev-loop] 检查未通过，跳过出包。");
    return status;
  }

  const packageStatus = await runPackage(packageArgs, { scopeReport });
  if (packageStatus === 0) {
    console.log("[dev-loop] dev:gate 完成：检查 + 出包全部通过。");
  } else {
    console.error("[dev-loop] dev:gate 失败于出包阶段。");
  }
  return packageStatus;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exitCode = await runGate();
}
