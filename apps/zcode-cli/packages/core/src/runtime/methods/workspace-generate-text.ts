import {
  SessionEventType,
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Model,
  ModelInputMessage,
  ModelSelection,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { normalizeStreamError } from "../helpers/index.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { runDeepReviewAgentLoop } from "./workspace-deep-review.js";

const WORKSPACE_GENERATE_TEXT_TIMEOUT_MS = 60_000;
// 流事件静默看门狗：上游对无产出连接按「每次尝试约 60s 被掐 + 退避重试」处理
// （实测日志：单条审查请求烧满 600s 客户端 deadline 才失败）。阈值取 2 倍静默窗口，
// 连续两分钟没有任何事件即判为无产出循环，提前中止，把 10 分钟的浪费压到 2 分钟。
const MODEL_STREAM_STALL_TIMEOUT_MS = 120_000;
const CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS = 1;
// 探测请求使用固定最小 prompt，避免多余推理开销；不可改写角色、文本或混入会话历史。
const CONNECTIVITY_PROBE_SYSTEM = "You are ZCode connectivity probe.";
const CONNECTIVITY_PROBE_USER = "hi";
const GIT_COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";
// 提示词优化与 Git 提交消息同为「快进快出」的辅助调用：最低推理档 + 辅助预算，
// 不吃调用方自带的 maxOutputTokens，避免思考模型把小预算烧在推理上输出为空。
const PROMPT_OPTIMIZER_QUERY_SOURCE = "prompt_optimizer";
const AUXILIARY_QUERY_SOURCES = new Set([
  GIT_COMMIT_MESSAGE_QUERY_SOURCE,
  PROMPT_OPTIMIZER_QUERY_SOURCE,
]);

export interface WorkspaceGenerateTextInput {
  selection: ModelSelection;
  prompt?: string;
  messages?: ModelInputMessage[];
  tools?: ModelToolContract[];
  querySource: string;
  maxOutputTokens?: number;
  /**
   * 流式传输（与主会话/子代理同一 streamText 管道）：思考增量持续产生 provider 事件，
   * 连接不静默，上游不会按「无产出」掐断长思考请求。缺省保持一次性 generateText
   * （旧调用方语义不变）；深思考型调用（如 Oracle 审查）应显式传 true。
   */
  stream?: boolean;
  /**
   * 流式输出进度回调（仅 stream 路径生效）：正文与思考增量累计字符数。
   * bootstrap 层负责节流并转成协议通知；token 用量只在 finish 的 usage 里，中途没有。
   */
  onProgress?: (progress: WorkspaceGenerateTextProgress) => void;
  /**
   * 深度审查（只读子代理多轮循环）：审查方获得 Read/Grep/Glob 与只读 Bash，
   * 多轮取证后产出结论。与 stream 同源（逐轮 streamText 防静默掐断），忽略
   * 外层 modelRequest 的单轮语义。
   */
  agentic?: boolean;
  /**
   * 深度审查的软 deadline（epoch ms）：调查轮在扣除收尾预留后提前进入禁用工具
   * 的收尾轮，保证 deadline 内有结论。外层 hard-abort 仍是最终兜底。
   */
  deadlineAt?: number;
}

export interface WorkspaceGenerateTextProgress {
  outputChars: number;
  /** 深度审查（agentic）的当前轮次，从 1 起。 */
  round?: number;
  /** 深度审查正在执行的工具名（仅工具执行阶段携带）。 */
  toolName?: string;
  /** 工具调用的展示目标（文件路径 / pattern / 命令），仅工具执行阶段携带。 */
  toolTarget?: string;
  /**
   * 自上次回调以来新增的可见正文（不含思考）。供审查面板按轮次回放模型输出；
   * 累积与窗口合并由调用方（进度通知器）负责，这里只传本次增量。
   */
  textDelta?: string;
}

export interface WorkspaceGenerateTextResult {
  text: string;
  selection: ModelSelection;
  finishReason: string;
  usage?: ModelUsage;
  toolCalls?: ModelToolCall[];
}

export interface ModelConnectivityTestInput {
  selection: ModelSelection;
}

export async function testModelConnectivity(
  this: AgentRuntimeInternal,
  input: ModelConnectivityTestInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<void> {
  const baseModel = createRuntimeModel(this, { selection: input.selection, scope: "workspace" });
  // 连接探测不需要生成正文；复用辅助生成的 5,000 预算会等待多余推理和输出。
  // 独立限制为 1 Token，仍使用最低公开档位，不改变其他辅助调用的预算。
  const model = baseModel.bind({
    reasoningLevel: baseModel.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS,
  });
  const traceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: "provider_settings_connectivity",
    },
  });
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  const request: ModelRequest = {
    abortSignal,
    messages: [
      { role: "system", content: CONNECTIVITY_PROBE_SYSTEM },
      { role: "user", content: CONNECTIVITY_PROBE_USER },
    ],
  };
  let finished = false;
  await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(traceContext),
      modelCall: { operation: "workspace_generate_text" },
      statusSink: this.createModelStatusSink(traceContext, []),
      traceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext,
      }),
    },
    async () => {
      for await (const event of model.streamText(request)) {
        if (event.type === "error") throw normalizeStreamError(event.error);
        if (event.type === "finish") finished = true;
      }
    },
  );
  if (!finished) throw new Error("模型连通性测试流在 finish 事件前结束");
}

