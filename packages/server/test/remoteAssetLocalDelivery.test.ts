// 远端资源交付策略回归：
// - 默认（本地上传）：读随包/本地资源，绝不碰 CDN；缺件 fail-fast 且错误指向本地资源树。
// - 远端服务器下载：总有 CDN 来源，用户没配时缺省 ZCode 官方 CDN（拉官方产物，不含本仓库改动）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRemoteAssetPlaceholderError,
  type RemoteAssetDeployOptions,
} from "../src/remote/deployShared.js";
import {
  OFFICIAL_REMOTE_ASSET_CDN_BASE_URL,
  shouldUseLocalUploadInstaller,
  withRemoteDownloadOfficialCdn,
} from "../src/remote/deploy.js";

test("默认模式（未显式选择）始终走本地上传", () => {
  assert.equal(shouldUseLocalUploadInstaller({}), true);
  assert.equal(
    shouldUseLocalUploadInstaller({ assetInstallMode: "local-download-upload", mockCdnDir: "/x" }),
    true,
  );
});

test("远端下载模式不再回退本地上传（CDN 由缺省官方基址兜底）", () => {
  assert.equal(
    shouldUseLocalUploadInstaller({ assetInstallMode: "remote-download", mockCdnDir: "/x" }),
    false,
  );
  assert.equal(shouldUseLocalUploadInstaller({ assetInstallMode: "remote-download" }), false);
});

test("remote-download 未配置 CDN 时缺省注入 ZCode 官方基址（含版本路径）", () => {
  const resolved = withRemoteDownloadOfficialCdn({ assetInstallMode: "remote-download" });
  assert.equal(
    resolved.remoteCdnBaseUrl,
    `${OFFICIAL_REMOTE_ASSET_CDN_BASE_URL}/zcode/electron/releases/0.0.0-dev`,
  );
});

test("remote-download 已配置基址时不覆盖用户配置", () => {
  const configured = {
    assetInstallMode: "remote-download" as const,
    remoteCdnBaseUrl: "https://my-cdn.example.com/zcode/electron/releases/3.14.3",
  };
  assert.equal(withRemoteDownloadOfficialCdn(configured), configured);

  const configuredList = {
    assetInstallMode: "remote-download" as const,
    remoteCdnBaseUrls: ["https://my-cdn.example.com"],
  };
  assert.equal(withRemoteDownloadOfficialCdn(configuredList), configuredList);
});

test("本地上传模式不注入任何 CDN 基址", () => {
  const local = { assetInstallMode: "local-download-upload" as const, mockCdnDir: "/x" };
  const resolved = withRemoteDownloadOfficialCdn(local);
  assert.equal(resolved.remoteCdnBaseUrl, undefined);
  assert.equal(resolved, local);
});

test("本地模式的缺件错误指向随包资源，而不是让人去找 CDN 配置", () => {
  const options: RemoteAssetDeployOptions = {};
  const error = createRemoteAssetPlaceholderError("linux-x64", options, "server-bundle");

  assert.match(error.message, /server-bundle/);
  assert.match(error.message, /linux-x64/);
  assert.match(error.message, /resources\/remote-assets/);
  assert.match(error.message, /ZCODE_REMOTE_ASSET_LOCAL_DIR/);
  // 没有 CDN 来源时不应该把排查方向指向 remoteCdnBaseUrl。
  assert.doesNotMatch(error.message, /remoteCdnBaseUrl=/);
});

test("配置了 CDN 来源时保留原有指向 CDN 的排查信息", () => {
  const error = createRemoteAssetPlaceholderError(
    "linux-x64",
    {
      remoteCdnBaseUrl: "https://cdn.example.com",
      remoteCacheDir: "C:/cache",
    },
    "node-runtime",
  );

  assert.match(error.message, /node-runtime/);
  assert.match(error.message, /remoteCdnBaseUrl=https:\/\/cdn\.example\.com/);
  assert.doesNotMatch(error.message, /ZCODE_REMOTE_ASSET_LOCAL_DIR/);
});
