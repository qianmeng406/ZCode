import { traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import { PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX } from "@zcode/contracts";
import type {
  MessageId,
  PartId,
  ToolCall,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import {
  createStreamRecoveryAnchorId,
  emitStreamRecoveryAnchor,
  emitStreamingToolLedgerUpdate,
  isTurnCancellationError,
  modelContentForToolResult,
  stringifyToolResultOutput,
  toolBatchModelEntries,
} from "../helpers/index.js";
import { persistToolResultMediaAttachments } from "../helpers/tool-result-media-persistence.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { recordBrowserTurnToolResult } from "../../repl/browser-turn-state.js";
import { completedToolPartMetadata, mcpToolPartMetadata } from "./tool-part-metadata.js";
import { projectToolNameForNonEmptyBoundary } from "./tool-part-persistence.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { emitNestedModelUsageEvents } from "./turn-nested-model-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { persistAnnouncements } from "./context-refresh.js";
import { recordToolUsageFromResult } from "./turn-tool-usage.js";
import { recordSessionFeaturesFromToolResults } from "../session-features/contract.js";

export interface ToolResultPart {
  partID: PartId;
  declarationIndex: number;
  input: Record<string, unknown>;
  startedAt: number;
}

export async function settleToolResults(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    results: ToolExecutionResult[];
    toolParts: ReadonlyMap<string, ToolResultPart>;
    toolCallById: ReadonlyMap<string, ToolCall>;
    streamedResultsById: ReadonlyMap<ToolCallId, StreamedToolExecutionResult>;
  },
): Promise<void> {
  const { results, toolParts, toolCallById, streamedResultsById } = options;
  const batchEntries = toolBatchModelEntries(results, {
    registry: this.registry,
    modelCallWrapperOf: (toolCallId) => toolCallById.get(toolCallId)?.modelCallWrapper,
  });
  // 根因：工具调用已进入历史，但旧逻辑在异步保存之后逐项加入结果；中途失败会
  // 留下缺失结果的调用。整批真实结果必须在任何异步收尾之前同步进入两份模型历史。
  // 这只保证当前进程历史完整，恢复锚点仍以各项持久化成功为前提。
  commitTurnRequestEntries(this, state.turnRequestState, batchEntries.toolResults);
  for (const result of results) {
    recordBrowserTurnToolResult({
      output: result.output,
      sessionId: this.sessionId,
      toolName: result.toolName,
      turnId: state.turnId,
    });
  }
  // 结果已进入历史后同步打能力标签，下一次模型请求就带上（session-features 只读结果）。
  recordSessionFeaturesFromToolResults.call(this, results, options.modelTraceContext);
  await emitNestedModelUsageEvents(this, {
    events: state.events,
    results,
    traceContext: options.modelTraceContext,
  });
  for (const toolResult of results) {
    const resultContent = toolResult.success
      ? modelContentForToolResult(toolResult)
      : (toolResult.error?.message ?? stringifyToolResultOutput(toolResult));
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.completeTool(toolResult.toolCallId as ToolCallId, {
        success: toolResult.success,
        content: resultContent,
      }),
    );
  }
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  this.logger?.debug("Tools executed", {
    resultCount: results.length,
    results: results.map((r) => ({
      toolName: r.toolName,
      success: r.success,
      output: typeof r.output === "string" ? r.output.substring(0, 50) : "[object]",
    })),
  });

  this.logger?.debug("Injecting tool results", { resultCount: results.length });
  let deferredCheckpointCancellation: unknown;
  for (const result of results) {
    await recordToolUsageFromResult(this, result, options.modelTraceContext);
    const content = stringifyToolResultOutput(result);
    const projectedResultToolName = projectToolNameForNonEmptyBoundary(result.toolName);
    const persisted = toolParts.get(result.toolCallId);
    if (persisted) {
      const mediaPersistence = result.success
        ? await persistToolResultMediaAttachments({
            artifactStore: this.artifactStore,
            assistantMessageId: options.assistantMessageId,
            content: modelContentForToolResult(result),
            sessionId: this.sessionId,
            sessionStore: this.sessionStore,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            traceContext: options.modelTraceContext,
            turnId: state.turnId,
          })
        : undefined;
      await this.persistPart(
        {
          id: persisted.partID,
          sessionID: this.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: result.toolCallId,
          declarationIndex: persisted.declarationIndex,
          tool: projectedResultToolName.toolName,
          metadata: {
            ...projectedResultToolName.metadata,
            ...(toolCallById.get(result.toolCallId)?.modelCallWrapper
              ? { modelCallWrapper: toolCallById.get(result.toolCallId)?.modelCallWrapper }
              : {}),
          },
          state: result.success
            ? {
                status: "completed",
                input: persisted.input,
                output: content,
                title: projectedResultToolName.toolName,
                metadata: {
                  ...completedToolPartMetadata(result),
                  ...(mediaPersistence
                    ? { modelContentLayout: mediaPersistence.modelContentLayout }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
                ...(mediaPersistence ? { attachments: mediaPersistence.attachments } : {}),
              }
            : {
                status: "error",
                input: persisted.input,
                error: result.error?.message ?? content,
                // 修复原因：state.error 面向 UI / 日志，可能比模型实际收到的
                // modelContent 更笼统；仅附加保存 string 内容供冷恢复精确重放。
                metadata: {
                  ...mcpToolPartMetadata(
                    this.registry.getMetadata(result.toolName)?.mcpPresentation,
                  ),
                  ...(typeof result.modelContent === "string"
                    ? { modelContent: result.modelContent }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
              },
        },
        options.modelTraceContext,
      );
    }
    this.logger?.debug("addToolResult", {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      contentLength: content.length,
    });
    try {
      // 修复原因：checkpoint 是 tool result 闭合后的附加操作。Stop 若在这里
      // 触发，必须先完成所有 sibling 的持久化收尾，不能提前进入 reminder flush。
      await this.emitFileMutationCheckpoint({
        abortSignal: state.turnAbortSignal,
        events: state.events,
        messageId: state.userMessageId,
        result,
        toolMessageId: options.assistantMessageId,
        traceContext: options.modelTraceContext,
      });
    } catch (error) {
      if (!isTurnCancellationError(error, state.turnAbortSignal)) throw error;
      deferredCheckpointCancellation ??= error;
      continue;
    }
    const toolCall = toolCallById.get(result.toolCallId as ToolCallId);
    if (toolCall) {
      const resultPartId = persisted?.partID;
      const recoveryAnchorId = createStreamRecoveryAnchorId(
        options.assistantMessageId,
        result.toolCallId as ToolCallId,
      );
      await emitStreamRecoveryAnchor(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCallId: result.toolCallId as ToolCallId,
        toolName: projectedResultToolName.toolName,
        success: result.success,
        resultPartId,
        committedAt: result.completedAt,
      });
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_result_committed",
        executionTiming: streamedResultsById.has(result.toolCallId as ToolCallId)
          ? "during_stream"
          : "end_of_stream",
        input: persisted?.input,
        startedAt: result.startedAt,
        committedAt: result.completedAt,
        resultPartId,
        recoveryAnchorId,
      });
    }
    await enqueueFollowUpUserInputFromToolResult.call(
      this,
      state,
      result,
      options.modelTraceContext,
    );
  }

  // 工具 Hook 的附加上下文与工具声明的批次提示（例如 Read 部分视图提示）紧跟在这批 tool result 之后
  // （顺序见 toolBatchModelEntries）。持久化后进入历史，resume 后位置不变。
  // 它们属于这批结果，Stop 打断 checkpoint 时也先写入再抛出：结果 → 附件 → 中断标记。
  // 先抛出会丢附件：tool result 已在历史里，模型之后只看到被截断的正文。
  await persistAnnouncements(
    this,
    state.turnRequestState,
    batchEntries.attachments,
    options.modelTraceContext,
  );
  if (deferredCheckpointCancellation) {
    throw deferredCheckpointCancellation;
  }
}

async function enqueueFollowUpUserInputFromToolResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const followUp = result.followUpUserInput;
  if (!followUp) return;

  const input = followUp.input.trim();
  if (!input) return;

  // 计划批准换模：目标回合必须以用户指定的模型开启（本回合模型已冻结）。
  // 走队列车道 + intent.modelSelection——本回合 stopTurnAfterResult 结束后，
  // bootstrap 的队列提升以该 intent 启动新回合，applySubmissionExecutionState
  // 应用选择并持久化为会话粘性选择（后续回合保持）。拒绝反馈等无模型选择
  // 的 follow-up 仍走 guide 原路径（内联续跑，现行行为不变）。
  //
  // sourceCommandId 必须保持 PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX
  // 前缀：bootstrap 的自动队列消费按它识别系统交接输入并豁免 held/targetStatus
  // 闸门。前缀丢失 = 队列一旦处于暂停态（此前回合报错/手动停止过）换模就永久滞留。
  const intent = followUp.modelSelection
    ? {
        kind: "sendText" as const,
        sourceCommandId: `${PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX}${result.toolCallId}`,
        queueItemId: `${PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX}${result.toolCallId}`,
        clientId: `${PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX}${result.toolCallId}`,
        modelSelection: followUp.modelSelection,
        // admission 事实由本次 steer 固定：入队即 admitted（queue 车道），位置由
        // steerTurn 的 intent 收敛步骤补写 queuePosition。
        admissionSeq: 0,
        admittedAt: Date.now(),
        requestedDelivery: "queue" as const,
        admittedDelivery: "queue" as const,
      }
    : undefined;

  const steerResult = await this.steerTurn({
    delivery: intent ? "queue" : "guide",
    expectedTurnId: state.activeTurn?.turnId,
    input,
    source: followUp.reasonSource,
    traceContext,
    ...(intent ? { intent } : {}),
  });

  if (steerResult.kind === "queued") {
    this.logger?.debug("Queued follow-up user input from tool result", {
      ...traceContextToLogContext(traceContext),
      event: "tool.follow_up_user_input.queued",
      module: "core.runtime",
      pendingInputId: steerResult.pendingInputId,
      reasonSource: followUp.reasonSource,
      ...(followUp.modelSelection
        ? {
            executionModel: `${followUp.modelSelection.providerId}/${followUp.modelSelection.modelId}`,
          }
        : {}),
      status: "waiting",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
    });
    return;
  }

  // 修复原因：ExitPlanMode 审批反馈必须升级成真实 user message；
  // 如果这里被拒绝，说明 active turn 状态异常或输入超过 steer 限制，不能静默吞掉。
  this.logger?.warn("Failed to queue follow-up user input from tool result", {
    ...traceContextToLogContext(traceContext),
    activeTurnId: steerResult.activeTurnId,
    event: "tool.follow_up_user_input.rejected",
    module: "core.runtime",
    reason: steerResult.reason,
    reasonSource: followUp.reasonSource,
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}
