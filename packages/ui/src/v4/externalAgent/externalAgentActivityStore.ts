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
// - null 永远不写（"从未有过记录"的会话也不会因此落一条空记录）。
//
// **注意力语义（2026-11-05，借 herdr 的 seen/Done）**：除了记录本身，store 还维护
// 两件 UI 需要的事实：
// - `lastChangedAt`：最近一次帧到达的时间。运行中长时间不变 = 没有新输出（卡住/在
//   等一个很长的工具），卡片与面板据此显示「已 N 分钟无新输出」，而不是让用户去猜。
// - `unreadTaskId`：从 running 变成终态的那一次转换记一条未读。两个"已读"入口：
//   打开过程面板、关闭状态卡；另外"看着它跑完"（终态帧是实时到达的、不是重挂载
//   时补发的）也算已读——见下面的 `replayed` 参数。
//   不做持久化（与 herdr 一致：重启归零，重启后的历史由会话记录承载）。
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";

/** 运行中多久没有新输出就提示"可能卡住"：60s 足够长，正常委派不会误报。 */
export const EXTERNAL_AGENT_IDLE_HINT_MS = 60_000;

export interface ExternalAgentActivityState {
  activity: ExternalAgentActivity | null;
  /** 最近一次活动变化的时间（epoch ms）；没有记录时为 null。 */
  lastChangedAt: number | null;
  /** 已完成但用户还没看过的任务 id。 */
  unreadTaskId: string | null;
  /**
   * 这条未读是**实时帧**记下来的，还是重挂载时补发的一帧（`replayed`）。
   *
   * 只有实时的才算"用户看着它跑完"，卡片可以据此自动销未读；重挂载补发的
   * 意味着完成发生在用户切走期间——必须留到用户真正打开面板/关掉卡片。
   */
  unreadLive: boolean;
}

const EMPTY_STATE: ExternalAgentActivityState = {
  activity: null,
  lastChangedAt: null,
  unreadTaskId: null,
  unreadLive: false,
};

const states = new Map<string, ExternalAgentActivityState>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const target = listeners.get(sessionId);
  if (!target) return;
  for (const listener of target) listener();
}

function write(sessionId: string, next: ExternalAgentActivityState): void {
  states.set(sessionId, next);
  notify(sessionId);
}

/**
 * 写入某个会话的最新活动。
 *
 * 空值（null/undefined）**不会清掉一条已完成的记录**：那是快照缺字段，不是撤销。
 * 要清空请用 `clearExternalAgentActivity`（解绑、会话删除等显式动作）。
 *
 * `replayed`：这一帧是（重新）订阅后补发的第一帧，可能早就生成了。调用方
 * （SessionPane）在每次挂载/切回会话后对第一帧置 true——只有这样才能区分
 * "用户看着它跑完"和"用户切回来时才看到它已经跑完"。
 */
export function publishExternalAgentActivity(
  sessionId: string,
  activity: ExternalAgentActivity | null,
  options: { replayed?: boolean } = {},
): void {
  if (!sessionId) return;
  const previous = states.get(sessionId);
  const previousActivity = previous?.activity ?? null;
  if (previousActivity === activity) return;
  if (activity === null) {
    // 空值永远不写：完成态记录不能被"快照没带这个字段"清掉，
    // 清空只有 `clearExternalAgentActivity` 一条路。
    return;
  }

  // running → 终态只发生一次：这是唯一产生未读的转换。
  const settledNow =
    previousActivity !== null &&
    previousActivity.status === "running" &&
    activity.status !== "running";
  const unreadTaskId = settledNow
    ? activity.taskId
    : activity.status === "running"
      ? // 同一任务的迟到 running 帧（异步投递可能乱序）不能销掉刚记的未读；
        // 换成新任务才是"上一条的未读已失去意义"。
        previous?.unreadTaskId === activity.taskId
        ? previous.unreadTaskId
        : null
      : (previous?.unreadTaskId ?? null);

  write(sessionId, {
    activity,
    lastChangedAt: Date.now(),
    unreadTaskId,
    unreadLive: settledNow ? options.replayed !== true : (previous?.unreadLive ?? false),
  });
}

/** 用户看到了这条结果（卡片可见 / 面板打开）：清掉未读点。 */
export function markExternalAgentActivitySeen(sessionId: string, taskId?: string): void {
  if (!sessionId) return;
  const previous = states.get(sessionId);
  if (!previous?.unreadTaskId) return;
  if (taskId && previous.unreadTaskId !== taskId) return;
  write(sessionId, { ...previous, unreadTaskId: null });
}

/** 显式清空（解绑、会话被删除）：这是唯一能让完成态记录消失的入口。 */
export function clearExternalAgentActivity(sessionId: string): void {
  if (!sessionId) return;
  if (!states.has(sessionId)) return;
  write(sessionId, EMPTY_STATE);
}

export function getExternalAgentActivity(sessionId: string): ExternalAgentActivity | null {
  return states.get(sessionId)?.activity ?? null;
}

/**
 * 完整状态（活动 + 注意力事实）。返回的对象在状态变化前保持同一引用，
 * 可以直接交给 `useSyncExternalStore`（空 session 复用同一个常量，不会触发死循环）。
 */
export function getExternalAgentActivityState(
  sessionId: string | null | undefined,
): ExternalAgentActivityState {
  if (!sessionId) return EMPTY_STATE;
  return states.get(sessionId) ?? EMPTY_STATE;
}

/** 侧栏 tab 的未读点：只返回布尔原语，避免每个 tab 订阅整份快照。 */
export function isExternalAgentActivityUnread(sessionId: string): boolean {
  return Boolean(states.get(sessionId)?.unreadTaskId);
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