export async function generateWorkspaceText(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  assertWorkspaceModelInput(input);
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const operationTelemetry = this.agentTelemetry.detached({
    executionKind: "foreground",
    operation:
      querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
        ? "workspace_git_commit_message"
        : "workspace_generate_text",
    targetKind: "workspace",
    trigger: "user",
    traceContext,
  });
  return operationTelemetry.run(async () => {
    try {
      const result = await generateWorkspaceTextImpl.call(this, input, options);
      operationTelemetry.setResultType("text");
      operationTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (options?.abortSignal?.aborted) {
        operationTelemetry.finishCancelled("abort_signal");
      } else {
        operationTelemetry.finishFailed("execute", "unknown", error);
      }
      throw error;
    }
  });
}

async function generateWorkspaceTextImpl(
  this: AgentRuntimeInternal,
  input: WorkspaceGenerateTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<WorkspaceGenerateTextResult> {
  assertWorkspaceModelInput(input);
  const requestedSelection = input.selection;
  const querySource = input.querySource.trim() || "workspace_generate_text";
  const baseModel = createRuntimeModel(this, { selection: requestedSelection, scope: "workspace" });
  // 辅助请求需要的是最低公开档位，不是扫描 off/nothink 等名称后强制关闭。
  const model = AUXILIARY_QUERY_SOURCES.has(querySource)
    ? baseModel.bind(auxiliaryModelOptions(baseModel))
    : baseModel;
  const baseTraceContext = options?.traceContext ?? this.rootTraceContext;
  const modelTraceContext = createChildTraceContext(baseTraceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource,
    },
  });

  const events: SessionEvent[] = [];
  const messages: ModelInputMessage[] = input.messages
    ? input.messages.map((message) => ({ ...message }))
    : [{ role: "user", content: input.prompt!.trim() }];
  const tools = input.tools ?? [];
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: tools.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  events.push(modelRequestEvent);

  const modelStartedAt = Date.now();
  const networkEventStartIndex = events.length;
  const abortSignal =
    options?.abortSignal ?? AbortSignal.timeout(WORKSPACE_GENERATE_TEXT_TIMEOUT_MS);
  // Git Commit 调用方曾传入固定 256，Core 又按 querySource 丢弃，形成虚假接口。
  // 通用生成入口只处理调用方真实提供的预算；Git 辅助调用不再由上游伪造固定上限。
  const requestMaxOutputTokens = AUXILIARY_QUERY_SOURCES.has(querySource)
    ? undefined
    : input.maxOutputTokens;

  const modelRequest = {
    abortSignal,
    messages,
    tools,
    ...(requestMaxOutputTokens === undefined
      ? {}
      : { options: { maxOutputTokens: requestMaxOutputTokens } }),
  };

  const result = await runWithModelInvocationContext(
    {
      metadata: traceContextToLogContext(modelTraceContext),
      modelCall: {
        operation:
          querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE
            ? "workspace_git_commit_message"
            : "workspace_generate_text",
        ...(querySource === GIT_COMMIT_MESSAGE_QUERY_SOURCE && model.options.reasoningLevel
          ? { reasoning: { requestedLevel: model.options.reasoningLevel } }
          : {}),
      },
      statusSink: this.createModelStatusSink(modelTraceContext, events),
      traceContext: modelTraceContext,
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext: modelTraceContext,
      }),
    },
    () =>
      input.agentic
        ? runDeepReviewAgentLoop(this, {
            abortSignal,
            messages,
            model,
            onProgress: input.onProgress,
            // 外层已解析的输出预算（UI 按模型声明上限传入）必须进循环，
            // 否则深度审查会退回默认选项、被 adapter 校验或 reasoning 吃空。
            requestOptions: modelRequest.options,
            traceContext: modelTraceContext,
            ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
          })
        : input.stream
          ? streamModelTextResult(model, modelRequest, input.onProgress)
          : model.generateText(modelRequest),
  ).catch(async (error: unknown) => {
    await recordModelUsageFact(this, {
      error,
      events,
      model,
      networkEventStartIndex,
      querySource,
      startedAt: modelStartedAt,
      status: "error",
      traceContext: modelTraceContext,
    });
    throw error;
  });

  const toolCalls = this.extractToolCallsFromResult(result);
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: result.text,
      querySource,
      stopReason: result.finishReason,
      toolCallCount: toolCalls.length,
      usage: result.usage,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);
  await recordModelUsageFact(this, {
    events,
    model,
    networkEventStartIndex,
    querySource,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
    traceContext: modelTraceContext,
  });

  return {
    text: result.text,
    selection: {
      providerId: requestedSelection.providerId,
      modelId: requestedSelection.modelId,
      ...(requestedSelection.options ? { options: { ...requestedSelection.options } } : {}),
    },
    finishReason: result.finishReason,
    usage: result.usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function assertWorkspaceModelInput(input: WorkspaceGenerateTextInput): void {
  if (input.messages && input.messages.length > 0) return;
  if (input.prompt?.trim()) return;
  throw new Error("模型文本生成 prompt 或 messages 不能为空");
}

/**
 * 逐事件静默看门狗：两次流事件之间的间隔超过阈值即中止。正常的思考型响应会持续
 * 产生 reasoning/text 增量，静默两分钟意味着上游在重试循环里空转。
 * 导出仅为单测。
 */
export async function* streamWithStallWatchdog(
  source: AsyncIterable<ModelStreamEvent>,
  timeoutMs: number,
): AsyncGenerator<ModelStreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `模型流连续 ${Math.round(timeoutMs / 1000)} 秒没有任何事件（上游重试循环或无产出），已中止以避免耗尽超时预算`,
          );
          error.name = "ZCodeModelStreamStallError";
          reject(error);
        }, timeoutMs);
      });
      let next: IteratorResult<ModelStreamEvent>;
      try {
        next = await Promise.race([iterator.next(), stall]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // 不 await：卡死的上游迭代器 return 可能永不 settle，等它会阻塞错误传播；
    // 底层请求的清理由 provider 流自身的 finalize 与调用方 abortSignal 兜底。
    void iterator.return?.()?.catch?.(() => {});
  }
}

