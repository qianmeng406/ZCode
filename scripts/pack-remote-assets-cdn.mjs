#!/usr/bin/env node
// 远端资源 CDN 发布打包：把本地构建的 mock-cdn（扁平布局）转成应用部署时拉取的
// CDN 布局，让打包版也能用上 fork 的服务端产物（否则会从官方 CDN 拿到未修改的 server bundle）。
//
// 应用侧取址规则（packages/desktop/src/main/remoteCdn.ts + remoteAssetCdn.ts）：
//   manifest: <ZCODE_CDN_BASE_URL>/zcode/electron/releases/<appVersion>/manifest-<platformArch>.json
//   artifact: <ZCODE_CDN_BASE_URL>/zcode/electron/releases/components/<platformArch>/<id>/<version>.tar.gz
//             （组件走跨版本 releases/components 根；版本目录下的同路径只是回退候选）
// 归档语义（用官方 3.14.3 server-bundle 实物核对）：tar 根 = mount 目录的**内容**
//   （server-bundle 归档内是裸 `zcode-server.cjs`，不带 `server/` 前缀），
//   运行时 materialize 会把归档内容放进 <release>/<mount>/；
//   manifest.sha256 校验的是 tar.gz 归档本身，版本号后缀 = 归档 sha256 前 12 位。
//
// 用法（仓库根目录）：
//   node scripts/pack-remote-assets-cdn.mjs --platforms linux-x64
//   node scripts/pack-remote-assets-cdn.mjs --platforms linux-x64,darwin-arm64 --out <dir>
// 产出目录可整体上传到托管根；把 ZCODE_CDN_BASE_URL 指向该根（或写进 .env.production 固化）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create as createTarArchive } from "tar";

const rootDir = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8")).version;

function parseArgs(argv) {
  const options = { platforms: ["linux-x64"], sourceDir: null, outDir: null };
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
  options.sourceDir ??= join(rootDir, "packages/desktop/mock-cdn/releases", version);
  options.outDir ??= join(rootDir, "packages/desktop/dist-remote-cdn");
  return options;
}

/** 版本号形如 v3.14.3+99707f452e7c：保留语义版本前缀，用新归档哈希替换 + 后缀。 */
function nextComponentVersion(previousVersion, archiveSha256) {
  const withoutHash = previousVersion.split("+")[0];
  return `${withoutHash}+${archiveSha256.slice(0, 12)}`;
}

async function createArchiveBuffer(cwd) {
  // portable + noMtime：归档必须确定性——否则同一内容每次打包哈希都不同（实测），
  // 部署身份随之变化，用户每次连接都要重传全部组件。
  const archive = createTarArchive({ gzip: true, cwd, portable: true, noMtime: true }, ["."]);
  const chunks = [];
  for await (const chunk of archive) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function packComponent({ component, sourceDir, releasesDir, platformArch }) {
  const mountRelative = component.mount.replace(/^[\\/]+/, "");
  const mountPath = join(sourceDir, mountRelative);
  if (!existsSync(mountPath)) {
    throw new Error(
      `组件 ${component.id} 的源路径不存在: ${mountPath}（manifest mount=${component.mount}）`,
    );
  }
  // 组件归档放跨版本 releases/components 根（与官方 CDN 一致）。
  const archiveDir = join(releasesDir, "components", platformArch, component.id);
  mkdirSync(archiveDir, { recursive: true });

  // 用 tar 库打包（纯 JS，规避 Windows bsdtar 把 `C:\` 当远程主机的问题）。
  const buffer = await createArchiveBuffer(mountPath);
  const archiveSha256 = createHash("sha256").update(buffer).digest("hex");
  const componentVersion = nextComponentVersion(component.version, archiveSha256);
  const archiveName = `${componentVersion}.tar.gz`;
  writeFileSync(join(archiveDir, archiveName), buffer);
  console.log(
    `  [ok] ${component.id}: ${componentVersion} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`,
  );
  return {
    id: component.id,
    version: componentVersion,
    sha256: archiveSha256,
    // 来源哈希沿用源 manifest：仅供溯源，不作为校验依据。
    ...(component.sourceSha256 ? { sourceSha256: component.sourceSha256 } : {}),
    artifactPath: `components/${platformArch}/${component.id}/${archiveName}`,
    mount: component.mount,
  };
}

async function packPlatform({ platformArch, sourceDir, outDir }) {
  const sourceManifestPath = join(sourceDir, `manifest-${platformArch}.json`);
  if (!existsSync(sourceManifestPath)) {
    throw new Error(
      `缺少源 manifest: ${sourceManifestPath}（先跑 prepare:remote-assets 生成 mock-cdn）`,
    );
  }
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf-8"));
  // 托管根结构：<out>/zcode/electron/releases/{<version>/manifest-*.json, components/**}
  const releasesDir = join(outDir, "zcode", "electron", "releases");
  const outVersionDir = join(releasesDir, version);
  mkdirSync(outVersionDir, { recursive: true });
  // 清掉本平台上一轮遗留的归档：文件名带内容哈希，内容一变旧归档就成孤儿，
  // 只增不删会让发布树随构建次数累积（实测多出 7MB = 旧 server-bundle + 旧 glm）。
  rmSync(join(releasesDir, "components", platformArch), { recursive: true, force: true });

  console.log(`==> ${platformArch}: ${sourceManifest.components.length} 个组件`);
  const components = await Promise.all(
    sourceManifest.components.map((component) =>
      packComponent({ component, sourceDir, releasesDir, platformArch }),
    ),
  );
  const manifest = { ...sourceManifest, appVersion: version, platformArch, components };
  writeFileSync(
    join(outVersionDir, `manifest-${platformArch}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
  console.log(`  [ok] manifest-${platformArch}.json`);
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.sourceDir)) {
  throw new Error(`源目录不存在: ${options.sourceDir}`);
}
console.log(`[remote-cdn] version=${version} source=${options.sourceDir}`);
for (const platformArch of options.platforms) {
  await packPlatform({ platformArch, sourceDir: options.sourceDir, outDir: options.outDir });
}
console.log(`\n[remote-cdn] 产出: ${join(options.outDir, "zcode/electron/releases")}`);
console.log(`[remote-cdn] 发布: 把 "${options.outDir}" 下的内容整体上传到托管根，`);
console.log(
  "           然后把 ZCODE_CDN_BASE_URL 指向该根（构建期写 .env.production，或运行时 env 覆盖）。",
);
console.log("[remote-cdn] 本地验证: 用静态服务指向该根，例如");
console.log(`            python -m http.server 8899 --directory "${options.outDir}"`);
console.log("            再以 ZCODE_CDN_BASE_URL=http://127.0.0.1:8899 启动应用。");
