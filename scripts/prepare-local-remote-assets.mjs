#!/usr/bin/env node
// 本地远端资源树准备：把 mock-cdn 的扁平布局裁剪成"随包分发"的本地资源目录，
// 让打包版部署远端工作区时不再访问任何 CDN，直接 SFTP 上传随包资源。
//
// 与 pack-remote-assets-cdn.mjs 的区别：
//   - pack-remote-assets-cdn 产出 CDN 布局（components/<platformArch>/<id>/<version>.tar.gz），
//     供远端服务器自己下载；
//   - 本脚本产出扁平布局（releases/<version>/{manifest-*.json,server/,node/<plat>/...}），
//     供桌面端 LocalUploadAssetInstaller 读本地文件后上传，全程零网络请求。
//
// 目录语义（与运行时的 mockCdnDir 一致）：
//   产出根 = mockCdnDir，运行时按 <mockCdnDir>/releases/<version>/<sourceRelativePath> 取文件。
//
// 用法（仓库根目录）：
//   node scripts/prepare-local-remote-assets.mjs --platforms linux-x64
//   node scripts/prepare-local-remote-assets.mjs --platforms linux-x64,darwin-arm64 --out <dir>
//
// 产出目录由 electron-builder extraResources 打进 resources/remote-assets；
// 也可在运行时用 ZCODE_REMOTE_ASSET_LOCAL_DIR 指向任意同布局目录覆盖。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")).version;
const DEFAULT_STAGING_DIR = join(rootDir, "packages", "desktop", "dist-remote-assets-local");

// 每个组件在 mock-cdn 里的相对路径根，取自 manifest 的 mount 字段。
// 只复制 mount 根，不按文件名硬编码清单，组件增删时无需改本脚本。
function normalizeMount(mount) {
  return mount.replace(/^\/+|\/+$/g, "");
}

function parseArgs(argv) {
  const options = { platforms: null, sourceDir: null, outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--platforms" && next) {
      options.platforms = next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === "--source" && next) {
      options.sourceDir = next;
      index += 1;
      continue;
    }
    if (arg === "--out" && next) {
      options.outDir = next;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  options.platforms ??= (
    process.env.ZCODE_LOCAL_REMOTE_ASSET_PLATFORMS?.trim() ||
    process.env.ZCODE_REMOTE_CDN_PLATFORMS?.trim() ||
    "linux-x64"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  options.sourceDir ??=
    process.env.ZCODE_LOCAL_REMOTE_ASSET_SOURCE?.trim() ||
    join(rootDir, "packages", "desktop", "mock-cdn", "releases", version);
  options.outDir ??= process.env.ZCODE_LOCAL_REMOTE_ASSET_OUT?.trim() || DEFAULT_STAGING_DIR;
  return options;
}

function readManifest(sourceDir, platformArch) {
  const manifestPath = join(sourceDir, `manifest-${platformArch}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `缺少 manifest: ${manifestPath}（先运行 pnpm prepare:remote-assets 生成 mock-cdn 资源）`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function directorySize(dir) {
  if (!existsSync(dir)) {
    return 0;
  }
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSafe(current)) {
        stack.push(join(current, entry));
      }
      continue;
    }
    total += stat.size;
  }
  return total;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.sourceDir)) {
  throw new Error(
    `源目录不存在: ${options.sourceDir}（先运行 pnpm prepare:remote-assets 生成 mock-cdn 资源）`,
  );
}

const releaseOutDir = join(options.outDir, "releases", version);
console.log(`[local-remote-assets] version=${version} platforms=${options.platforms.join(",")}`);
console.log(`[local-remote-assets] source=${options.sourceDir}`);
console.log(`[local-remote-assets] out=${options.outDir}`);

// 重建目标 release 目录，避免上一次构建的旧组件残留后被一起打进安装包。
rmSync(releaseOutDir, { recursive: true, force: true });
mkdirSync(releaseOutDir, { recursive: true });

// server-bundle 的 mount 是跨平台共享的（manifest 里 mount=server），按 mount 去重只复制一次。
const copiedMounts = new Set();
const missingMounts = [];

for (const platformArch of options.platforms) {
  const manifest = readManifest(options.sourceDir, platformArch);
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  if (components.length === 0) {
    throw new Error(`manifest-${platformArch}.json 没有 components`);
  }

  for (const component of components) {
    const mount = typeof component?.mount === "string" ? normalizeMount(component.mount) : "";
    if (mount.length === 0) {
      throw new Error(
        `manifest-${platformArch}.json 的组件 ${component?.id ?? "<unknown>"} 缺少 mount`,
      );
    }
    if (copiedMounts.has(mount)) {
      continue;
    }

    const sourceMountDir = join(options.sourceDir, ...mount.split("/"));
    if (!existsSync(sourceMountDir)) {
      // 本地模式不会回退 CDN，缺一个 mount 就是部署必然失败。
      // 这里 fail-fast，错误直接指向缺失的源目录，而不是等到远端上传阶段才报。
      missingMounts.push(`${mount} (component=${component.id}, platform=${platformArch})`);
      continue;
    }

    const targetMountDir = join(releaseOutDir, ...mount.split("/"));
    mkdirSync(join(targetMountDir, ".."), { recursive: true });
    cpSync(sourceMountDir, targetMountDir, { recursive: true, dereference: true });
    copiedMounts.add(mount);
  }

  cpSync(
    join(options.sourceDir, `manifest-${platformArch}.json`),
    join(releaseOutDir, `manifest-${platformArch}.json`),
  );
  console.log(`  [ok] ${platformArch}: ${components.length} components`);
}

if (missingMounts.length > 0) {
  throw new Error(
    `本地资源树不完整，缺失以下组件目录（本地模式不回退 CDN，请先补全 mock-cdn）：\n  - ${missingMounts.join("\n  - ")}`,
  );
}

const copiedSize = directorySize(releaseOutDir);
console.log(`\n[local-remote-assets] 产出: ${releaseOutDir}`);
console.log(`[local-remote-assets] 体积: ${formatSize(copiedSize)}（会随安装包分发）`);
console.log(
  "[local-remote-assets] 下一步: 由 electron-builder extraResources 打包到 resources/remote-assets；",
);
console.log(
  "                    运行时也可用 ZCODE_REMOTE_ASSET_LOCAL_DIR 指向任意同布局目录覆盖。",
);
