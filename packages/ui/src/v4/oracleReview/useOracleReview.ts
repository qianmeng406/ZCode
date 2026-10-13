import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import type {
  OracleReviewController,
  OracleReviewDepth,
  OracleReviewRequest,
  OracleReviewRequestMode,
} from "./oracleReviewSupport.js";
import { useOracleReviewPendingProgress } from "./oracleReviewPendingProgress.js";
import { createReviewId, runOracleReview } from "./oracleReviewRunner.js";
import {
  getOracleReviewState,
  hasOracleReviewHistoryBeenSeeded,
  invalidateOracleReviewSeq,
  oracleReviewRecordToRestoredResult,
  selectRestorableOracleReviewRecord,
  seedOracleReviewHistory,
  setOracleReviewState,
  subscribeOracleReviewState,
} from "./oracleReviewStore.js";
import {
  ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE,
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
} from "./oracleReviewSupport.js";

/**
 * Oracle 双审查的 React 接入层（执行编排拆至 oracleReviewRunner，本文件只保留
 * hook 状态/边沿/生命周期与对外控制面）。
 *
 * - 卡片状态在模块级 store（oracleReviewStore）按会话键控：切换会话/重挂载不丢，
 *   进行中的审查由请求闭包继续推进并写入 store，与本实例是否挂载无关。
 * - 自动把关：running → completedSuccess 边沿触发标准审查（深度审查仅手动，避免
 *   自动成本数倍放大）；失败/中断回合是被审查对象但不进入自动把关（半成品过程）。
 * - 会话加载时种入持久审查历史：最新结果恢复为「已恢复」卡片（仅当无活跃卡片）。
 */

