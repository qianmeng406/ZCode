import { useCallback, useSyncExternalStore } from "react";
import type {
  PromptOptimizerContextRange,
  PromptOptimizerMode,
  PromptOptimizerWarningCode,
} from "@/v4/composer/promptOptimizerPrompt.js";

/**
 * 提示词优化的作用域状态：模块级 Map + 单调 requestId。
 *
 * 为什么不用组件 state：请求可能跨越会话切换（用户点完就切走），结果必须留在
 * **发起它的那个 scope**，不能落进新会话的输入框。requestId 是防迟到回写的唯一凭据：
 * 取消/放弃/被新请求取代都先递增它，异步回调再检查 `isCurrent`。
 *
 * 只驻内存、不写 localStorage：草稿原文与候选结果没有持久化价值，
 * 残留反而可能把旧候选套到新草稿上。
 */

export interface PromptOptimizerState {
  status: "pending" | "ready" | "error" | "cancelled";
  requestId: number;
  operationId: string | null;
  baseDraft: string;
  /** 发起时的草稿版本凭据；应用前用它确认输入框没被改过。 */
  baseVersion: string;
  mode: PromptOptimizerMode;
  contextRange: PromptOptimizerContextRange;
  startedAt: number;
  durationMs?: number;
  /**
   * 复用键：草稿 + 版本 + 模式 + 上下文范围 + 上下文材料 + 解析后的模型选择。
   * 少任何一项都会出现「换了模型/多了关键对话却仍返回旧结果」。
   */
  cacheKey?: string;
  /**
   * 发起时冻结的「草稿含无法用纯文本重建的内容」（mention 节点 / 附件 / 外部引用）。
   * 冻结而非即时判断：判断必须对应**被优化的那份草稿**，否则用户中途加个附件
   * 就会改变对既有候选的解释。
   */
  richContext?: boolean;
  optimized?: string;
  unresolved?: readonly string[];
  warnings?: readonly PromptOptimizerWarningCode[];
  errorReason?: string;
  /** 已写入输入框的候选正文（用于判定用户是否仍在这次替换状态上）。 */
  appliedText?: string;
  /** 替换前的正文；仅在输入框仍等于 appliedText 时允许还原。 */
  undoText?: string;
  /** 替换前的编辑器状态：mention/格式只能靠它还原，纯文本做不到。 */
  undoEditorStateJson?: string;
}

const MAX_TRACKED_SCOPES = 24;

const states = new Map<string, PromptOptimizerState>();
const seqs = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  // 先取快照再回调：监听器在回调里取消订阅不应该影响本轮其余监听器。
  const current = Array.from(listeners);
  for (const listener of current) {
    listener();
  }
}

function evictIfNeeded(): void {
  if (states.size <= MAX_TRACKED_SCOPES) {
    return;
  }
  // Map 保持插入序：淘汰最旧的非 pending scope（在飞请求不能丢状态）。
  for (const [key, state] of states) {
    if (states.size <= MAX_TRACKED_SCOPES) {
      break;
    }
    if (state.status !== "pending") {
      states.delete(key);
      seqs.delete(key);
    }
  }
}

export function getPromptOptimizerState(scopeKey: string): PromptOptimizerState | null {
  return states.get(scopeKey) ?? null;
}

export function subscribePromptOptimizerStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function nextPromptOptimizerRequestId(scopeKey: string): number {
  const next = (seqs.get(scopeKey) ?? 0) + 1;
  seqs.set(scopeKey, next);
  return next;
}

export function isCurrentPromptOptimizerRequest(scopeKey: string, requestId: number): boolean {
  return (seqs.get(scopeKey) ?? 0) === requestId;
}

/** 让在飞请求失效（取消/放弃/发送后不再回写）。 */
export function invalidatePromptOptimizerScope(scopeKey: string): void {
  nextPromptOptimizerRequestId(scopeKey);
}

export function setPromptOptimizerState(scopeKey: string, state: PromptOptimizerState | null): void {
  if (state === null) {
    states.delete(scopeKey);
  } else {
    states.delete(scopeKey);
    states.set(scopeKey, state);
    evictIfNeeded();
  }
  notify();
}

export function patchPromptOptimizerState(
  scopeKey: string,
  requestId: number,
  patch: Partial<PromptOptimizerState>,
): PromptOptimizerState | null {
  const current = states.get(scopeKey);
  if (!current || current.requestId !== requestId) {
    return null;
  }
  const next: PromptOptimizerState = { ...current, ...patch };
  setPromptOptimizerState(scopeKey, next);
  return next;
}

export function isPromptOptimizerPending(scopeKey: string): boolean {
  return states.get(scopeKey)?.status === "pending";
}

/** 仅测试使用：清空模块级状态。 */
export function resetPromptOptimizerStoreForTest(): void {
  states.clear();
  seqs.clear();
  listeners.clear();
}

export function usePromptOptimizerState(scopeKey: string): PromptOptimizerState | null {
  const subscribe = useCallback((listener: () => void) => subscribePromptOptimizerStore(listener), []);
  const getSnapshot = useCallback(() => getPromptOptimizerState(scopeKey), [scopeKey]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
