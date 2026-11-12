import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runCommand } from "../../../scripts/spawn-command.mjs";
import { replaceAppAsarFromStaging } from "./app-asar-repack.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import { createPackagedPackageJson } from "./packaging-app-metadata.mjs";
import {
  collectPackagingRuntimeModules,
  createRuntimeModuleLookupRoots,
  materializeRuntimeModules,
} from "./packaging-runtime-modules.mjs";
import {
  removeSourceMapFilesInDirectory,
  stripSourceMappingUrlCommentsInDirectory,
} from "./packaged-sourcemap-cleanup.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const APP_OUT_DIR_NAMES = {
  win32: "win-unpacked",
  linux: "linux-unpacked",
};

// bundle.mjs 用 "win"/"mac" 作为目标别名，electron-builder 与 node-pty 的
// platform key 用 "win32"/"darwin"，这里统一收敛一次。
const TARGET_OS_ALIASES = {
  win: "win32",
  win32: "win32",
  windows: "win32",
  mac: "darwin",
  macos: "darwin",
  darwin: "darwin",
  linux: "linux",
};

function normalizeTargetOs(targetOs) {
  const normalized = TARGET_OS_ALIASES[String(targetOs).toLowerCase()];
  if (!normalized) {
    throw new Error(`增量打包不支持目标平台: ${targetOs}`);
  }
  return normalized;
}

const requireFromScript = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(requireFromScript.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);

