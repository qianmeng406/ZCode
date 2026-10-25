#!/usr/bin/env node
/**
 * dev:package —— 开发期出包入口：把「这次改动」打成 dist-preview-perf 的
 * ZCode Preview，消灭手拼环境变量，并按边界决定做多少：
 *
 * - 增量路径（默认）：out/ 新鲜时跳过全量 JS 构建，直接重打 app.asar
 *   （refreshPackagedAppAsar：复用 Electron runtime/unpacked 目录，只刷 out/**）；
 * - 完整路径（--full）：走 bundle.mjs 完整 electron-builder --dir，覆盖增量
 *   asar 不刷新的资源层（desktop config/scripts/resources、CLI agent bundle）；
 * - 无需出包（改动仅文档/测试/无关包）时直接跳过并说明。
 *
 * 内置 Preview 基线（与既有打包约束一致，见 docs/dev-loop.md）：
 *   ZCODE_ENV=production、ZCODE_PREVIEW_IDENTITY=1、
 *   ZCODE_DESKTOP_DIST_DIR=dist-preview-perf（--dist 可覆盖）、win/x64。
 *
 * 用法：pnpm dev:package [--full] [--force-build] [--dist <dir>] [--os <os>] [--arch <arch>]
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  WATCHED_SRC_DIRS,
  classifyDesktopImpact,
  isWatchedSrcPath,
  resolveChangedFiles,
} from "./scope.mjs";

function parseArgs(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    full: argv.includes("--full"),
    forceBuild: argv.includes("--force-build"),
    dist: option("--dist") ?? "dist-preview-perf",
    os: option("--os") ?? "win",
    arch: option("--arch") ?? "x64",
  };
}

function elapsedLabel(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

/** Windows 下 spawn .cmd 必须经 cmd.exe（Node 对 .cmd 直 spawn 抛 EINVAL）。 */
function runPnpm(cwd, args, label) {
  const startedAt = Date.now();
  const command = `pnpm ${args.join(" ")}`;
  const result =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", command], { cwd, stdio: "inherit" })
      : spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`[dev-loop] ${label} 启动失败：${result.error.message}`);
    return 1;
  }
  console.log(`[dev-loop] ${label} 完成（${elapsedLabel(startedAt)}，exit ${result.status ?? 1}）`);
  return result.status ?? 1;
}

/** app.asar 被 ZCode Preview 占用时 openSync("r+") 会失败——比 ACL 检查可靠。 */
function assertAsarWritable(appAsarPath) {
  try {
    const fd = openSync(appAsarPath, "r+");
    closeSync(fd);
    return true;
  } catch (error) {
    console.error(`[dev-loop] app.asar 不可写（${error.code ?? error.message}）。`);
    console.error("[dev-loop] 请先完全退出 ZCode Preview，再重新执行 pnpm dev:package。");
    return false;
  }
}

/**
 * r+ 探测在 Preview 运行中时会假阴性（Windows 允许共享写打开，真正的失败在
 * 重打包的原子替换阶段）。用 tasklist 做进程级预检，提前给出明确指引。
 */
export function isPreviewRunning() {
  if (process.platform !== "win32") return false;
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq ZCode Preview.exe", "/NH"], {
    encoding: "utf8",
  });
  const output = result.stdout ?? "";
  return output.includes("ZCode Preview.exe");
}

const BUILD_STAMP_RELATIVE = ["out", ".build-stamp"];

function readBuildStampMs(desktopRoot) {
  const stampPath = resolve(desktopRoot, ...BUILD_STAMP_RELATIVE);
  if (!existsSync(stampPath)) return undefined;
  try {
    return Number(readFileSync(stampPath, "utf8").trim());
  } catch {
    return undefined;
  }
}

function writeBuildStamp(desktopRoot) {
  const stampPath = resolve(desktopRoot, ...BUILD_STAMP_RELATIVE);
  writeFileSync(stampPath, `${Date.now()}\n`);
}

function hasNewerThan(root, dirRelative, stampMs) {
  const absolute = resolve(root, dirRelative);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const child = join(dirRelative, entry.name);
    if (entry.isDirectory()) {
      if (hasNewerThan(root, child, stampMs)) return true;
    } else {
      try {
        if (statSync(resolve(root, child)).mtimeMs > stampMs) return true;
      } catch {
        /* 文件可能刚被删除，忽略 */
      }
    }
  }
  return false;
}

