import type { ZCodeOracleReviewRecord } from "@zcode/shared";
import type { OracleReviewState } from "./oracleReviewSupport.js";

/**
 * 审查卡片的模块级状态仓：按 v4 sessionId 键控，**跨会话切换与组件重挂载存活**。
 *
 * 之前状态放在 useOracleReview 的 useState 里：切换会话会触发清空 effect，且
 * SessionPane 重挂载后旧实例的 React state 全部作废——进行中的审查请求闭包虽然
 * 还在跑，结果却写回了已卸载的实例，表现为「切走再切回，卡片没了、结果也收不到」。
 * 把状态搬进 store 后，请求闭包写的是模块级条目，重挂载的 hook 重新订阅即恢复；
 * 请求代次守卫也一并搬进来，跨重挂载仍能作废过期请求的写回。
 *
 * v2 追加**持久历史的内存投影**：终态结果经 session entry 落盘（CLI 侧），会话
 * 加载时种入 histories；重启/刷新后最新结果恢复为「已恢复」结果卡片。运行中的
 * pending 与 error **都不落盘**（持久 schema 只接受终态结果记录）：进程中断后
 * 无法续跑，恢复时该卡片不会重现，也没有「可重试错误」卡片可恢复——用户需重新
 * 发起审查（历史里已有的终态结果不受影响）。
 *
 * 纯内存（Map 随会话数增长，条目极小）；状态回到 idle 时删除状态条目以收敛内存。
 * 代次条目（seqs）**有意**不随 idle 清理：守卫要求每会话代次严格单调——若 idle
 * 时删除，新请求会从 1 重新计数，与仍在飞行的旧请求（代次同为 1）碰撞，过期写回
 * 反而重新生效。
 */

const ORACLE_REVIEW_IDLE: OracleReviewState = { status: "idle" };

type OracleReviewListener = (state: OracleReviewState) => void;

const states = new Map<string, OracleReviewState>();
const listeners = new Map<string, Set<OracleReviewListener>>();
const seqs = new Map<string, number>();

// 历史投影：completedAt 降序，最新优先；每会话有界保留。
export const ORACLE_REVIEW_HISTORY_LIMIT = 10;

const histories = new Map<string, ZCodeOracleReviewRecord[]>();
const seededSessions = new Set<string>();

export function getOracleReviewState(sessionId: string | null): OracleReviewState {
  // 缺省值用模块级常量：useSyncExternalStore 要求 getSnapshot 引用稳定，
  // 每次新建对象会触发无限重渲染。
  return (sessionId !== null && states.get(sessionId)) || ORACLE_REVIEW_IDLE;
}

export function setOracleReviewState(sessionId: string, next: OracleReviewState): void {
  // idle 不占位（get 的缺省即 idle），条目数与会话内活跃卡片数一致。
  if (next.status === "idle") {
    states.delete(sessionId);
  } else {
    states.set(sessionId, next);
  }
  const sessionListeners = listeners.get(sessionId);
  if (sessionListeners) {
    for (const listener of [...sessionListeners]) {
      listener(next);
    }
  }
}

/** 订阅某会话的状态变化；返回退订函数。重复退订安全。 */
export function subscribeOracleReviewState(
  sessionId: string | null,
  listener: OracleReviewListener,
): () => void {
  if (sessionId === null) {
    return () => {};
  }
  let sessionListeners = listeners.get(sessionId);
  if (!sessionListeners) {
    sessionListeners = new Set();
    listeners.set(sessionId, sessionListeners);
  }
  sessionListeners.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(sessionId);
    }
  };
}

/** 取该会话的下一个请求代次；调用方持有返回值用于 applyIfCurrent 守卫。 */
export function nextOracleReviewSeq(sessionId: string): number {
  const seq = (seqs.get(sessionId) ?? 0) + 1;
  seqs.set(sessionId, seq);
  return seq;
}

/** 作废该会话当前在飞请求的写回（dismiss 用）：只推代号次，不开启新请求。 */
export function invalidateOracleReviewSeq(sessionId: string): void {
  seqs.set(sessionId, (seqs.get(sessionId) ?? 0) + 1);
}

export function isCurrentOracleReviewSeq(sessionId: string, seq: number): boolean {
  return seqs.get(sessionId) === seq;
}

// ── 历史投影（持久记录的内存镜像）──

export function getOracleReviewHistory(sessionId: string): readonly ZCodeOracleReviewRecord[] {
  return histories.get(sessionId) ?? [];
}

/** 追加一条终态记录（同 reviewId 去重，completedAt 降序，有界保留）。 */
export function appendOracleReviewHistory(
  sessionId: string,
  record: ZCodeOracleReviewRecord,
): void {
  const existing = histories.get(sessionId) ?? [];
  const merged = [record, ...existing.filter((entry) => entry.reviewId !== record.reviewId)];
  merged.sort((a, b) => b.completedAt - a.completedAt);
  histories.set(
    sessionId,
    merged.length > ORACLE_REVIEW_HISTORY_LIMIT
      ? merged.slice(0, ORACLE_REVIEW_HISTORY_LIMIT)
      : merged,
  );
}

/** 会话加载时种入持久记录（空数组也标记已种，避免每次挂载重查）。 */
export function seedOracleReviewHistory(
  sessionId: string,
  records: readonly ZCodeOracleReviewRecord[],
): void {
  const existing = histories.get(sessionId) ?? [];
  const merged = [...records, ...existing.filter((entry) => !records.some((r) => r.reviewId === entry.reviewId))];
  merged.sort((a, b) => b.completedAt - a.completedAt);
  histories.set(
    sessionId,
    merged.length > ORACLE_REVIEW_HISTORY_LIMIT
      ? merged.slice(0, ORACLE_REVIEW_HISTORY_LIMIT)
      : merged,
  );
  seededSessions.add(sessionId);
}

export function hasOracleReviewHistoryBeenSeeded(sessionId: string): boolean {
  return seededSessions.has(sessionId);
}

/**
 * 会话加载时挑「可恢复」的记录：最新一条**未被用户确认**的。
 * 已确认（✕ 关闭 / 按建议处理落盘 acknowledgedAt）的记录不再恢复，否则被关掉的卡片
 * 每次重启都会重新弹出；records 由 CLI 按 completedAt 降序返回。
 */
export function selectRestorableOracleReviewRecord(
  records: readonly ZCodeOracleReviewRecord[],
): ZCodeOracleReviewRecord | undefined {
  return records.find((record) => record.acknowledgedAt === undefined);
}

/** 持久记录 → 「已恢复」结果卡片状态（仅 result 记录可恢复；error/pending 不落盘）。 */
export function oracleReviewRecordToRestoredResult(
  record: ZCodeOracleReviewRecord,
): OracleReviewState {
  return {
    status: "result",
    mode: record.mode,
    reviewId: record.reviewId,
    turnRowId: record.target.rowId,
    entityId: record.target.entityId,
    verdict: record.verdict,
    summary: record.summary,
    findings: record.findings,
    ...(record.requirements ? { requirements: record.requirements } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.limits ? { limits: record.limits } : {}),
    modelLabel: record.modelLabel,
    depth: record.depth,
    completedAt: record.completedAt,
    restored: true,
  };
}

/** 测试隔离：清空全部内存态（states/histories/seqs/seed 标记）。 */
export function clearOracleReviewStoreForTests(): void {
  states.clear();
  listeners.clear();
  seqs.clear();
  histories.clear();
  seededSessions.clear();
}
