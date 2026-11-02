// v4/conversation/inputPrediction 的 CLI 侧处理器（手机远控 ghost hint + 桌面候选胶囊）。
// 规格：docs/web-remote-control/mobile-input-prediction.md。
//
// 2026-11-02 重写：候选由**独立辅助请求**生成，不再向主轮对话注入任何指令
// （注入方案会把指令泄漏成用户消息并污染每轮主请求）。设计对齐 Claude Code
// 的 prompt suggestions：回复结束后由客户端触发一次短请求，复用会话上下文，
// 结果用完即弃、不写任何对话轨迹。
//
// 成本门禁（任一命中都不发请求，直接返回空闲决策）：
// - 材料不足 2 轮（预测没有依据）；
// - 会话正在执行（上下文还在变）；
// - 上次 main 请求缓存未命中（cache 冷 = 请求要全量计价，收益不抵成本）。
// 只读、不做 CAS：预测是建议，不是状态。
import type { Logger, ModelSelection } from "@zcode/contracts";
import {
  decideInputPrediction,
  normalizeInputPredictionDraft,
  parseInputPredictionResponse,
} from "@zcode/core";
import {
  emptyInputPredictionResult,
  v4ConversationInputPredictionParamsSchema,
  type V4ConversationInputPredictionResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildRecentTurnsTranscript,
  INPUT_PREDICTION_MATERIAL_TURNS,
} from "./input-prediction-context.js";
import type { SessionTranscriptMessage } from "../session-transcript.js";

/** 终态结果缓存条数（跨会话共享）。 */
const INPUT_PREDICTION_CACHE_MAX_ENTRIES = 16;
/** 预测请求的超时：它是"快进快出"的提示，超时就当没有。 */
const INPUT_PREDICTION_REQUEST_TIMEOUT_MS = 8_000;
/** 预测输出预算：三条短候选远小于此，仅作上限。 */
const INPUT_PREDICTION_MAX_OUTPUT_TOKENS = 512;
/** 门禁：材料至少要覆盖两轮对话才值得预测。 */
const INPUT_PREDICTION_MIN_TURNS = 2;

// 草稿为空：预测下一条完整输入。
const NEXT_INPUT_SYSTEM_PROMPT = `你是输入预测器。根据下面的对话上下文，预测这位用户下一条可能发送的输入。

这是预测任务，不是对话。绝不要回答、执行或延续对话内容；只输出预测结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- 每个候选是一句用户自己会说的话（追问、指令、确认等语气），单行，不超过 40 个字，语言与用户一致，不要像助手的回复。
- 候选之间要有区分度：覆盖不同的意图方向（如追问细节 / 提出新指令 / 确认推进），不要只是换个说法。
- 不要预测与上下文里用户最近已发送内容雷同的输入；那类候选会被丢弃。
- 只基于给出的材料；材料开头的省略标记表示更早内容未提供。
- 每个候选带 confidence（0 到 1）：你对"用户真的会这样写"的把握。校准比乐观重要，拿不准就给低分。
- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字：
{"candidates":[{"text":"...","confidence":0.0},{"text":"...","confidence":0.0},{"text":"...","confidence":0.0}]}`;

// 草稿非空：预测草稿后面要接上的部分。
const DRAFT_SYSTEM_PROMPT = `你是输入补全器。根据下面的对话上下文和用户正在输入的草稿，预测用户接下来要在草稿后面接着写的内容。

这是补全任务，不是对话。绝不要回答、执行或延续对话内容；只输出补全结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- text 只写接在草稿末尾之后的新内容，不要重复草稿本身；单行，不超过 40 个字，语言与草稿一致。
- 如果草稿末尾是半个词，text 从这个词剩下的部分开始写。
- 候选之间要有区分度，不要只是换个说法。
- 只基于给出的材料；材料开头的省略标记表示更早内容未提供。
- 每个候选带 confidence（0 到 1）：你对"用户真的会这样接"的把握。校准比乐观重要，拿不准就给低分。
- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字：
{"candidates":[{"text":"...","confidence":0.0},{"text":"...","confidence":0.0},{"text":"...","confidence":0.0}]}`;

