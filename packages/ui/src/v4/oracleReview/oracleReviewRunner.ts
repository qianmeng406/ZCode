import type { ModelSelection } from "@zcode/shared";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";
import type { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  isOracleDeadlineTimeoutError,
  ORACLE_DEEP_REVIEW_QUERY_SOURCE,
  ORACLE_DEEP_REVIEW_TIMEOUT_MS,
  ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
  resolveOracleRequestOptions,
  type OracleReviewDepth,
  type OracleReviewRequest,
  type OracleReviewRequestMode,
  type OracleReviewState,
} from "./oracleReviewSupport.js";
import {
  findTurnHeaderByRef,
  isOracleReviewableTurnState,
  renderOracleTurnMaterialText,
  type OracleReviewTargetRef,
} from "./oracleReviewMaterial.js";
import { renderOracleContextAnalysis } from "./oracleReviewContextAnalysis.js";
import { buildOracleReviewPrompt } from "./oracleReviewPrompt.js";
import { parseOracleVerdict } from "./oracleReviewVerdict.js";
import { findLastReviewableTurnHeader } from "./oracleReviewPendingProgress.js";
import {
  analyzeOracleReviewContext,
  CONTEXT_ANALYSIS_ERROR_NAME,
  gatherOracleTurnEvidence,
  persistOracleReviewRecord,
} from "./oracleReviewGather.js";
import {
  appendOracleReviewHistory,
  getOracleReviewState,
  isCurrentOracleReviewSeq,
  nextOracleReviewSeq,
  setOracleReviewState,
} from "./oracleReviewStore.js";

/**
 * 审查执行编排（从 useOracleReview 拆出；材料/分析/持久化在 oracleReviewGather）。
 *
 * v2 流水：collecting 取材料 → analyzing 上下文分析（独立 querySource/operationId）
 * → reviewing 正式审查。standard = 单轮对话审查；deep = 跨轮任务审查（只读取证）。
 * diff 只是辅助证据，纯对话回合同样可审。闭包持有发起时的会话 id：写回永远落在
 * 发起会话的 store 条目，切走再切回仍能收到结果。
 */

export function createReviewId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type OracleServices = ReturnType<typeof useOptionalServices>;

