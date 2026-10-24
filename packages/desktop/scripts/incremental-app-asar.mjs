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
  const targetPlatformKey = `${normalizedOs}-${arch}`;
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
  cpSync(resolve(desktopRoot, "package.json"), resolve(appDir, "package.json"));

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
