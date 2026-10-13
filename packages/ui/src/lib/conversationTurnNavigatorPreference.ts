// 会话回合导航偏好：纯客户端展示偏好，默认关闭（fail-closed）。
// 宽屏 rail 会自动补齐完整历史并对全量回合建索引，是长会话明确的加载/计算
// 放大器；仅存储值严格等于 "true" 才视为开启，缺失或非法值一律关闭。
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

export const CONVERSATION_TURN_NAVIGATOR_ENABLED_STORAGE_KEY =
  "zcode-conversation-turn-navigator-enabled";

export function loadConversationTurnNavigatorEnabled(): boolean {
  return readSafeLocalStorage(CONVERSATION_TURN_NAVIGATOR_ENABLED_STORAGE_KEY) === "true";
}

export function persistConversationTurnNavigatorEnabled(enabled: boolean): void {
  writeSafeLocalStorage(CONVERSATION_TURN_NAVIGATOR_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
}
