#!/usr/bin/env node
// fork 侧 Node 内置 test runner（`import test from "node:test"`）文件的统一发现与执行。
// 这些文件不被 vitest 收集（见 vitest.config.ts 的 forkNodeTestRunnerFiles 排除），
// 必须由本模块用 `node --import tsx --test` 在各自 package 目录内运行，才能解析 tsconfig paths。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const NODE_TEST_MARKER = 'from "node:test"';

function walkTestFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function isNodeTestFile(file) {
  try {
    return readFileSync(file, "utf8").includes(NODE_TEST_MARKER);
  } catch {
    return false;
  }
}

/** 发现仓库内所有 fork Node-runner 测试文件（绝对路径）。 */
export function discoverForkNodeTestFiles(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  return walkTestFiles(packagesDir, [])
    .filter((file) => /[\\/]test[\\/]/.test(file))
    .filter(isNodeTestFile);
}

function packageDirOf(root, file) {
  const rel = relative(root, file).split("\\").join("/");
  const match = rel.match(/^(packages\/[^/]+)\//u);
  return match ? resolve(root, match[1]) : root;
}

/**
 * 运行给定（或全部）fork Node-runner 测试文件；返回 { status, ran }。
 * - files: 可选的过滤集合（绝对或相对 root 路径）；命中集合内的 node:test 文件才运行。
 * - 逐个文件在各自 package 目录内 spawn，全量失败仍继续（不 early-exit），聚合非零退出码。
 */
export function runForkNodeTests(root, files) {
  const discovered = discoverForkNodeTestFiles(root);
  const filterSet =
    files && files.length > 0
      ? new Set(files.map((file) => resolve(root, file).split("\\").join("/")))
      : null;
  const targets = filterSet
    ? discovered.filter((file) => filterSet.has(file.split("\\").join("/")))
    : discovered;

  if (targets.length === 0) {
    return { status: 0, ran: 0 };
  }

  const env = { ...process.env };
  const binDir = join(root, "node_modules", ".bin");
  env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;

  let status = 0;
  for (const file of targets) {
    const cwd = packageDirOf(root, file);
    const rel = relative(cwd, file).split("\\").join("/");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", rel], {
      cwd,
      env,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`[fork-node-tests] failed to spawn ${rel}: ${result.error.message}`);
      status = 1;
      continue;
    }
    if ((result.status ?? 1) !== 0) status = 1;
  }

  return { status, ran: targets.length };
}

export { isNodeTestFile };
