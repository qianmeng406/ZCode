import { getBuildMetadata } from "./build-metadata.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";

/**
 * electron-builder 的 `extraMetadata`：打包时覆盖进 app.asar 根 package.json 的字段。
 *
 * 桌面端源 package.json 没有 version（版本来自构建元数据），运行时 `app.getVersion()`
 * 依赖这里注入的值。完整打包由 electron-builder 负责写入；增量打包必须自己写同样的
 * 内容，否则 Electron 回退到 exe 的四段文件版本（如 3.16.2.0），electron-updater
 * 会直接抛 "App version is not a valid semver version" 并让主进程启动失败。
 */
export function createPackagedExtraMetadata({
  buildMetadata = getBuildMetadata(),
  identity = resolveDesktopProductIdentity(),
} = {}) {
  return {
    version: buildMetadata.appVersion,
    zcodeProductFlavor: identity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  };
}

export function createPackagedPackageJson(sourcePackageJson, options) {
  return {
    ...sourcePackageJson,
    ...createPackagedExtraMetadata(options),
  };
}
