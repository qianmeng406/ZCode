/** UI 远端图片只允许 HTTPS；失败时由各展示组件回退到本地图标。 */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return isHttpsImageUrl(url);
}

/**
 * 与 `isTrustedImageUrl` 同一规则的布尔形态。
 * 需要在 HTTPS 之后继续判断别的来源时用它：类型谓词会把不匹配的分支收窄成 `never`。
 */
export function isHttpsImageUrl(url: string | undefined): boolean {
  return typeof url === "string" && url.startsWith("https://");
}
