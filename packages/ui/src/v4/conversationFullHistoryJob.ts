// 完整历史加载（loadAllOlder）的需求协调纯逻辑，无 IO、无外部运行时依赖，
// 供 ConversationProjectionStore 与单测共用。
//
// 背景：导航目录 hydration 与分享流程共用同一次全量分页。过去 loadAllOlder 是
// 「先到先得」的全局任务：分享会被在途导航挡成 stale（误标已加载），关闭导航也
// 无法停止已启动的分页。现在每次调用携带一份独立需求（consumer + AbortSignal）：
// 同一会话同一时刻至多一个分页 job，后到 owner 加入在途 job；全部 owner 退出后
// 协作式停止——已发出的一页允许返回，不再请求下一页。

export type ConversationFullHistoryConsumer = "navigator" | "share";

export interface ConversationFullHistoryOwner {
  consumer: ConversationFullHistoryConsumer;
  signal: AbortSignal;
}

export type ConversationFullHistoryJobOutcome =
  | {
      ended: "completed";
      status: "hydrated" | "not-enough-queries" | "retryable-failure";
      logEpoch: string;
      directoryRevision: number;
    }
  | { ended: "aborted" };

/** 一次在途全量补拉 job：多个 owner 共享同一分页循环。 */
export interface ConversationFullHistoryJob {
  initialLogEpoch: string;
  initialBeforeRowId: number;
  directoryRevision: number;
  preserveIncompleteLeadingTurn: boolean;
  owners: Map<string, ConversationFullHistoryOwner>;
  ownersSeq: number;
  /** 收尾即 resolve（含 aborted/retryable-failure）；加入方 await 该 promise。 */
  promise: Promise<ConversationFullHistoryJobOutcome>;
}

/** 是否还有未 abort 的 owner：全部退出后 job 不得再发起下一页请求。 */
export function hasActiveFullHistoryOwner(
  owners: Iterable<ConversationFullHistoryOwner>,
): boolean {
  for (const owner of owners) {
    if (!owner.signal.aborted) return true;
  }
  return false;
}

export function hasShareFullHistoryOwner(
  owners: Iterable<ConversationFullHistoryOwner>,
): boolean {
  for (const owner of owners) {
    if (owner.consumer === "share") return true;
  }
  return false;
}

export type ConversationFullHistoryCommitDecision =
  /** 全部页合并提交，导航与分享都拿到完整历史。 */
  | { commit: true; outcome: "hydrated" }
  /**
   * real-user query < 2 时导航不会渲染 rail，但 preserveIncompleteLeadingTurn
   * 需要首轮补齐 rows 落进投影才能隐藏 rail；提交但终态仍是 not-enough-queries。
   */
  | { commit: true; outcome: "not-enough-queries" }
  /** 单 query 且无需保留首轮：不提交暂存页，避免为不会显示的 rail 常驻全历史。 */
  | { commit: false; outcome: "not-enough-queries" };

/**
 * 全部页取回后的提交裁决。
 * 分享 owner 在途时必须完整提交：分享需要完整可选数据，不能被导航
 * 「不足两条 query 不提交」的优化或终态短路吞掉。
 */
export function decideFullHistoryCommit(params: {
  realUserQueryCount: number;
  preserveIncompleteLeadingTurn: boolean;
  hasShareOwner: boolean;
}): ConversationFullHistoryCommitDecision {
  if (params.hasShareOwner || params.realUserQueryCount >= 2) {
    return { commit: true, outcome: "hydrated" };
  }
  if (params.preserveIncompleteLeadingTurn) {
    return { commit: true, outcome: "not-enough-queries" };
  }
  return { commit: false, outcome: "not-enough-queries" };
}
