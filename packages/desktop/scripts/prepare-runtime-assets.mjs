#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isRealComputerUseProducerInstalled } from "./computer-use-producer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const rootDir = resolve(desktopRoot, "../..");
// 远端资源按 <version> 分目录（mock-cdn 与随包本地资源树都用同一个版本号）。
const version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")).version;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// Windows Computer Use Helper 由真实 producer 提供；开源占位包没有 Helper runtime，跳过准备。
const shouldPrepareWindowsCuaHelper =
  target.os === "win32" && isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot });
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// 本机桌面包不再内置 glm 原生二进制（prepare:glm），改为内置 agent 的 JS bundle（prepare:agent-bundle），
// 运行时由 app 的 Electron Node runtime 执行。Source Server 资源由独立 stage:remote-assets 入口负责。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(shouldPrepareWindowsCuaHelper ? ["prepare:windows-cua-helper"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

function runTimedNodeScript(label, scriptPath, args) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${label} start`);
  try {
    runCommand(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${label} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";
// 打包版部署远端工作区时按 ZCODE_CDN_BASE_URL 拉取服务端产物；fork 必须同时产出
// 自己的发布树，否则会从官方 CDN 拿到未含 fork 改动的 server bundle。
// 规格与发布步骤见 packages/server/specs/remote-resident-server.md 5.1。
const shouldSkipRemoteCdnPack = process.env.ZCODE_SKIP_REMOTE_CDN_PACK === "1";
const remoteCdnPlatforms = process.env.ZCODE_REMOTE_CDN_PLATFORMS?.trim() || "linux-x64";
// 本地远端资源树：裁剪出目标平台后随安装包分发，运行时直接本地上传，不再访问 CDN。
// 这是 fork 的默认部署形态；只有显式设置 ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1 才跳过。
const shouldSkipLocalRemoteAssets = process.env.ZCODE_SKIP_LOCAL_REMOTE_ASSETS === "1";
const localRemoteAssetSource =
  process.env.ZCODE_LOCAL_REMOTE_ASSET_SOURCE?.trim() ||
  resolve(rootDir, "packages", "desktop", "mock-cdn", "releases", version);

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
  if (shouldSkipRemoteCdnPack) {
    console.log(
      "[prepare-runtime-assets] skip pack-remote-assets-cdn (ZCODE_SKIP_REMOTE_CDN_PACK=1)",
    );
  } else {
    runTimedNodeScript(
      "pack-remote-assets-cdn",
      resolve(rootDir, "scripts/pack-remote-assets-cdn.mjs"),
      ["--platforms", remoteCdnPlatforms],
    );
  }
  // 必须紧跟 prepare:remote-assets：上面刚重建过 mock-cdn 里的 server bundle，
  // 这里立刻裁剪成随包资源，避免打包到上一次构建的陈旧产物。
  if (shouldSkipLocalRemoteAssets) {
    console.log(
      "[prepare-runtime-assets] skip prepare-local-remote-assets (ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1)",
    );
  } else if (!existsSync(localRemoteAssetSource)) {
    // 未准备 mock-cdn 的机器仍应能出包；此时运行时回退 CDN 下载。
    console.log(
      `[prepare-runtime-assets] skip prepare-local-remote-assets: 源目录不存在 ${localRemoteAssetSource}`,
    );
  } else {
    runTimedNodeScript(
      "prepare-local-remote-assets",
      resolve(rootDir, "scripts/prepare-local-remote-assets.mjs"),
      ["--platforms", remoteCdnPlatforms],
    );
  }
} else {
  // Windows build job 的桌面安装包不依赖 mock-cdn remote 资产。
  // 之前这里无条件执行 prepare:remote-assets，会在同一个 job 里串行下载/打包跨平台资源，
  // 导致 CI 时间被白白拉长并逼近 1 小时上限。增加显式开关，只在需要时才准备 remote 资产。
  console.log("[prepare-runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
