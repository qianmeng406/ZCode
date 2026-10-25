// 会话窗口收纳偏好：纯客户端展示偏好，默认关闭（fail-closed）。
// 开启后渲染层只保留最近一段窗口（收纳更早的行 + 顶部"加载更早"增量入口），
// 关闭时保持既有行为：窗口只增不减、宽屏轨道自动补齐完整历史。
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

export const CONVERSATION_WINDOW_COLLAPSE_ENABLED_STORAGE_KEY =
  "zcode-conversation-window-collapse-enabled";

export function loadConversationWindowCollapseEnabled(): boolean {
  return readSafeLocalStorage(CONVERSATION_WINDOW_COLLAPSE_ENABLED_STORAGE_KEY) === "true";
}

export function persistConversationWindowCollapseEnabled(enabled: boolean): void {
  writeSafeLocalStorage(
    CONVERSATION_WINDOW_COLLAPSE_ENABLED_STORAGE_KEY,
    enabled ? "true" : "false",
  );
}
