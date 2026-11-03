// 外部 agent 活动记录的模块级 store（按 sessionId 键控）。
//
// 为什么不是直接在侧栏面板里读会话投影：面板挂在 App 壳层，拿不到 SessionPane 的
// projection lease；而 Activity 又只存在于投影快照里（持久层不存运行态）。
// 所以由 SessionPane 每帧把 `snapshot.externalAgentActivity` 推进来，面板只做订阅：
// 切 tab / 面板隐藏都不影响记录，和 Oracle 审查面板同一条路。
//
// **记录保留语义（2026-11-03）**：完成态记录不允许被"空值"覆盖。
// 投影在若干路径（冷恢复、重订阅拿到的新快照、会话重挂载的过渡帧）会给出
// `externalAgentActivity: null`——那不是"任务被撤销"，只是这一次快照没带这个字段。
// 直接把 null 写进来会让用户刚跑完的执行记录瞬间消失（实测反馈）。
// 因此：
// - `running` 记录可以被同 taskId 的新 running 帧更新，也可以被新 taskId 的 running 替换；
// - `settled`（completed/failed/cancelled）记录只在「新任务开始」或「显式清除」时消失；
// - null 只对"从未有过记录"的会话是 no-op。
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";

const activities = new Map<string, ExternalAgentActivity | null>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const target = listeners.get(sessionId);
  if (!target) return;
  for (const listener of target) listener();
}

/**
 * 写入某个会话的最新活动。
 *
 * 空值（null/undefined）**不会清掉一条已完成的记录**：那是快照缺字段，不是撤销。
 * 要清空请用 `clearExternalAgentActivity`（解绑、会话删除等显式动作）。
 */
export function publishExternalAgentActivity(
  sessionId: string,
  activity: ExternalAgentActivity | null,
): void {
  if (!sessionId) return;
  const previous = activities.get(sessionId) ?? null;
  if (previous === activity) return;
  if (activity === null) {
    // 完成态记录抗空值：投影换快照/冷恢复都会带一帧 null，不能把它当成一次清除。
    if (previous !== null) return;
    if (!activities.has(sessionId)) return;
  }
  activities.set(sessionId, activity);
  notify(sessionId);
}

/** 显式清空（解绑、会话被删除）：这是唯一能让完成态记录消失的入口。 */
export function clearExternalAgentActivity(sessionId: string): void {
  if (!sessionId) return;
  if (!activities.has(sessionId)) return;
  activities.set(sessionId, null);
  notify(sessionId);
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