export async function runOracleReview(
  deps: {
    services: OracleServices | null;
    snapshot: ConversationSnapshot;
    workspaceArgs: {
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    };
    oracleModel: ModelSelection | null;
    modelSelectionView?: ModelSelectionView | null;
    /** 自动审查去重：返回 false 表示该回合已审过（本次跳过）。 */
    claimAutoReview: (rowId: number) => boolean;
  },
  input: {
    mode: OracleReviewRequestMode;
    depth: OracleReviewDepth;
    /** 手动新请求的目标轮（composer 默认最近可审轮 / 轮尾指定轮）。 */
    header?: TurnHeaderRow;
    /** 重试：锁定原请求（同目标/同深度），仅换新 reviewId。 */
    retryOf?: OracleReviewRequest;
  },
): Promise<void> {
  const agentService = deps.services?.zcodeAgentService;
  if (!agentService) {
    return;
  }
  const sid = deps.snapshot.sessionId;
  if (getOracleReviewState(sid).status === "pending") {
    // 单横幅设计：审查进行中重复点击静默忽略（留痕避免「点了没反应」无从排查）。
    logger.info("[OracleReview] 已有审查在进行中，忽略本次请求", {
      mode: input.mode,
      depth: input.depth,
      sessionKey: sid,
    });
    return;
  }
  const workspaceArgs = deps.workspaceArgs;
  // ── 锁定审查请求 ──
  let request: OracleReviewRequest;
  if (input.retryOf) {
    request = { ...input.retryOf, reviewId: createReviewId(), createdAt: Date.now() };
    logger.info("[OracleReview] 按原请求重试审查", {
      reviewId: request.reviewId,
      retryOfReviewId: input.retryOf.reviewId,
      turnRowId: request.target.rowId,
      depth: request.depth,
    });
  } else {
    const header = input.header ?? findLastReviewableTurnHeader(deps.snapshot);
    if (!header || !header.entityId) {
      setOracleReviewState(sid, {
        status: "error",
        mode: input.mode,
        failure: { kind: "no-turn" },
        depth: input.depth,
      });
      return;
    }
    // 自动把关每回合至多一次；手动不受限（重审同一回合是明确意图）。
    if (input.mode === "auto" && !deps.claimAutoReview(header.rowId)) {
      return;
    }
    const target: OracleReviewTargetRef = {
      rowId: header.rowId,
      entityId: header.entityId,
      ...(header.productTurnId ? { productTurnId: header.productTurnId } : {}),
    };
    request = {
      reviewId: createReviewId(),
      depth: input.depth,
      mode: input.mode,
      sessionId: sid,
      ...workspaceArgs,
      target,
      ...(deps.snapshot.revision !== undefined ? { revision: deps.snapshot.revision } : {}),
      ...(deps.snapshot.logEpoch !== undefined ? { logEpoch: deps.snapshot.logEpoch } : {}),
      createdAt: Date.now(),
    };
  }
  // 重试请求的目标在重写/分支切换后已不可寻且终态不再可审 → stale。
  const currentHeader = findTurnHeaderByRef(deps.snapshot.rows.window, request.target);
  if (currentHeader && !isOracleReviewableTurnState(currentHeader.state)) {
    setOracleReviewState(sid, {
      status: "error",
      mode: request.mode,
      reviewId: request.reviewId,
      request,
      failure: {
        kind: "stale-target",
        message: `目标回合已处于 ${currentHeader.state} 状态（可能在运行中或已被重写）`,
      },
      depth: request.depth,
    });
    return;
  }
  const requestOptions = resolveOracleRequestOptions(deps.oracleModel, deps.modelSelectionView);
  if (!requestOptions) {
    setOracleReviewState(sid, {
      status: "error",
      mode: request.mode,
      failure: { kind: "no-model" },
      depth: request.depth,
    });
    return;
  }
  const pendingModelLabel = `${requestOptions.selection.providerId}/${requestOptions.selection.modelId}`;
  logger.info("[OracleReview] 发起审查", {
    reviewId: request.reviewId,
    mode: request.mode,
    depth: request.depth,
    turnRowId: request.target.rowId,
  });
  setOracleReviewState(sid, {
    status: "pending",
    mode: request.mode,
    reviewId: request.reviewId,
    startedAt: Date.now(),
    stage: "collecting",
    modelLabel: pendingModelLabel,
    depth: request.depth,
    request,
  });
  const requestSeq = nextOracleReviewSeq(sid);
  const applyIfCurrent = (next: OracleReviewState) => {
    if (isCurrentOracleReviewSeq(sid, requestSeq)) {
      setOracleReviewState(sid, next);
    }
  };
  // 阶段推进：仅当仍是本请求的 pending 时合并（迟到写回被 seq 守卫拦截）。
  const setStage = (stage: "collecting" | "analyzing" | "reviewing", operationId: string) => {
    const current = getOracleReviewState(sid);
    if (current.status === "pending" && isCurrentOracleReviewSeq(sid, requestSeq)) {
      setOracleReviewState(sid, {
        ...current,
        stage,
        operationId,
        // 新阶段开始：上一阶段的轮次/工具线索随之清空。
        round: undefined,
        toolName: undefined,
        toolTarget: undefined,
        toolEvents: [],
      });
    }
  };
  try {
    // ── 阶段一：取材料 ──
    const evidence = await gatherOracleTurnEvidence({
      agentService,
      gitService: deps.services?.gitService,
      snapshot: deps.snapshot,
      workspaceArgs,
      target: request.target,
      reviewId: request.reviewId,
    });
    const { bundle } = evidence;
    const completenessNotes = evidence.completenessNotes;
    if (
      bundle.material.userInputs.length === 0 &&
      bundle.material.assistantTexts.length === 0 &&
      bundle.material.toolCalls.length === 0
    ) {
      // 目标轮没有任何对话内容（controlOnly 或目标失效）：自动把关静默跳过，
      // 手动审查如实报 stale（「无改动」不再是审查拒绝理由，空轮才是）。
      if (request.mode === "auto") {
        logger.info("[OracleReview] 自动把关跳过：目标轮无对话内容", {
          turnRowId: request.target.rowId,
        });
        // 必须过 seq 守卫（与其余终态写回一致）：绕过守卫会在此请求已被 dismiss
        // 作废、且新审查已置 pending 时，把别人的 pending 条目删成 idle。
        applyIfCurrent({ status: "idle" });
        return;
      }
      applyIfCurrent({
        status: "error",
        mode: request.mode,
        reviewId: request.reviewId,
        request,
        failure: {
          kind: "stale-target",
          message: "目标回合没有可审查的对话内容（输入/回复/工具记录均为空）",
        },
        depth: request.depth,
      });
      return;
    }
    // ── 阶段二：上下文分析（独立 querySource/operationId，可独立取消）──
    setStage("analyzing", `${request.reviewId}:context`);
    const analyzed = await analyzeOracleReviewContext({
      agentService,
      snapshot: deps.snapshot,
      workspaceArgs,
      request,
      requestOptions,
      material: bundle.material,
    });
    completenessNotes.push(...analyzed.completenessNotes);
    // ── 阶段三：正式审查 ──
    setStage("reviewing", `${request.reviewId}:review`);
    const prompt = buildOracleReviewPrompt({
      request,
      targetMaterialText: renderOracleTurnMaterialText(
        bundle.material,
        `目标回合 rowId=${request.target.rowId}`,
      ),
      ...(analyzed.priorTurnsText ? { priorTurnsText: analyzed.priorTurnsText } : {}),
      ...(analyzed.analysis
        ? { contextText: renderOracleContextAnalysis(analyzed.analysis) }
        : {}),
      diffSections: evidence.sections,
      ...(evidence.diffSource ? { diffSource: evidence.diffSource } : {}),
      ...(evidence.recentCommits ? { recentCommits: evidence.recentCommits } : {}),
      completenessNotes,
      depth: request.depth,
      ...(analyzed.taskScope ? { taskScope: analyzed.taskScope } : {}),
    });
    const result = await agentService.generateWorkspaceText({
      ...workspaceArgs,
      selection: requestOptions.selection,
      prompt,
      querySource:
        request.depth === "deep"
          ? ORACLE_DEEP_REVIEW_QUERY_SOURCE
          : ORACLE_TURN_REVIEW_QUERY_SOURCE,
      operationId: `${request.reviewId}:review`,
      // 流式传输：一次性请求实测 ~55-60s 无产出被上游掐断；流式思考增量保活。
      stream: true,
      // 深度审查：只读子代理多轮取证（core 忽略单轮 stream 语义，逐轮内部流式）。
      ...(request.depth === "deep"
        ? {
            agentic: true,
            // 软 deadline 随请求下发：调查轮在扣除收尾预留后提前收敛进禁用
            // 工具的收尾轮（hard-abort 之外的 first-line 保障）。
            deadlineAt: Date.now() + ORACLE_DEEP_REVIEW_TIMEOUT_MS,
          }
        : {}),
      ...(requestOptions.maxOutputTokens !== undefined
        ? { maxOutputTokens: requestOptions.maxOutputTokens }
        : {}),
      requestTimeoutMs:
        request.depth === "deep"
          ? ORACLE_DEEP_REVIEW_TIMEOUT_MS
          : ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
    });
    if (!result.text.trim()) {
      // 空正文：thinking 模型在输出预算内没留下可见文本（finishReason 可佐证）。
      logger.warn("[OracleReview] 模型返回空正文", {
        reviewId: request.reviewId,
        turnRowId: request.target.rowId,
        finishReason: result.finishReason ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      });
      applyIfCurrent({
        status: "error",
        mode: request.mode,
        reviewId: request.reviewId,
        request,
        depth: request.depth,
        failure: {
          kind: "empty-response",
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        },
        modelLabel: pendingModelLabel,
      });
      return;
    }
    const parsed = parseOracleVerdict(result.text);
    const completedAt = Date.now();
    logger.info("[OracleReview] 审查完成", {
      reviewId: request.reviewId,
      turnRowId: request.target.rowId,
      verdict: parsed.verdict,
      depth: request.depth,
      providerId: result.selection.providerId,
      model: result.selection.modelId,
      finishReason: result.finishReason ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
    });
    applyIfCurrent({
      status: "result",
      mode: request.mode,
      reviewId: request.reviewId,
      turnRowId: request.target.rowId,
      entityId: request.target.entityId,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      ...(parsed.requirements ? { requirements: parsed.requirements } : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.limits ? { limits: parsed.limits } : {}),
      modelLabel: `${result.selection.providerId}/${result.selection.modelId}`,
      depth: request.depth,
      completedAt,
      request,
    });
    // ── 持久化 + 历史（fire-and-forget；失败不影响结果展示）──
    const record = {
      reviewId: request.reviewId,
      sessionId: sid,
      depth: request.depth,
      mode: request.mode,
      target: request.target,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      ...(parsed.requirements ? { requirements: parsed.requirements } : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.limits ? { limits: parsed.limits } : {}),
      modelLabel: `${result.selection.providerId}/${result.selection.modelId}`,
      createdAt: request.createdAt,
      completedAt,
    };
    appendOracleReviewHistory(sid, record);
    persistOracleReviewRecord(agentService, {
      workspaceArgs,
      sessionId: sid,
      record,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[OracleReview] 审查失败", {
      reviewId: request.reviewId,
      workspacePath: workspaceArgs.workspacePath,
      error: message,
    });
    // 客户端 deadline 到点（协议 client 专属错误类型）：多为渠道限流/深思考
    // 无首 token 的重试循环，干等无好转，给专门文案指引换把关模型。
    const failure =
      (error as Error | undefined)?.name === CONTEXT_ANALYSIS_ERROR_NAME
        ? ({ kind: "context-analysis", message } as const)
        : isOracleDeadlineTimeoutError(error)
          ? ({ kind: "timeout", message } as const)
          : ({ kind: "request", message } as const);
    applyIfCurrent({
      status: "error",
      mode: request.mode,
      reviewId: request.reviewId,
      request,
      failure,
      modelLabel: pendingModelLabel,
      depth: request.depth,
    });
  }
}
