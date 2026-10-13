// 消息文件预览自动加载偏好：纯客户端展示偏好，**默认开启**（兼容旧体验）。
// 仅存储值严格等于 "false" 才关闭；缺失或非法值视为开启。关闭后不自动查
// fileChanges，改为回合内「加载预览」手动触发（见 specs/assistant-auto-file-preview.md）。
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

export const ASSISTANT_AUTO_FILE_PREVIEW_ENABLED_STORAGE_KEY =
  "zcode-assistant-auto-file-preview-enabled";

export function loadAssistantAutoFilePreviewEnabled(): boolean {
  return readSafeLocalStorage(ASSISTANT_AUTO_FILE_PREVIEW_ENABLED_STORAGE_KEY) !== "false";
}

export function persistAssistantAutoFilePreviewEnabled(enabled: boolean): void {
  writeSafeLocalStorage(
    ASSISTANT_AUTO_FILE_PREVIEW_ENABLED_STORAGE_KEY,
    enabled ? "true" : "false",
  );
}
