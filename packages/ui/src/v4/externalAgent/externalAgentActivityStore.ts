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
// - 快照里的 null 默认不写（那多半是这次快照没带这个字段）——只有调用方明确
//   标记 `cleared`（服务端补发的清空事件）才生效，而且只清卡住的 `running`。
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

/** 面板保留多少次执行：外部 CLI 会话是续接的，过程应像子智能体一样累积。 */
const MAX_RUNS = 5;
/** 历史过程的总字数上限：超出从最老的一次开始丢（当前这次永远保留）。 */
const MAX_RUNS_CHARS = 400_000;

/**
 * 面板要渲染的一次执行：主 agent 发的任务正文 + 这一次的过程条目。
 *
 * 与 `activity` 的关系：`activity` 是"当前/最近一次"的完整快照（卡片、未读、
 * 卡住判定都用它）；`runs` 是最近几次的累积视图，只给过程面板做会话式回放。
 */
export interface ExternalAgentRunView {
  taskId: string;
  /** 主 agent 发给外部 CLI 的任务正文（面板渲染成一条用户消息）。 */
  prompt?: string;
  status: ExternalAgentActivity["status"];
  startedAt: number;
  elapsedMs: number;
  entries: NonNullable<ExternalAgentActivity["entries"]>;
  /** 没有结构化条目时的纯文本兜底（面板按行切分渲染）。 */
  tail?: string;
  error?: string;
  trimmedEntries?: number;
  sourceTruncated?: boolean;
  /** 冷恢复补发的「上次执行」摘要（不是实时运行）。 */
  historical?: boolean;
}

export interface ExternalAgentActivityState {
  activity: ExternalAgentActivity | null;
  /** 最近几次执行（时间正序）。面板按它渲染"任务 → 过程 → 任务 → 过程"。 */
  runs: ExternalAgentRunView[];
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
  runs: [],
  lastChangedAt: null,
  unreadTaskId: null,
  unreadLive: false,
};

function toRunView(activity: ExternalAgentActivity): ExternalAgentRunView {
  return {
    taskId: activity.taskId,
    ...(activity.prompt ? { prompt: activity.prompt } : {}),
    status: activity.status,
    startedAt: activity.startedAt,
    elapsedMs: activity.elapsedMs,
    entries: activity.entries ?? [],
    ...(activity.tail ? { tail: activity.tail } : {}),
    ...(activity.error ? { error: activity.error } : {}),
    ...(activity.trimmedEntries ? { trimmedEntries: activity.trimmedEntries } : {}),
    ...(activity.sourceTruncated ? { sourceTruncated: true } : {}),
    ...(activity.historical ? { historical: true } : {}),
  };
}

/** 同 taskId 替换最后一条（保持前面 run 的对象引用，memo 行不重渲染）。 */
function upsertRun(
  runs: readonly ExternalAgentRunView[],
  activity: ExternalAgentActivity,
): ExternalAgentRunView[] {
  const last = runs.at(-1);
  const next =
    last?.taskId === activity.taskId
      ? [...runs.slice(0, -1), toRunView(activity)]
      : [...runs, toRunView(activity)];
  let start = 0;
  let totalChars = next.reduce(
    (sum, run) => sum + run.entries.reduce((chars, entry) => chars + entry.text.length, 0),
    0,
  );
  // 至少保留当前这一次；超限从最老的一次开始丢。
  while (start < next.length - 1) {
    const oldest = next[start]!;
    const oldestChars = oldest.entries.reduce((chars, entry) => chars + entry.text.length, 0);
    if (next.length - start <= MAX_RUNS && totalChars <= MAX_RUNS_CHARS) break;
    totalChars -= oldestChars;
    start += 1;
  }
  return start > 0 ? next.slice(start) : next;
}

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
 *
 * `cleared`：这一帧的 null 是**服务端明确说的"没有活动"**（冷恢复会补发一条
 * `activity: null` 清掉崩溃/关闭时残留的运行态），而不是"快照没带这个字段"。
 * 显式清空只清一条卡住的 `running`：完成态记录仍然保留（用户还要看上次结果），
 * 字段缺席的过渡帧一律不动。
 */
export function publishExternalAgentActivity(
  sessionId: string,
  activity: ExternalAgentActivity | null,
  options: { replayed?: boolean; cleared?: boolean } = {},
): void {
  if (!sessionId) return;
  const previous = states.get(sessionId);
  const previousActivity = previous?.activity ?? null;
  if (previousActivity === activity) return;
  if (activity === null) {
    // 字段缺席（扩展帧/旧服务端）→ 不动；显式清空 → 只处理卡住的 running。
    if (!options.cleared || previousActivity?.status !== "running") return;
    write(sessionId, EMPTY_STATE);
    return;
  }

  // running → 终态只发生一次：这是唯一产生未读的转换。
  // 历史摘要（冷恢复补发的「上次执行」）不是一次实时完成，绝不刷未读点。
  const settledNow =
    previousActivity !== null &&
    previousActivity.status === "running" &&
    activity.status !== "running" &&
    activity.historical !== true;
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
    runs: upsertRun(previous?.runs ?? [], activity),
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