/** 门禁事实：由 bootstrap 从会话记录/运行时读取。 */
export interface InputPredictionGate {
  /** 上次 main 请求读到的缓存 token 数；0 = 缓存冷。 */
  cacheReadTokens: number;
  /** 会话当前是否在执行（含队列等待）。 */
  busy: boolean;
  /** 本会话生效的模型选择；缺席 = 没有可用模型。 */
  selection?: ModelSelection;
}

export interface ConversationInputPredictionHandlerDeps {
  /** 读该会话的可见转录（不含 model-only 系统提醒）。 */
  loadTranscript(sessionId: string): Promise<readonly SessionTranscriptMessage[]>;
  /** 读门禁事实；会话不在内存时返回 null。 */
  readGate(sessionId: string): InputPredictionGate | null;
  /** 发一次辅助模型请求（in-process，不新开 RPC 通道）。 */
  generate(input: {
    sessionId: string;
    selection: ModelSelection;
    system: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
    operationId: string;
  }): Promise<{ text: string }>;
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

    const result = await this.predict(sessionId, draft);
    // 只缓存"真的问过模型"的结果：门禁跳过的结果必须每次重判，
    // 否则会话接下来的进展（缓存转盛）会被旧结论挡住。
    if (result.decision === "show" || result.decision === "suppress_below_threshold") {
      this.remember(cacheKey, result);
    }
    return withRequestId(result);
  }

  /** 连接断开 / 进程关闭：在途请求随 abortSignal 结束，缓存随进程生命周期。 */
  dispose(_reason?: unknown): void {
    this.cache.clear();
  }

  private async predict(sessionId: string, draft: string): Promise<CachedResult> {
    let gate: InputPredictionGate | null;
    try {
      gate = this.deps.readGate(sessionId);
    } catch (error) {
      this.warn("gate_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable");
    }
    if (!gate) return emptyInputPredictionResult("unavailable");
    // 会话正在执行：上下文还在变，此刻预测必然指向一个过期的状态。
    if (gate.busy) return emptyInputPredictionResult("suppress_no_context");
    // 缓存冷：请求要全量计价，而预测收益极小（对齐 Claude Code 的跳过条件）。
    if (gate.cacheReadTokens <= 0) return emptyInputPredictionResult("suppress_no_context");
    if (!gate.selection) return emptyInputPredictionResult("unavailable");

    let material: ReturnType<typeof buildRecentTurnsTranscript>;
    try {
      material = buildRecentTurnsTranscript(await this.deps.loadTranscript(sessionId), {
        maxTurns: INPUT_PREDICTION_MATERIAL_TURNS,
      });
    } catch (error) {
      this.warn("transcript_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable");
    }
    if (material.turnCount < INPUT_PREDICTION_MIN_TURNS) {
      return emptyInputPredictionResult("suppress_no_context");
    }

    let generated: { text: string };
    try {
      generated = await this.deps.generate({
        sessionId,
        selection: gate.selection,
        system: draft ? DRAFT_SYSTEM_PROMPT : NEXT_INPUT_SYSTEM_PROMPT,
        prompt: draft ? `${material.text}\n\n## 用户正在输入的草稿\n${draft}` : material.text,
        timeoutMs: INPUT_PREDICTION_REQUEST_TIMEOUT_MS,
        maxOutputTokens: INPUT_PREDICTION_MAX_OUTPUT_TOKENS,
        operationId: `input-prediction:${sessionId}`,
      });
    } catch (error) {
      // 预测是建议，不是状态：超时/失败一律静默。
      this.warn("generate_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable");
    }

    const raw = parseInputPredictionResponse(generated.text);
    if (!raw) return emptyInputPredictionResult("suppress_below_threshold");

    // 草稿非空 = 续写模式：只有以草稿开头的候选才能接在草稿后面，其余丢弃。
    // 必须在 decide 之前过滤——decide 内的 toInputPredictionSuffix 会剥掉草稿
    // 前缀，剥完就判断不了"原本是否以草稿开头"。
    const usable = draft ? raw.filter((candidate) => candidate.text.startsWith(draft)) : raw;

    // decide 负责：钳制置信度、剥草稿前缀、指令回显过滤、同文本去重、门槛决策。
    // recentUserInputs 传空集——去重基准是"用户最近发过的输入"，
    // 而这里的 raw 已经来自独立的辅助请求，不会与主对话内容重复。
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
