#!/usr/bin/env node
/**
 * dev-loop 类型检查边界：把「改动的包」映射到「必须检查的 tsconfig 项目」。
 *
 * 仓库用 composite + project references（tsconfig.base.json），最小可执行粒度是
 * 一个 tsconfig 项目，`tsc -b` 靠 .tsbuildinfo 天然增量。这里在启动时纯文本解析
 * 各包 tsconfig 的 references 建 {项目 → 依赖, 被依赖} 图（不引入新依赖），然后：
 * - 直接集：改动包拥有的项目；
 * - 受影响集（默认）：直接集 ∪ 反向依赖闭包 —— 改 packages/shared 会得到近全图，
 *   这是诚实的（共享包改动确实全局），二次运行靠 tsbuildinfo 变快。
 *
 * 与根 `pnpm typecheck` 的差别：不跑重型 typecheck:deps（turbo 适配器构建），
 * 不跑根 package.json 依赖段检查；全局配置文件（tsconfig.base.json 等）只提示，
 * 不自动升级全量。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { packageDirOf } from "./scope.mjs";

export function toPosix(value) {
  return value.split("\\").join("/");
}

/**
 * 解析 tsconfig 的 references 路径。tsconfig 不是严格 JSON（有行内/块注释、
 * 尾逗号），这里做 JSONC 容忍解析：字符串感知的状态机剥离注释（不碰字符串
 * 内的 `//`），再去尾逗号后 JSON.parse。
 */
export function parseTsconfigReferences(source) {
  const withoutComments = stripJsoncComments(source);
  const withoutTrailingCommas = withoutTrailingCommasInObjects(withoutComments);
  let parsed;
  try {
    parsed = JSON.parse(withoutTrailingCommas);
  } catch (error) {
    throw new Error(`tsconfig 解析失败：${error.message}`);
  }
  const references = parsed?.references;
  if (!Array.isArray(references)) return [];
  return references.map((entry) => entry?.path).filter((path) => typeof path === "string");
}

function stripJsoncComments(source) {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index];
    if (inString) {
      output += char;
      if (char === "\\") {
        // 转义序列原样带过（含 \" )
        if (index + 1 < source.length) output += source[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

// 只去对象字面量/数组里的尾逗号（", }" / ", ]"），不动字符串内容。
function withoutTrailingCommasInObjects(source) {
  return source.replace(/,(\s*[}\]])/gu, "$1");
}

/** 把 reference 的 path（"./tsconfig.main.json"、"."、"../shared"）归一到项目 id。 */
function resolveReferenceId(root, ownerDir, refPath) {
  let target = resolve(ownerDir, refPath);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) target = resolve(target, "tsconfig.json");
  if (!existsSync(target)) return undefined;
  return toPosix(relative(root, target));
}

/**
 * 发现 tsconfig 项目并建图。收集范围 = 根 `pnpm typecheck` 覆盖面的超集：
 * - packages/<pkg>/tsconfig.json（含无 references 的叶子包）
 * - packages/desktop/tsconfig.*.json（main/host/scheduler/preload/renderer/e2e/remote-main）
 * - packages/shared/tsconfig.testing.json
 * - apps/dev-docs/tsconfig.json
 * kind："b"（tsc -b <path>）或 "p"（tsc -p <dir> --noEmit，与根脚本对 zcode-cua /
 * remote-main 的调用方式一致）。
 */
export function buildTsProjectGraph(root, { exclude } = {}) {
  const projectFiles = collectProjectFiles(root);
  /** @type {Map<string, {id: string, dir: string, refs: string[], kind: "b"|"p"}>} */
  const graph = new Map();
  for (const file of projectFiles) {
    const id = toPosix(relative(root, file));
    if (exclude?.has(id)) continue;
    const dir = toPosix(relative(root, resolve(file, "..")));
    const kind = isPModeProject(id) ? "p" : "b";
    const refs = parseTsconfigReferences(readFileSync(file, "utf8"))
      .map((refPath) => resolveReferenceId(root, resolve(file, ".."), refPath))
      .filter(Boolean)
      .sort();
    graph.set(id, { id, dir, refs, kind });
  }
  return graph;
}

