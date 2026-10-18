#!/usr/bin/env node
/**
 * 强相关测试选择：把「改动的源码」映射到「必须跑的测试」，不做传递展开。
 *
 * 三条依据（并集）：
 * 1. 改动集里本身就是测试的文件 —— 直接跑；
 * 2. 测试文件**直接 import** 了改动源码 —— 解析 import/require/动态 import 的说明符，
 *    支持相对路径、@/、@desktop/、@web/、@zcode/*（含 exports 子路径）、Node `#src/*`，
 *    以及 nodenext 风格的 `.js` → `.ts` 回退；
 * 3. 同 package 内文件名（词序列）相同或互为前后缀 —— 覆盖 `x.ts` ↔ `x.test.ts`、
 *    `appLaunchCoordinator.ts` ↔ `app-launch-coordinator.test.ts` 这类约定。
 *
 * 刻意不做 vitest `related` 式的传递闭包：共享 barrel 会把选择集放大到近全仓，
 * 这正是推送门禁慢的根因。改动的源码若没有任何测试命中，会在报告里逐条列出。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";

import { spawnSync } from "node:child_process";

const STATIC_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^"'()]*?\bfrom\s*)?["']([^"']+)["']/gu;
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/gu;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

const CODE_SOURCE_RE = /\.(?:ts|tsx|js|mjs|cjs)$/u;
const DECLARATION_RE = /\.d\.ts$/u;
const VITEST_TEST_GLOBS = [
  ":(glob)packages/*/test/**/*.test.ts",
  ":(glob)packages/*/src/**/contract.test.ts",
  ":(glob)packages/services/src/gen-ui/**/*.test.ts",
  "packages/shared/src/node/genUiPaths.test.ts",
  "scripts/assert-safe-cua-helper-zip.test.mjs",
];
const ALIASES = [
  ["@/", "packages/ui/src/"],
  ["@desktop/", "packages/desktop/src/"],
  ["@web/", "packages/web/src/"],
];
const E2E_PREFIX = "packages/desktop/test/e2e/";
const NODE_TEST_MARKER = 'from "node:test"';

export function toPosix(value) {
  return value.split("\\").join("/");
}

export function isE2ETestPath(relPath) {
  return relPath.startsWith(E2E_PREFIX);
}

export function isTestPath(relPath) {
  if (isE2ETestPath(relPath)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/u.test(relPath)) return true;
  return /^packages\/[^/]+\/src\/.*\/contract\.test\.ts$/u.test(relPath);
}

export function isCodeSourcePath(relPath) {
  if (isE2ETestPath(relPath)) return false;
  if (isTestPath(relPath)) return false;
  if (DECLARATION_RE.test(relPath)) return false;
  return CODE_SOURCE_RE.test(relPath);
}

/** 测试文件所属的 workspace 目录（packages/x 或 apps/zcode-cli/packages/x）。 */
export function packageRootOf(relPath) {
  const parts = relPath.split("/");
  if (parts[0] === "packages" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "apps" && parts[1] === "zcode-cli" && parts[2] === "packages") {
    return `${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`;
  }
  return undefined;
}

/** 文件名 → 小写词序列（camelCase / kebab-case / snake_case 归一）。 */
export function stemWords(file) {
  const name = basename(file)
    .replace(/\.(?:test|spec)\.[^.]+$/u, "")
    .replace(/\.[^.]+$/u, "");
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function canonicalStem(file) {
  return stemWords(file).join("");
}

/** 两个文件名是否强相关：完全相同，或较短者是较长者的前缀/后缀（较短者需 ≥12 字符）。 */
export function stemsRelated(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short.length >= 12 && (long.startsWith(short) || long.endsWith(short));
}

export function extractImportSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT_RE, EXPORT_FROM_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function listWorkspaceDirs(root, baseDir, prefix) {
  const full = join(root, baseDir);
  if (!existsSync(full)) return [];
  const dirs = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const dir = `${prefix}${entry.name}`;
    if (existsSync(join(root, dir, "package.json"))) dirs.push(dir);
  }
  return dirs;
}

