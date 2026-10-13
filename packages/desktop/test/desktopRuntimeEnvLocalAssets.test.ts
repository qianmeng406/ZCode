// 随包/本地远端资源解析回归：
// - 命中本地资源目录时必须返回完整 RemoteAssetDirs（mockCdnDir + remoteCacheDir），
//   且不带任何 CDN 基址（从构造上关闭 CDN 回退）。
//   此分支曾引用声明前的 remoteCacheDir（TDZ），命中即抛 ReferenceError。
// - 覆盖目录缺 releases/<版本> 时显式告警并继续解析其它来源，不静默当命中。
// - 缓存目录支持 ZCODE_REMOTE_ASSET_CACHE_DIR 覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveRemoteAssetDirs } from "../src/main/desktopRuntimeEnv.js";

async function makeLocalAssetDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-runtime-env-"));
  // 命中判定要求目录内存在 releases/<版本>。
  await mkdir(join(root, "releases", ZCODE_VERSION), { recursive: true });
  return root;
}

test("命中本地资源目录返回 mockCdnDir + remoteCacheDir 且无 CDN 基址", async () => {
  const localAssetDir = await makeLocalAssetDir();
  try {
    const dirs = resolveRemoteAssetDirs({}, { ZCODE_REMOTE_ASSET_LOCAL_DIR: localAssetDir });
    assert.equal(dirs.mockCdnDir, localAssetDir);
    assert.equal(typeof dirs.remoteCacheDir, "string");
    assert.ok(dirs.remoteCacheDir.length > 0, "remoteCacheDir 必须可解析（TDZ 回归）");
    assert.equal(dirs.remoteCdnBaseUrl, undefined);
    assert.equal(dirs.remoteCdnBaseUrls, undefined);
  } finally {
    await rm(localAssetDir, { recursive: true, force: true });
  }
});

test("覆盖目录缺 releases/<版本> 时不命中本地分支（告警后回落）", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "desktop-runtime-env-empty-"));
  try {
    const dirs = resolveRemoteAssetDirs({}, { ZCODE_REMOTE_ASSET_LOCAL_DIR: emptyDir });
    // 未命中即不得把无效覆盖目录当本地资源；其它来源（开发态 mock-cdn）允许存在。
    assert.notEqual(dirs.mockCdnDir, emptyDir);
    assert.equal(typeof dirs.remoteCacheDir, "string");
    assert.ok(dirs.remoteCacheDir.length > 0);
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("remoteCacheDir 支持 ZCODE_REMOTE_ASSET_CACHE_DIR 覆盖（本地分支同样生效）", async () => {
  const localAssetDir = await makeLocalAssetDir();
  const cacheDir = join(localAssetDir, "custom-cache");
  try {
    const dirs = resolveRemoteAssetDirs(
      {},
      { ZCODE_REMOTE_ASSET_LOCAL_DIR: localAssetDir, ZCODE_REMOTE_ASSET_CACHE_DIR: cacheDir },
    );
    assert.equal(dirs.mockCdnDir, localAssetDir);
    assert.ok(
      typeof dirs.remoteCacheDir === "string" && dirs.remoteCacheDir.replace(/\\/g, "/").endsWith("custom-cache"),
      `remoteCacheDir 应为覆盖值，实际: ${String(dirs.remoteCacheDir)}`,
    );
  } finally {
    await rm(localAssetDir, { recursive: true, force: true });
  }
});
