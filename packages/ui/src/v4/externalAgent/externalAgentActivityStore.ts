// 外部 agent 活动记录的模块级 store（按 sessionId 键控）。
//
// 为什么不是直接在侧栏面板里读会话投影：面板挂在 App 壳层，拿不到 SessionPane 的
// projection lease；而 Activity 又只存在于投影快照里（持久层刻意不存运行态）。
// 所以由 SessionPane 每帧把 `snapshot.externalAgentActivity` 推进来，面板只做订阅：
// 切 tab / 面板隐藏都不影响记录，和 Oracle 审查面板同一条路。
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";

const activities = new Map<string, ExternalAgentActivity | null>();
const listeners = new Map<string, Set<() => void>>();

/**
 * 写入某个会话的最新活动。
 *
 * 快照里没变化时引用保持不变（投影只替换被 patch 的字段），所以引用比较就够；
 * 这避免了"每帧都通知订阅者"的渲染风暴。
 */
export function publishExternalAgentActivity(
  sessionId: string,
  activity: ExternalAgentActivity | null,
): void {
  if (!sessionId) return;
  const previous = activities.get(sessionId) ?? null;
  if (previous === activity) return;
  // 从未委派过的会话不落空记录：面板按 null 也显示空态，但 store 不增长。
  if (activity === null && !activities.has(sessionId)) return;
  activities.set(sessionId, activity);
  const target = listeners.get(sessionId);
  if (!target) return;
  for (const listener of target) listener();
}

export function getExternalAgentActivity(sessionId: string): ExternalAgentActivity | null {
  return activities.get(sessionId) ?? null;
}

export function subscribeExternalAgentActivity(
  sessionId: string,
  listener: () => void,
): () => void {
  const existing = listeners.get(sessionId);
  if (existing) existing.add(listener);
  else listeners.set(sessionId, new Set([listener]));
  return () => {
    const target = listeners.get(sessionId);
    if (!target) return;
    target.delete(listener);
    if (target.size === 0) listeners.delete(sessionId);
  };
}