function listPackageDirs(root) {
  return [
    ...listWorkspaceDirs(root, "packages", "packages/"),
    ...listWorkspaceDirs(root, "apps/zcode-cli/packages", "apps/zcode-cli/packages/"),
  ];
}

/**
 * workspace 包索引：name → 目录、exports、imports、依赖名。
 */
export function buildRepoIndex(root) {
  const packages = [];
  const byName = new Map();
  const byDir = new Map();
  for (const dir of listPackageDirs(root)) {
    const manifest = readJson(join(root, dir, "package.json"));
    if (!manifest?.name) continue;
    const entry = {
      dir,
      name: manifest.name,
      exports: manifest.exports,
      imports: manifest.imports,
      main: manifest.main,
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      }),
    };
    packages.push(entry);
    byName.set(entry.name, entry);
    byDir.set(entry.dir, entry);
  }
  return { root, packages, byName, byDir };
}

function normalizeRelative(value) {
  return toPosix(posix.normalize(value)).replace(/^\.\//u, "");
}

/**
 * 同一源文件的路径变体：相对 import 常写 `.js`，实际文件是 `.ts`；
 * 无扩展名的 import 还要尝试 `.ts` / `index.ts`。解析不依赖文件是否存在，
 * 这样「本次推送删除了源文件」时仍能把 import 它的测试选出来。
 */
export function comparablePaths(relPath) {
  const paths = new Set([relPath]);
  const scriptExtension = relPath.match(/\.(?:js|jsx|mjs|cjs)$/u);
  if (scriptExtension) {
    const base = relPath.slice(0, -scriptExtension[0].length);
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) paths.add(`${base}${extension}`);
  } else if (!/\.[A-Za-z0-9]+$/u.test(posix.basename(relPath))) {
    for (const extension of [".ts", ".tsx"]) paths.add(`${relPath}${extension}`);
    paths.add(`${relPath}/index.ts`);
    paths.add(`${relPath}/index.tsx`);
  }
  return paths;
}

function resolveExportValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["import", "node", "default", "require"]) {
    const resolved = resolveExportValue(value[key]);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolvePackageSubpath(entry, subpath) {
  const exportsField = entry.exports;
  if (exportsField && typeof exportsField === "object") {
    const direct = resolveExportValue(exportsField[subpath]);
    if (direct) return posix.join(entry.dir, direct);
    for (const [key, value] of Object.entries(exportsField)) {
      if (!key.includes("*")) continue;
      const [prefix, suffix] = key.split("*");
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix ?? "")) continue;
      const star = subpath.slice(prefix.length, subpath.length - (suffix ?? "").length);
      const target = resolveExportValue(value);
      if (target) return posix.join(entry.dir, target.replace("*", star));
    }
  }
  if (subpath === ".") {
    if (entry.main) return posix.join(entry.dir, entry.main);
    return posix.join(entry.dir, "src", "index.ts");
  }
  return posix.join(entry.dir, subpath.slice(2));
}

function workspaceTarget(byName, specifier) {
  const names = [...byName.keys()].sort((left, right) => right.length - left.length);
  for (const name of names) {
    if (specifier === name) return { entry: byName.get(name), subpath: "." };
    if (specifier.startsWith(`${name}/`)) {
      return { entry: byName.get(name), subpath: `./${specifier.slice(name.length + 1)}` };
    }
  }
  return undefined;
}

function resolveNodeImport(entry, specifier) {
  const importsField = entry?.imports;
  if (!importsField) return undefined;
  const direct = resolveExportValue(importsField[specifier]);
  if (direct) return posix.join(entry.dir, direct);
  for (const [key, value] of Object.entries(importsField)) {
    if (!key.includes("*")) continue;
    const [prefix, suffix] = key.split("*");
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix ?? "")) continue;
    const star = specifier.slice(prefix.length, specifier.length - (suffix ?? "").length);
    const target = resolveExportValue(value);
    if (target) return posix.join(entry.dir, target.replace("*", star));
  }
  return undefined;
}