/**
 * 流式聚合：与主会话同一 streamText 管道，把增量事件折叠成与 generateText 同形的
 * ModelTextResult。思考增量持续产生 provider 事件，连接不静默——上游不会像对一次性
 * 请求那样在无产出时掐断长思考（日志实测：一次性路径每次尝试 ~55-60s 无产出被断，
 * 客户端各超时均 ≥180s，出处 ~/.zcode/v2/logs/2026-10-01.log 23:26-23:36）。
 */
/** 导出仅为单测；生产调用方走 generateWorkspaceText 的 stream 旗标。 */
export async function streamModelTextResult(
  model: Model,
  request: ModelRequest,
  onProgress?: (progress: WorkspaceGenerateTextProgress) => void,
  options?: { stallTimeoutMs?: number },
): Promise<{
  text: string;
  finishReason: string;
  usage: ModelUsage;
  toolCalls?: ModelToolCall[];
}> {
  let text = "";
  let eventCount = 0;
  let finishReason = "unknown";
  let usage: ModelUsage | undefined;
  // outputChars 只累计正文与思考增量的字符数（工具输入增量不计入）——它是给用户的
  // 「模型可见产出」进度，混入内部工具调用的 JSON 片段会虚高且口径不稳；非 token 估算。
  let outputChars = 0;
  const toolCalls: ModelToolCall[] = [];
  const pushedToolCallIds = new Set<string>();
  // 两种 provider 语义并存：完整 tool_call 事件，或 tool_input_start/delta/end 增量序列。
  // 按 id 去重，两种都到时只收一次；增量在 end 时解析 JSON 输入。
  const pendingToolInputs = new Map<string, { name: string; parts: string[] }>();
  const pushToolCall = (toolCall: ModelToolCall) => {
    if (pushedToolCallIds.has(toolCall.id)) return;
    pushedToolCallIds.add(toolCall.id);
    toolCalls.push(toolCall);
  };
  const stallTimeoutMs = options?.stallTimeoutMs ?? MODEL_STREAM_STALL_TIMEOUT_MS;
  for await (const event of streamWithStallWatchdog(model.streamText(request), stallTimeoutMs)) {
    eventCount += 1;
    if (event.type === "error") throw normalizeStreamError(event.error);
    if (event.type === "text_delta") {
      text += event.text;
      outputChars += event.text.length;
      onProgress?.(
        event.text.length > 0 ? { outputChars, textDelta: event.text } : { outputChars },
      );
    } else if (event.type === "reasoning_delta") {
      outputChars += event.text.length;
      onProgress?.({ outputChars });
    } else if (event.type === "tool_call") {
      pushToolCall(event.toolCall);
    } else if (event.type === "tool_input_start") {
      pendingToolInputs.set(event.id, { name: event.toolName, parts: [] });
    } else if (event.type === "tool_input_delta") {
      pendingToolInputs.get(event.id)?.parts.push(event.delta);
    } else if (event.type === "tool_input_end") {
      const pending = pendingToolInputs.get(event.id);
      pendingToolInputs.delete(event.id);
      if (!pending) continue;
      let input: unknown;
      try {
        input = pending.parts.length > 0 ? (JSON.parse(pending.parts.join("")) as unknown) : {};
      } catch {
        input = { _raw: pending.parts.join("") };
      }
      pushToolCall({ id: event.id, name: pending.name, input });
    } else if (event.type === "finish") {
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }
  if (!usage) {
    // 正常流必以 finish 收尾（error 事件已提前抛）；缺 finish 说明流被提前截断。
    // 带上聚合进度便于定位是哪个 provider/哪类响应形态没给出收尾。
    throw new Error(
      `模型流在 finish 事件前结束（events=${eventCount}, textLength=${text.length}, toolCalls=${toolCalls.length}）`,
    );
  }
  return {
    text,
    finishReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
