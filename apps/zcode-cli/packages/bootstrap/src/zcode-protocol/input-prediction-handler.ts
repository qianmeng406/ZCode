// v4/conversation/inputPrediction 的 CLI 侧处理器（手机远控 ghost hint + 桌面候选胶囊）。
// 规格：docs/web-remote-control/mobile-input-prediction.md。
//
// 2026-11-01 重构：预测不再由本处理器独立调模型——主轮请求（开启输入预测时注入
// 指令）的输出尾部携带 <next_input> 候选块，turn-model-step 解析后存入
// runtime.lastInputPrediction；这里只读存量并按草稿过滤。因此：
// - 没有进行中的模型调用，inFlight/abort 只保留壳（语义上等价于即时返回）；
// - 会话没有存量预测 → suppress_below_threshold；runtime 缺席 → unavailable。
// 只读、不做 CAS：预测是建议，不是状态。
import type { Logger, SessionId } from "@zcode/contracts";
import { decideInputPrediction, normalizeInputPredictionDraft } from "@zcode/core";
import {
  emptyInputPredictionResult,
  v4ConversationInputPredictionParamsSchema,
  type V4ConversationInputPredictionResult,
} from "@zcode/shared/zcode-protocol-v4";

/** 终态结果缓存条数（跨会话共享）。 */
const INPUT_PREDICTION_CACHE_MAX_ENTRIES = 16;

/** runtime 上最近一轮主链路输出的预测候选（见 AgentRuntime.getLastInputPrediction）。 */
export interface StoredInputPrediction {
  candidates: { text: string; confidence: number }[];
  completedAt: number;
}

export interface ConversationInputPredictionHandlerDeps {
  /** 读取该会话最近一次主轮输出的预测候选；runtime 缺席返回 null。 */
  getLastPrediction(sessionId: string): StoredInputPrediction | null;
  logger?: Logger;
}

type CachedResult = Omit<V4ConversationInputPredictionResult, "requestId">;

export class ConversationInputPredictionHandler {
  private readonly cache = new Map<string, CachedResult>();

  constructor(private readonly deps: ConversationInputPredictionHandlerDeps) {}

  async handle(rawParams: unknown): Promise<V4ConversationInputPredictionResult> {
    const params = v4ConversationInputPredictionParamsSchema.parse(rawParams);
    const { sessionId, requestId } = params;
    const draft = normalizeInputPredictionDraft(params.draft);
    const cacheKey = JSON.stringify([sessionId, params.revision, draft]);
    const withRequestId = (result: CachedResult): V4ConversationInputPredictionResult =>
      requestId === undefined ? result : { ...result, requestId };

    const cached = this.cache.get(cacheKey);
    if (cached) {
      // LRU 触碰。
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return withRequestId(cached);
    }

    const result = this.predict(sessionId, draft);
    if (result.decision !== "unavailable") this.remember(cacheKey, result);
    return withRequestId(result);
  }

  /** 连接断开 / 进程关闭：无在途预测，缓存随进程生命周期。 */
  dispose(_reason?: unknown): void {
    this.cache.clear();
  }

  private predict(sessionId: string, draft: string): CachedResult {
    let prediction: StoredInputPrediction | null;
    try {
      prediction = this.deps.getLastPrediction(sessionId);
    } catch (error) {
      this.warn("lookup_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable");
    }
    if (!prediction) return emptyInputPredictionResult("unavailable");
    // draft 非空 = 续写模式：只有以草稿开头的候选才能接在草稿后面，其余丢弃。
    // decide 复用收敛规则：钳制置信度、剥草稿前缀、同文本去重、门槛决策。
    // turnCount 传足够大：存量预测本身就是「上下文足够」的产物，不再做轮数门槛。
    const usable = draft
      ? prediction.candidates.filter((candidate) => candidate.text.startsWith(draft))
      : prediction.candidates;
    return decideInputPrediction({
      rawCandidates: usable,
      draft,
      recentUserInputs: [],
      turnCount: Number.MAX_SAFE_INTEGER,
    });
  }

  private remember(cacheKey: string, result: CachedResult): void {
    this.cache.set(cacheKey, result);
    while (this.cache.size > INPUT_PREDICTION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private warn(reason: string, sessionId: string, error: unknown): void {
    // 只记错误类型与消息，绝不记草稿和会话内容。
    this.deps.logger?.warn("v4 input prediction degraded", {
      event: `zcode_protocol.v4.input_prediction_${reason}`,
      module: "bootstrap.zcode_protocol",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