function asarSignature(filePath) {
  const stat = statSync(filePath);
  return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** 增量基线标记文件路径（staging 根下的 baseline.json）。 */
export function resolveIncrementalBaselinePath(desktopRoot) {
  return resolve(desktopRoot, ".cache", "incremental-app", "baseline.json");
}

/**
 * 基线里的 `targetPlatformKey`（`win32-x64` / `darwin-arm64`）。
 *
 * 导出给完整打包路径复用：平台别名归一（`win` → `win32`、`mac` → `darwin`）
 * 必须只有一份实现，否则两条路径会写出不同的 key，`canReuseStaging` 的相等
 * 判断永远不成立（实测踩过：完整打包写成 `win-x64`，增量读的却是 `win32-x64`，
 * 于是每次增量都在重新解包 455MB 的 asar）。
 */
export function resolveIncrementalPlatformKey({ targetOs, arch }) {
  return `${normalizeTargetOs(targetOs)}-${arch}`;
}

/**
 * 写入增量基线标记。
 *
 * 单独导出的理由：**完整打包也必须写它**。以前只有增量路径更新 baseline，
 * 于是形成死锁——`pnpm-lock.yaml` 一变就要求「先完整打包一次」，而完整打包
 * 又不刷新基线，下次仍判定 lock 比基线新，永远只能走全量（实测：本机基线
 * 停在 2026-10-29，之后每次出包都是约 40 分钟的全量）。
 *
 * 语义：`packedAt` = 「这个 app.asar 是哪一刻用当时依赖打出来的」。任何一条
 * 产出 app.asar 的路径都必须更新它，否则依赖新鲜度的判据本身就是错的。
 */
export function writeIncrementalBaseline({ desktopRoot, appAsarPath, targetPlatformKey }) {
  const markerPath = resolveIncrementalBaselinePath(desktopRoot);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify(
      {
        packedAt: Date.now(),
        targetPlatformKey,
        appAsar: asarSignature(appAsarPath),
      },
      null,
      2,
    )}\n`,
  );
  return markerPath;
}

/**
 * 定位打包产物里的 app 资源目录。
 * Windows/Linux 是 `<dist>/<platform>-unpacked/resources`，macOS 在 .app bundle 内。
 */
export function resolvePackagedResourcesDir({ distRoot, targetOs }) {
  const normalizedOs = normalizeTargetOs(targetOs);
  if (normalizedOs === "darwin") {
    const { productName } = resolveDesktopProductIdentity();
    return resolve(distRoot, `${productName}.app`, "Contents", "Resources");
  }
  return resolve(distRoot, APP_OUT_DIR_NAMES[normalizedOs], "resources");
}

/**
 * 增量刷新已解包产物里的 app.asar。
 *
 * 完整打包的耗时几乎全在把 1.2 GB 的 Electron 运行时 + node_modules 从 workspace
 * 复制到 dist，而 renderer/main 每次改动只会影响 `out/**`。这里复用上一次产物里的
 * app.asar 作为基线（首次会解包缓存），只替换 `out/**` 与闭包依赖，再重新打包 asar。
 *
 * 前提：基线产物已经存在且依赖未变化。node_modules 不重新解析——`pnpm-lock.yaml`
 * 比上次基线新时直接拒绝，要求走完整打包，避免增量包带着旧依赖发出去。
 */
export async function refreshPackagedAppAsar({
  desktopRoot,
  distRoot,
  targetOs,
  arch,
  logger = console,
}) {
  const normalizedOs = normalizeTargetOs(targetOs);
  const targetPlatformKey = resolveIncrementalPlatformKey({ targetOs: normalizedOs, arch });
  const resourcesDir = resolvePackagedResourcesDir({ distRoot, targetOs: normalizedOs });
  const appAsarPath = resolve(resourcesDir, "app.asar");
  if (!existsSync(appAsarPath)) {
    throw new Error(`未找到基线产物 ${appAsarPath}；增量打包需要先完整执行一次 --dir 打包`);
  }

  const sourceOutDir = resolve(desktopRoot, "out");
  if (!existsSync(sourceOutDir)) {
    throw new Error(`未找到构建产物 ${sourceOutDir}；请先构建主进程/渲染层`);
  }

  const stagingRoot = resolve(desktopRoot, ".cache", "incremental-app");
  const appDir = resolve(stagingRoot, "app");
  const markerPath = resolve(stagingRoot, "baseline.json");
  const baseline = readJson(markerPath);
  const current = asarSignature(appAsarPath);
  const canReuseStaging =
    Boolean(baseline) &&
    baseline.targetPlatformKey === targetPlatformKey &&
    baseline.appAsar?.size === current.size &&
    baseline.appAsar?.mtimeMs === current.mtimeMs &&
    existsSync(resolve(appDir, "package.json")) &&
    existsSync(resolve(appDir, "out"));

  const lockfilePath = resolve(desktopRoot, "..", "..", "pnpm-lock.yaml");
  if (baseline?.packedAt && existsSync(lockfilePath)) {
    const lockfileMtimeMs = statSync(lockfilePath).mtimeMs;
    if (lockfileMtimeMs > baseline.packedAt) {
      throw new Error(
        "pnpm-lock.yaml 自上次打包后有变化，增量打包不会重新解析依赖；请先完整执行一次打包",
      );
    }
  }

  if (canReuseStaging) {
    logger.log("[incremental] 复用已解包的 app 基线");
  } else {
    logger.log("[incremental] 解包 app.asar 建立基线（首次或产物已变更）");
    rmSync(appDir, { force: true, recursive: true });
    mkdirSync(appDir, { recursive: true });
    runCommand(process.execPath, [asarCliPath, "extract", appAsarPath, appDir], {
      cwd: desktopRoot,
      env: process.env,
    });
  }

  logger.log("[incremental] 刷新 out/ 与 package.json");
  rmSync(resolve(appDir, "out"), { force: true, recursive: true });
  cpSync(sourceOutDir, resolve(appDir, "out"), { recursive: true });
  // 不能直接 copy 源 package.json：它没有 version，运行时靠 electron-builder 的
  // extraMetadata 注入。缺了它 app.getVersion() 会退化到 exe 的四段文件版本。
  const sourcePackageJson = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8"));
  writeFileSync(
    resolve(appDir, "package.json"),
    `${JSON.stringify(createPackagedPackageJson(sourcePackageJson), null, 2)}\n`,
  );

  const lookupRoots = createRuntimeModuleLookupRoots({
    desktopRoot,
    workspaceRoot: resolve(desktopRoot, "..", ".."),
  });
  logger.log("[incremental] 补齐运行时闭包依赖");
  materializeRuntimeModules({
    stagingDir: resolve(appDir, "node_modules"),
    entries: collectPackagingRuntimeModules(lookupRoots),
  });

  const stripSummary = stripSourceMappingUrlCommentsInDirectory(appDir);
  const mapSummary = removeSourceMapFilesInDirectory(appDir);
  logger.log(
    `[incremental] sourcemap 清理 references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved}`,
  );

  logger.log("[incremental] 重新打包 app.asar");
  await replaceAppAsarFromStaging({
    sourceDir: appDir,
    appAsarPath,
    targetPlatformKey,
    runAsarCommand: (args) => {
      runCommand(process.execPath, [asarCliPath, ...args], {
        cwd: desktopRoot,
        env: process.env,
      });
    },
  });

  // 与完整打包路径共用同一份写基线逻辑（见 writeIncrementalBaseline 的注释：
  // 两条产出 app.asar 的路径都必须更新它，否则依赖新鲜度判据会失准）。
  writeIncrementalBaseline({ desktopRoot, appAsarPath, targetPlatformKey });

  logger.log(`[incremental] 完成: ${appAsarPath}`);
  return { appAsarPath, resourcesDir };
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  const desktopRoot = resolve(import.meta.dirname, "..");
  const distDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
  const targetPlatform = getTargetPlatform();
  try {
    await refreshPackagedAppAsar({
      desktopRoot,
      distRoot: resolve(desktopRoot, distDir),
      targetOs: targetPlatform.os,
      arch: targetPlatform.arch,
    });
  } catch (error) {
    console.error(`[incremental] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
