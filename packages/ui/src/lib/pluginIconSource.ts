import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import { isHttpsImageUrl } from "@/lib/trustedImageUrl.js";

const OFFICIAL_PLUGIN_ICON_BY_ID: Readonly<Record<string, string>> = {
  "documents@zcode-plugins-official": documentsIconUrl,
  "image-search@zcode-plugins-official": imageSearchIconUrl,
  "pdf@zcode-plugins-official": pdfIconUrl,
  "plugin-creator@zcode-plugins-official": pluginCreatorIconUrl,
  "presentations@zcode-plugins-official": presentationsIconUrl,
  "spreadsheets@zcode-plugins-official": spreadsheetsIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(OFFICIAL_PLUGIN_ICON_BY_ID));

/**
 * 插件图标额外放行内联 `data:image`：本地开发市场的插件没有 CDN 可挂图标，目录条目
 * 只能把图标本身带进 listing。`<img>` 中的 data: 图片不执行脚本，且限制 MIME 白名单
 * 与长度，避免任意字符串进入协议或被当作任意资源加载。
 */
const INLINE_PLUGIN_ICON_DATA_URL =
  /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u;
const INLINE_PLUGIN_ICON_MAX_CHARS = 64 * 1024;

/** 插件图标可用的来源：HTTPS CDN 或内联图片。 */
export function isTrustedPluginIconUrl(url: string | undefined): url is string {
  if (typeof url !== "string") return false;
  if (isHttpsImageUrl(url)) return true;
  return url.length <= INLINE_PLUGIN_ICON_MAX_CHARS && INLINE_PLUGIN_ICON_DATA_URL.test(url);
}

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const bundledIcon = OFFICIAL_PLUGIN_ICON_BY_ID[pluginId];
    if (bundledIcon) return bundledIcon;
  }
  return isTrustedPluginIconUrl(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；放行固定打包资源、HTTPS 与内联图片。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedPluginIconUrl(icon);
}
