// 代码预览设置持久化：读取（损坏/缺失回退默认）与落盘各走唯一入口。
// store 只保留写入时的合并提交，读取逻辑下沉到本模块（codePreviewSettings
// 类型与默认值本就住在这里），避免 store 文件继续膨胀。
import {
  DEFAULT_CODE_PREVIEW_SETTINGS,
  type CodePreviewSettings,
} from "./codePreviewSettings.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

const CODE_PREVIEW_SETTINGS_KEY = "zcode-code-preview-settings";

export function loadCodePreviewSettings(): CodePreviewSettings {
  try {
    const raw = readSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_CODE_PREVIEW_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<CodePreviewSettings>;
    return {
      ...DEFAULT_CODE_PREVIEW_SETTINGS,
      ...parsed,
      fontSizePx:
        typeof parsed.fontSizePx === "number"
          ? Math.min(20, Math.max(12, Math.round(parsed.fontSizePx)))
          : DEFAULT_CODE_PREVIEW_SETTINGS.fontSizePx,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}

export function persistCodePreviewSettings(settings: CodePreviewSettings): void {
  writeSafeLocalStorage(CODE_PREVIEW_SETTINGS_KEY, JSON.stringify(settings));
}