export function useOracleReview(params: {
  snapshot: ConversationSnapshot | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  oracleModel: ModelSelection | null;
  modelSelectionView?: ModelSelectionView | null;
}) {
  const { settings } = useSettings();
  const enabled = settings?.oracleReviewEnabled ?? false;
  const services = useOptionalServices();
  const sessionId = params.snapshot?.sessionId ?? null;
  // useSyncExternalStore 是外部 store 的规范接法：无并发撕裂窗口，
  // getSnapshot 返回 store 内的稳定引用（idle 为模块级常量）。
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeOracleReviewState(sessionId, onStoreChange),
    [sessionId],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => getOracleReviewState(sessionId),
    () => getOracleReviewState(null),
  );
  // 边沿检测：上一帧 phase；null 表示尚无基线（首帧/会话切换后不触发）。
  const prevPhaseRef = useRef<string | null>(null);
  const autoReviewedTurnRowIdsRef = useRef(new Set<number>());
  // snapshot 随流式每帧换新对象；编排走 ref 读取，回调身份只随稳定依赖变化
  // （重建回调会打断边沿检测基线）。
  const snapshotRef = useRef(params.snapshot);
  snapshotRef.current = params.snapshot;
  const servicesRef = useRef(services);
  servicesRef.current = services;

  // 边沿基线与自动审查去重随会话切换重置（状态本身不清空——store 持有各会话卡片）。
  useEffect(() => {
    prevPhaseRef.current = null;
    autoReviewedTurnRowIdsRef.current = new Set();
  }, [sessionId]);

  const startReview = useCallback(
    (input: {
      mode: OracleReviewRequestMode;
      depth: OracleReviewDepth;
      header?: TurnHeaderRow;
      retryOf?: OracleReviewRequest;
    }) => {
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      void runOracleReview(
        {
          services: servicesRef.current,
          snapshot,
          workspaceArgs: {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          },
          oracleModel: params.oracleModel,
          modelSelectionView: params.modelSelectionView,
          claimAutoReview: (rowId: number) => {
            if (autoReviewedTurnRowIdsRef.current.has(rowId)) return false;
            autoReviewedTurnRowIdsRef.current.add(rowId);
            return true;
          },
        },
        input,
      );
    },
    [
      params.modelSelectionView,
      params.oracleModel,
      params.remoteSessionId,
      params.workspaceIdentity,
      params.workspacePath,
    ],
  );

  // 自动把关：running → completedSuccess 边沿触发。
  const phase = params.snapshot?.control.phase ?? null;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (prev === null || prev === phase || phase !== "completedSuccess") {
      return;
    }
    if (!enabledRef.current) {
      return;
    }
    startReview({ mode: "auto", depth: "standard" });
  }, [phase, startReview]);

  // pending 期间的等待计时与流式进度订阅（从主 hook 拆出控制行数）。
  const { pendingElapsedSeconds, pendingOutputChars } = useOracleReviewPendingProgress({
    state,
    services,
    workspacePath: params.workspacePath,
    sessionId,
  });

  // 会话加载时种入持久审查历史（每会话至多一次；最新结果恢复为「已恢复」卡片，
  // 仅当该会话没有活跃卡片——不打断进行中的审查或用户正在看的错误）。
  useEffect(() => {
    if (sessionId === null) {
      return;
    }
    const agentService = servicesRef.current?.zcodeAgentService;
    if (!agentService || typeof agentService.listOracleReviewRecords !== "function") {
      // 存储面缺席（旧宿主）也标记已种，避免每次挂载重查。
      seedOracleReviewHistory(sessionId, []);
      return;
    }
    if (hasOracleReviewHistoryBeenSeeded(sessionId)) {
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const result = await agentService.listOracleReviewRecords({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          sessionId,
          limit: 10,
        });
        if (disposed) return;
        const records = result.unavailable ? [] : result.records;
        seedOracleReviewHistory(sessionId, records);
        // 只恢复**未确认**的最新记录：用户 ✕ 关闭或按建议处理过的审查已经落盘确认，
        // 无条件恢复会让被关掉的卡片每次重启都重新弹出。
        const restorable = selectRestorableOracleReviewRecord(records);
        if (restorable && getOracleReviewState(sessionId).status === "idle") {
          setOracleReviewState(sessionId, oracleReviewRecordToRestoredResult(restorable));
        }
      } catch (error) {
        if (disposed) return;
        logger.warn("[OracleReview] 审查历史恢复失败", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        seedOracleReviewHistory(sessionId, []);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [sessionId, params.workspacePath, params.workspaceIdentity, params.remoteSessionId]);

  const manualReview = useCallback(() => {
    startReview({ mode: "manual", depth: "standard" });
  }, [startReview]);

  const deepReview = useCallback(() => {
    startReview({ mode: "manual", depth: "deep" });
  }, [startReview]);

  // 轮尾工具栏「审查这一回合」：按钮只在可审终态回合渲染，这里不再重复校验。
  const reviewTurnHeader = useCallback(
    (header: TurnHeaderRow) => {
      startReview({ mode: "manual", depth: "standard", header });
    },
    [startReview],
  );

  const reviewTurnHeaderDeep = useCallback(
    (header: TurnHeaderRow) => {
      startReview({ mode: "manual", depth: "deep", header });
    },
    [startReview],
  );

  // 按原请求重试（错误/结果卡片共用）：同目标、同深度，不重选「最近成功轮」；
  // 无锁定请求（请求前早退的错误）时退化为对最近可审轮的手动标准审查。
  const retryReview = useCallback(() => {
    const current = getOracleReviewState(sessionId);
    const request =
      current.status === "error" || current.status === "result" ? current.request : undefined;
    if (request) {
      startReview({ mode: "manual", depth: request.depth, retryOf: request });
      return;
    }
    startReview({ mode: "manual", depth: "standard" });
  }, [startReview, sessionId]);

  const acknowledge = useCallback(() => {
    if (sessionId === null) {
      return;
    }
    const current = getOracleReviewState(sessionId);
    const reviewId = "reviewId" in current ? current.reviewId : undefined;
    if (!reviewId) {
      return;
    }
    const agentService = servicesRef.current?.zcodeAgentService;
    if (!agentService?.acknowledgeOracleReviewRecord || !params.workspacePath) {
      return;
    }
    void agentService
      .acknowledgeOracleReviewRecord({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        sessionId,
        reviewId,
      })
      .catch((error: unknown) => {
        // best-effort：落盘失败最多导致下次重启再弹一次，不该打断关闭/修复动作。
        logger.warn("[OracleReview] 审查确认落盘失败", {
          sessionId,
          reviewId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [sessionId, params.workspacePath, params.workspaceIdentity, params.remoteSessionId]);

  const dismiss = useCallback(() => {
    // 只清当前查看会话的卡片；其他会话的存量卡片（含进行中的审查）不受影响。
    if (sessionId === null) {
      return;
    }
    const current = getOracleReviewState(sessionId);
    // ✕ = 用户明确确认这条审查（不需要/已看过）并落盘，否则重启后会被当成
    // 「未确认的恢复候选」再弹一次。
    acknowledge();
    // 作废该会话在飞请求的写回：dismiss 即用户明确不想要这张卡片，
    // 进行中的审查完成后不再把卡片顶回来（代次被推高，applyIfCurrent 失效）。
    invalidateOracleReviewSeq(sessionId);
    setOracleReviewState(sessionId, { status: "idle" });
    // ✕ 同时真取消在飞请求。按锁定请求的 reviewId 派生两个阶段的 operationId
    // 精确取消（上下文分析 + 正式审查）；reviewId 缺席（理论不可达）退回按
    // querySource 的旧键 best-effort。取消失败不影响卡片清理。
    const agentService = servicesRef.current?.zcodeAgentService;
    if (!agentService?.cancelWorkspaceGenerateText || !params.workspacePath) {
      return;
    }
    const reviewId =
      current.status === "idle" ? undefined : "reviewId" in current ? current.reviewId : undefined;
    const cancelArgs = {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
    };
    if (reviewId) {
      for (const suffix of ["context", "review"] as const) {
        void agentService
          .cancelWorkspaceGenerateText({
            ...cancelArgs,
            querySource:
              suffix === "context"
                ? ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE
                : ORACLE_TURN_REVIEW_QUERY_SOURCE,
            operationId: `${reviewId}:${suffix}`,
          })
          .catch((error: unknown) => {
            logger.warn("[OracleReview] ✕ 取消在飞审查失败", {
              sessionId,
              operationId: `${reviewId}:${suffix}`,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return;
    }
    // 无 reviewId（请求前早退的 no-turn/no-model 错误卡，或已 idle）：该卡片本就
    // 没有在飞请求。这里刻意**不做**按 querySource 的模糊取消——那种取消会命中
    // 同 workspace 另一会话的同键请求（串杀）；精确取消必须带 operationId。
    logger.debug(undefined, "[OracleReview] dismiss 无 reviewId，跳过取消", { sessionId });
  }, [
    sessionId,
    params.workspacePath,
    params.workspaceIdentity,
    params.remoteSessionId,
    acknowledge,
  ]);

  return {
    state,
    enabled,
    pendingElapsedSeconds,
    pendingOutputChars,
    manualReview,
    deepReview,
    reviewTurnHeader,
    reviewTurnHeaderDeep,
    retryReview,
    dismiss,
    acknowledge,
  };
}

// 模型偏好类型沿用 support 的公开面（签名见文件头部 params）。
export type { OracleReviewController } from "./oracleReviewSupport.js";
export { createReviewId };