/**
 * out/ 是否过期：
 * - 有 scopeReport（dev:gate 链式）→ 精确判定：本次触及的 watched src 中有比
 *   构建戳新的文件（同一次改动重复运行不会重复构建；已删除的源文件算过期，
 *   其编译产物仍留在 out/）；
 * - 独立运行 → 早退遍历 watched src 找比 stamp 新的文件。
 */
function isOutStale(root, stampMs, scopeReport) {
  if (scopeReport) {
    const touched = [...scopeReport.changed, ...scopeReport.deleted].filter(isWatchedSrcPath);
    return touched.some((file) => {
      try {
        return statSync(resolve(root, file)).mtimeMs > stampMs;
      } catch {
        return true;
      }
    });
  }
  for (const dir of WATCHED_SRC_DIRS) {
    if (hasNewerThan(root, dir, stampMs)) return true;
  }
  return false;
}

/**
 * 执行出包。返回进程退出码。scopeReport 由 dev:gate 传入时用于边界判定与
 * 精确的新鲜度判断；独立运行时自行解析 worktree 范围做同一套判定。
 */
export async function runPackage(argv = process.argv.slice(2), { scopeReport } = {}) {
  const root = process.cwd();
  const options = parseArgs(argv);

  // 独立运行（不经 dev:gate）也解析 worktree 范围，保证同样的出包边界；
  // 解析失败（如非 git 环境）时按无范围信息处理（不跳过、不拦截）。
  let standaloneImpact;
  let standaloneLabel;
  if (!scopeReport) {
    try {
      const range = resolveChangedFiles({ cwd: root });
      standaloneLabel = range.label;
      standaloneImpact = classifyDesktopImpact([...range.changed, ...range.deleted]);
    } catch {
      /* 无范围信息：退回纯构建/重打路径 */
    }
  }
  const impact = scopeReport?.impact ?? standaloneImpact;
  const label = scopeReport?.label ?? standaloneLabel;

  // 资源层 / CLI agent bundle（prepare:runtime-assets 产物）不在增量 asar 的
  // 覆盖面内：继续走增量会「成功」地产出一个不含这些改动的包。直接失败，
  // 明确要求 --full，绝不静默成功。
  if (impact?.mode === "full" && !options.full) {
    const blockers = [...impact.full, ...impact.cli];
    console.error(
      `[dev-loop] ${label ?? "当前范围"} 含增量 asar 不覆盖的改动 ${blockers.length} 个：`,
    );
    for (const file of impact.full) console.error(`  ! ${file}`);
    for (const file of impact.cli) console.error(`  ! ${file}（CLI agent bundle 层）`);
    console.error(
      "[dev-loop] 请改用完整打包：pnpm dev:package --full（链式：pnpm dev:gate --full）。",
    );
    return 1;
  }

  // 必须在动态 import bundle.mjs 之前设好：bundle.mjs 在模块加载期读取这些
  // 环境变量解析产品身份（ZCode Preview / dist 目录）。外部 ZCODE_ENV 一律以
  // Preview 基线为准——test 会打进 zcode-builtin.test.json 测试渠道配置。
  if (process.env.ZCODE_ENV && process.env.ZCODE_ENV !== "production") {
    console.warn(
      `[dev-loop] 忽略外部 ZCODE_ENV=${process.env.ZCODE_ENV}；dev:package 固定 production（Preview 基线）。`,
    );
  }
  process.env.ZCODE_ENV = "production";
  process.env.ZCODE_PREVIEW_IDENTITY = "1";
  process.env.ZCODE_DESKTOP_DIST_DIR = options.dist;

  const desktopRoot = resolve(root, "packages", "desktop");
  const distRoot = resolve(desktopRoot, options.dist);
  const unpackedDirName = options.os === "win" ? "win-unpacked" : `${options.os}-unpacked`;
  const resourcesDir = resolve(distRoot, unpackedDirName, "resources");
  const appAsarPath = resolve(resourcesDir, "app.asar");

  if (options.full) {
    console.log(
      `[dev-loop] 完整打包：electron-builder --dir → ${options.dist}（覆盖资源层；耗时较长）`,
    );
    const args = [
      join(desktopRoot, "scripts", "bundle.mjs"),
      "--os",
      options.os,
      "--arch",
      options.arch,
      "--dir",
    ];
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.error) {
      console.error(`[dev-loop] bundle.mjs 启动失败：${result.error.message}`);
      return 1;
    }
    writeBuildStamp(desktopRoot);
    return result.status ?? 1;
  }

  if (!existsSync(appAsarPath)) {
    console.error(`[dev-loop] 未找到基线产物 ${appAsarPath}。`);
    console.error("[dev-loop] 需要先完整打包一次：pnpm dev:package --full");
    return 1;
  }

  const stampMs = readBuildStampMs(desktopRoot);
  const stale =
    options.forceBuild || stampMs === undefined || isOutStale(root, stampMs, scopeReport);

  // 仅文档/测试/无关包的改动：产物不会变，跳过（--full / --force-build 是显式
  // 覆盖）。链式（gate）直接跳过；独立运行时还要求 out/ 新鲜——过期（如
  // pull / 切换提交后）则继续走重建，避免静默产出旧内容的包。
  if (impact?.mode === "none" && !options.full && !options.forceBuild) {
    if (scopeReport || !stale) {
      console.log(
        `[dev-loop] 出包：跳过（${label ?? "当前范围"} 不触及桌面产物源码：仅文档/测试/无关包的改动${
          scopeReport ? "" : "，且 out/ 新鲜"
        }）。`,
      );
      if (!scopeReport) {
        console.log("[dev-loop] 需要强制重打时：pnpm dev:package --force-build。");
      }
      return 0;
    }
    console.log(
      "[dev-loop] 改动不触及桌面产物源码，但 out/ 过期（可能拉取/切换了提交）：继续重建出包。",
    );
  }

  if (isPreviewRunning()) {
    console.error("[dev-loop] 检测到 ZCode Preview 正在运行；app.asar 重打包会与之冲突。");
    console.error("[dev-loop] 请先完全退出 ZCode Preview（完成验证后），再执行 pnpm dev:package。");
    return 1;
  }
  if (!assertAsarWritable(appAsarPath)) return 1;

  if (stale) {
    const reason = options.forceBuild
      ? "--force-build"
      : stampMs === undefined
        ? "没有构建戳（首次运行或 out/ 被清理）"
        : "watched src 有比构建戳新的改动";
    console.log(`[dev-loop] out/ 过期（${reason}）：执行 build:no-runtime-assets …`);
    const buildStatus = runPnpm(desktopRoot, ["run", "build:no-runtime-assets"], "桌面端 JS 构建");
    if (buildStatus !== 0) return buildStatus;
    writeBuildStamp(desktopRoot);
  } else {
    console.log("[dev-loop] out/ 新鲜：跳过 JS 构建，直接增量重打 app.asar。");
  }

  const { refreshPackagedAppAsar } = await import(
    pathToFileURL(join(desktopRoot, "scripts", "incremental-app-asar.mjs")).href
  );
  try {
    const startedAt = Date.now();
    const { appAsarPath: packedPath } = await refreshPackagedAppAsar({
      desktopRoot,
      distRoot,
      targetOs: options.os,
      arch: options.arch,
    });
    console.log(`[dev-loop] 增量 asar 完成（${elapsedLabel(startedAt)}）：${packedPath}`);
  } catch (error) {
    console.error(
      `[dev-loop] 增量 asar 失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // 与 bundle.mjs 增量分支相同的机械校验：运行时依赖闭包 + native 越界。
  const bundle = await import(pathToFileURL(join(desktopRoot, "scripts", "bundle.mjs")).href);
  try {
    bundle.verifyPackagedRuntimeDependencies(options.os, options.arch);
  } catch (error) {
    console.error(
      `[dev-loop] 产物校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  console.log(
    `[dev-loop] 出包完成：${join(options.dist, unpackedDirName, "ZCode Preview.exe")}（直接原路径启动验证，勿复制到新目录）`,
  );
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exitCode = await runPackage();
}