function closestPackageFor(index, fromRel) {
  const packageRoot = packageRootOf(fromRel);
  return packageRoot ? index.byDir.get(packageRoot) : undefined;
}

/**
 * 把 import 说明符解析成仓库内相对路径（posix）。无法解析时返回 undefined。
 * 结果按 fromDir + specifier 缓存。
 */
export function resolveSpecifier(index, fromRel, specifier, cache = new Map()) {
  const clean = specifier.split("?")[0];
  if (!clean) return undefined;
  const cacheKey = `${posix.dirname(fromRel)}|${clean}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let candidate;
  const alias = ALIASES.find(([prefix]) => clean.startsWith(prefix));
  if (clean.startsWith(".")) {
    candidate = normalizeRelative(posix.join(posix.dirname(fromRel), clean));
  } else if (alias) {
    candidate = normalizeRelative(posix.join(alias[1], clean.slice(alias[0].length)));
  } else if (clean.startsWith("#")) {
    candidate = resolveNodeImport(closestPackageFor(index, fromRel), clean);
  } else {
    const workspace = workspaceTarget(index.byName, clean);
    candidate = workspace ? resolvePackageSubpath(workspace.entry, workspace.subpath) : undefined;
  }

  const resolved = candidate ? normalizeRelative(candidate) : undefined;
  cache.set(cacheKey, resolved);
  return resolved;
}

function gitLsFiles(cwd, pathspecs) {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ls-files 失败：${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").split("\0").filter(Boolean).map(toPosix);
}

/**
 * 收集候选测试（已跟踪）。读取内容一次，同时区分 vitest 与 fork node:test 文件。
 * @returns {{path: string, content: string, runner: "vitest" | "node" }[]}
 */
export function listCandidateTests({ cwd, root }) {
  const files = [...new Set(gitLsFiles(cwd, VITEST_TEST_GLOBS))].filter(
    (file) => !isE2ETestPath(file),
  );
  const candidates = [];
  for (const path of files) {
    let content;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    candidates.push({
      path,
      content,
      runner: content.includes(NODE_TEST_MARKER) ? "node" : "vitest",
    });
  }
  return candidates;
}

/**
 * 选择强相关测试。
 *
 * 「枢纽文件」处理：被超过 hubThreshold 个测试直接 import 的文件（常是 index.ts
 * barrel 或 i18n 资源）如果按 import 归因会把选择集放大到近全仓。对这类文件：
 * - 变更只新增行 → 不做 import 归因（真正的改动在它 re-export 的目标模块里，
 *   那些模块自己的 import 者仍会被选中），并在报告里列出；
 * - 变更含删除行 → 返回 full（删导出可能让所有 import 者断裂，必须跑全量）。
 *
 * @returns {{full: boolean, selected: string[], vitest: string[], node: string[],
 *   uncovered: string[], changedTests: string[], hubSkipped: {source: string, importers: number}[],
 *   escalations: {source: string, importers: number}[], scanned: number}}
 */
export function selectRelatedTests({
  index,
  changedFiles = [],
  deletedFiles = [],
  candidates = [],
  scope = "strong",
  hubThreshold = 100,
  additionsOnlySources = [],
}) {
  const changed = changedFiles.map(toPosix);
  const deleted = deletedFiles.map(toPosix);
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const changedTests = changed.filter((file) => isTestPath(file));
  const sources = [...changed, ...deleted].filter((file) => isCodeSourcePath(file));

  if (scope === "full") {
    return {
      full: true,
      selected: candidates.map((candidate) => candidate.path).sort(),
      vitest: candidates
        .filter((c) => c.runner === "vitest")
        .map((c) => c.path)
        .sort(),
      node: candidates
        .filter((c) => c.runner === "node")
        .map((c) => c.path)
        .sort(),
      uncovered: [],
      changedTests: changedTests.sort(),
      hubSkipped: [],
      escalations: [],
      scanned: candidates.length,
    };
  }

  const sourceSet = new Set(sources);
  const cache = new Map();
  /** @type {Map<string, Set<string>>} 改动源码 → 直接 import 它的测试 */
  const importers = new Map();

  for (const candidate of candidates) {
    const targets = new Set();
    for (const specifier of extractImportSpecifiers(candidate.content)) {
      const resolved = resolveSpecifier(index, candidate.path, specifier, cache);
      if (!resolved) continue;
      if (sourceSet.has(resolved)) {
        targets.add(resolved);
      } else {
        const variant = [...comparablePaths(resolved)].find((path) => sourceSet.has(path));
        if (variant) targets.add(variant);
      }
    }
    for (const target of targets) {
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(candidate.path);
    }
  }

  const additionsOnly = new Set(additionsOnlySources.map(toPosix));
  const hubs = sources
    .map((source) => ({ source, importers: importers.get(source)?.size ?? 0 }))
    .filter((entry) => entry.importers > hubThreshold);
  const hubSkipped = hubs.filter((entry) => additionsOnly.has(entry.source));
  const escalations = hubs.filter((entry) => !additionsOnly.has(entry.source));
  if (escalations.length > 0) {
    return {
      full: true,
      selected: candidates.map((candidate) => candidate.path).sort(),
      vitest: candidates
        .filter((c) => c.runner === "vitest")
        .map((c) => c.path)
        .sort(),
      node: candidates
        .filter((c) => c.runner === "node")
        .map((c) => c.path)
        .sort(),
      uncovered: [],
      changedTests: changedTests.sort(),
      hubSkipped: [],
      escalations,
      scanned: candidates.length,
    };
  }
  const skippedSources = new Set(hubSkipped.map((entry) => entry.source));

  const selected = new Set(changedTests.filter((file) => byPath.has(file)));
  const attributed = new Set();
  for (const [source, tests] of importers) {
    if (skippedSources.has(source)) continue;
    for (const test of tests) {
      selected.add(test);
      attributed.add(source);
    }
  }

  const sourcesByPackage = new Map();
  for (const source of sources) {
    const packageRoot = packageRootOf(source);
    if (!packageRoot) continue;
    if (!sourcesByPackage.has(packageRoot)) sourcesByPackage.set(packageRoot, []);
    sourcesByPackage.get(packageRoot).push(source);
  }
  const stemsByPackage = new Map();
  for (const [packageRoot, packageSources] of sourcesByPackage) {
    stemsByPackage.set(
      packageRoot,
      packageSources.map((source) => ({ source, stem: canonicalStem(source) })),
    );
  }
  for (const candidate of candidates) {
    const packageRoot = packageRootOf(candidate.path);
    const entries = packageRoot ? stemsByPackage.get(packageRoot) : undefined;
    if (!entries) continue;
    const candidateStem = canonicalStem(candidate.path);
    for (const entry of entries) {
      if (!stemsRelated(candidateStem, entry.stem)) continue;
      selected.add(candidate.path);
      attributed.add(entry.source);
    }
  }

  if (scope === "package") {
    const packages = new Set(sources.map(packageRootOf).filter(Boolean));
    for (const candidate of candidates) {
      if (packages.has(packageRootOf(candidate.path))) selected.add(candidate.path);
    }
  }

  const selectedPaths = [...selected].sort();
  return {
    full: false,
    selected: selectedPaths,
    vitest: selectedPaths.filter((path) => byPath.get(path)?.runner !== "node"),
    node: selectedPaths.filter((path) => byPath.get(path)?.runner === "node"),
    uncovered: sources
      .filter((source) => !attributed.has(source) && !skippedSources.has(source))
      .sort(),
    changedTests: changedTests.sort(),
    hubSkipped,
    escalations: [],
    scanned: candidates.length,
  };
}