const P_MODE_PROJECTS = new Set([
  "packages/zcode-cua/tsconfig.json",
  "packages/desktop/tsconfig.remote-main.json",
]);

/**
 * 根 `pnpm typecheck` 有意只覆盖 desktop 的 main/host/e2e（外加 remote-main 与
 * zcode-cua 的 -p 形态）：renderer/preload/scheduler 在上游基线上本就存在类型
 * 报错（Window.zcode 全局声明、rootDir 越界等）。dev:check 的裁决面与根脚本对齐，
 * 不扩大 —— 否则任何 desktop 相邻改动都会让 dev:gate 永久红。
 */
export const ROOT_TYPECHECK_EXCLUDED_PROJECTS = new Set([
  "packages/desktop/tsconfig.json",
  "packages/desktop/tsconfig.scheduler.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.renderer.json",
]);

function isPModeProject(id) {
  return P_MODE_PROJECTS.has(id);
}

function collectProjectFiles(root) {
  const files = [];
  const packagesDir = resolve(root, "packages");
  const packages = readdirSafe(packagesDir);
  for (const name of packages) {
    const packageDir = resolve(packagesDir, name);
    const main = resolve(packageDir, "tsconfig.json");
    if (existsSync(main)) files.push(main);
    if (name === "desktop") {
      for (const entry of readdirSafe(packageDir)) {
        if (/^tsconfig\..+\.json$/u.test(entry)) {
          const sub = resolve(packageDir, entry);
          if (existsSync(sub)) files.push(sub);
        }
      }
    }
    if (name === "shared") {
      const testing = resolve(packageDir, "tsconfig.testing.json");
      if (existsSync(testing)) files.push(testing);
    }
  }
  const devDocs = resolve(root, "apps", "dev-docs", "tsconfig.json");
  if (existsSync(devDocs)) files.push(devDocs);
  return files;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 改动包拥有的项目（desktop 目录拥有其全部子工程）。 */
export function ownerProjectIds(graph, changedDirs) {
  const owners = [];
  for (const project of graph.values()) {
    if (changedDirs.has(project.dir)) owners.push(project.id);
  }
  return owners.sort();
}

/** 反向依赖闭包：seed 及所有（传递）依赖它们的兄弟项目。 */
export function reverseDependentClosure(graph, seedIds) {
  const dependents = new Map();
  for (const project of graph.values()) {
    for (const ref of project.refs) {
      if (!dependents.has(ref)) dependents.set(ref, new Set());
      dependents.get(ref).add(project.id);
    }
  }
  const closure = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const dependent of dependents.get(current) ?? []) {
      if (closure.has(dependent)) continue;
      closure.add(dependent);
      queue.push(dependent);
    }
  }
  return closure;
}

/**
 * 计算要检查的项目集合。
 * - scope "direct"：只查改动包拥有的项目；
 * - scope "affected"（默认）：直接集 ∪ 反向依赖闭包；
 * 若直接集同时包含聚合工程（packages/desktop/tsconfig.json）与其引用的子工程，
 * 聚合 `tsc -b` 已覆盖子工程，去重只保留聚合（p 模式工程不参与聚合，始终保留）。
 */
export function affectedProjectIds(graph, changedDirs, { scope = "affected" } = {}) {
  const direct = ownerProjectIds(graph, changedDirs);
  if (direct.length === 0) return [];
  if (scope === "direct") return direct;

  const closure = reverseDependentClosure(graph, direct);
  const coveredByAggregate = new Set();
  for (const id of closure) {
    const project = graph.get(id);
    if (project?.kind !== "b") continue;
    for (const ref of project.refs) {
      if (closure.has(ref)) coveredByAggregate.add(ref);
    }
  }
  return [...closure]
    .filter((id) => graph.get(id)?.kind === "p" || !coveredByAggregate.has(id))
    .sort();
}

/** 改动文件 → 改动目录集合（无法归属 workspace 的文件忽略）。 */
export function changedDirsOfFiles(files) {
  const dirs = new Set();
  for (const file of files) {
    const dir = packageDirOf(file);
    if (dir) dirs.add(dir);
  }
  return dirs;
}
