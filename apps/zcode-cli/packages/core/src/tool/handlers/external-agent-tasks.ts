// 外部 agent 的后台任务工具：启动 / 取结果 / 取消。
//
// 存在理由：真实委派可能跑几分钟到十几分钟。同步的 DelegateToExternalAgent 会把
// 主对话 turn 占满（只读主控也做不了别的）。这三个工具把长任务拆成
// 「启动 → 轮询 → 取结果/取消」，主 agent 可以边等边做只读分析。
//
// 不变量：
// - 启动只登记任务，输出仍通过进度事件实时回传；
// - 取结果是幂等的：完成前后都可以查，完成后重复查结果不变；
// - 取消尽力而为：取消后立即返回 cancelled 快照，进程由 ExecutionPort 终止。
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolHandler } from "../types.js";

export const START_EXTERNAL_AGENT_TASK_TOOL_NAME = "StartExternalAgentTask";
export const GET_EXTERNAL_AGENT_TASK_TOOL_NAME = "GetExternalAgentTaskResult";
export const CANCEL_EXTERNAL_AGENT_TASK_TOOL_NAME = "CancelExternalAgentTask";

const startInputSchema = z
  .object({
    task: z.string().min(1).max(200_000),
    context: z.string().max(50_000).optional(),
    continuation: z.enum(["auto", "fresh"]).optional(),
  })
  .strict();

const taskIdInputSchema = z.object({ taskId: z.string().min(1).max(200) }).strict();

const pollInputSchema = z
  .object({
    /** 缺省 = 列出本会话全部任务状态。 */
    taskId: z.string().min(1).max(200).optional(),
  })
  .strict();

function requirePort(context: Parameters<ToolHandler>[1], toolName: string) {
  const port = context.externalAgentPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "External agent port is not configured for this session",
      { context: { toolCallId: context.toolCallId, toolName }, recoverable: false },
    );
  }
  return port;
}

const startHandler: ToolHandler = async (input, context) => {
  const parsed = startInputSchema.parse(input);
  const port = requirePort(context, START_EXTERNAL_AGENT_TASK_TOOL_NAME);
  if (!port.start) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "当前执行端不支持后台外部 agent 任务",
      { context: { toolCallId: context.toolCallId }, recoverable: false },
    );
  }
  const { taskId } = await port.start({
    sessionId: context.sessionId,
    task: parsed.task,
    ...(parsed.context ? { context: parsed.context } : {}),
    ...(parsed.continuation ? { continuation: parsed.continuation } : {}),
    cwd: context.workspaceRoot ?? context.workingDirectory,
    abortSignal: context.abortSignal,
    ...(context.traceContext ? { trace: context.traceContext } : {}),
    onOutput: (chunk) => {
      // 与同步委派一致：进度只是展示，不阻塞任务本身。
      void Promise.resolve(
        context.emitEvent?.({
          type: "tool_call_progress",
          sessionId: context.sessionId,
          toolCallId: context.toolCallId,
          payload: { text: chunk.text, stream: chunk.stream },
        } as never),
      ).catch(() => undefined);
    },
  });
  return { taskId, status: "running" as const };
};

const pollHandler: ToolHandler = async (input, context) => {
  const parsed = pollInputSchema.parse(input);
  const port = requirePort(context, GET_EXTERNAL_AGENT_TASK_TOOL_NAME);
  if (parsed.taskId) {
    if (!port.poll) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "当前执行端不支持后台任务查询", {
        context: { toolCallId: context.toolCallId },
        recoverable: false,
      });
    }
    const snapshot = await port.poll(parsed.taskId);
    if (!snapshot) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, `未知的外部 agent 任务：${parsed.taskId}`, {
        context: { toolCallId: context.toolCallId },
        recoverable: true,
      });
    }
    return snapshot;
  }
  const list = (await port.list?.(String(context.sessionId))) ?? [];
  return {
    tasks: list.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      durationMs: task.durationMs,
    })),
  };
};

const cancelHandler: ToolHandler = async (input, context) => {
  const parsed = taskIdInputSchema.parse(input);
  const port = requirePort(context, CANCEL_EXTERNAL_AGENT_TASK_TOOL_NAME);
  if (!port.cancel) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "当前执行端不支持取消后台任务", {
      context: { toolCallId: context.toolCallId },
      recoverable: false,
    });
  }
  const snapshot = await port.cancel(parsed.taskId);
  if (!snapshot) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `任务不存在或已结束：${parsed.taskId}`,
      { context: { toolCallId: context.toolCallId }, recoverable: true },
    );
  }
  return snapshot;
};

const COMMON_METADATA = {
  // 只读主控下必须可用：这是主会话唯一的"出手"通道。
  allowedInPlanMode: true,
  readOnly: true,
  destructive: false,
  sideEffectScope: "session" as const,
  needsApproval: false,
  shouldDefer: true,
};

export const startExternalAgentTaskToolEntry: ToolEntry = {
  capability: "在后台启动一次外部 coding agent 委派",
  metadata: {
    ...COMMON_METADATA,
    name: START_EXTERNAL_AGENT_TASK_TOOL_NAME,
    description:
      "Start a background delegation to the external coding agent bound to this session and return a taskId.",
    modelInstructions: [
      "Use this instead of DelegateToExternalAgent when the work may take more than a couple of minutes.",
      "Put the complete task in `task`; the external agent does not see this conversation.",
      "After starting, do other read-only work and poll with GetExternalAgentTaskResult.",
      "Set continuation=fresh when the task is unrelated to the previous delegation.",
    ],
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 8_000,
    riskLevel: "medium",
  },
  handler: startHandler,
  formatModelContent: (output) => {
    const record = output as { taskId?: string };
    return `已启动外部 agent 后台任务：${record.taskId ?? "(未知)"}`;
  },
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete task for the external agent." },
      context: { type: "string", description: "Optional acceptance criteria or constraints." },
      continuation: { type: "string", enum: ["auto", "fresh"] },
    },
    required: ["task"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string" },
    },
    required: ["taskId", "status"],
    additionalProperties: false,
  },
  runtimeInputSchema: startInputSchema,
  runtimeOutputSchema: z.object({ taskId: z.string(), status: z.literal("running") }).strict(),
  permission: {
    permission: "agent.external.delegate",
    reason: "StartExternalAgentTask runs the session's bound external coding agent",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: { maxInlineBytes: 8_000, maxModelBytes: 8_000, strategy: "truncate" },
  timeout: { defaultMs: 30_000, maxMs: 60_000, allowCallOverride: false },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "启动后台委派已取消" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

export const getExternalAgentTaskResultToolEntry: ToolEntry = {
  capability: "查询外部 agent 后台任务的进度与结果",
  metadata: {
    ...COMMON_METADATA,
    name: GET_EXTERNAL_AGENT_TASK_TOOL_NAME,
    description:
      "Poll a background external-agent task, or list this session's tasks when taskId is omitted.",
    modelInstructions: [
      "Poll sparingly (every 30-60s). running means keep doing other work.",
      "When status is completed, the outcome.text holds the external agent's report.",
      "Omit taskId to list all tasks started in this session.",
    ],
    concurrentSafe: true,
    timeoutMs: 15_000,
    maxOutputBytes: 128_000,
    riskLevel: "low",
  },
  handler: pollHandler,
  formatModelContent: (output) => {
    const record = output as {
      taskId?: string;
      status?: string;
      durationMs?: number;
      outcome?: { text?: string; isError?: boolean; changes?: { files?: unknown[] } };
      tasks?: unknown[];
    };
    if (Array.isArray(record.tasks)) {
      return record.tasks.length === 0
        ? "本会话没有外部 agent 后台任务"
        : `本会话外部 agent 任务：\n${record.tasks
            .map((task) => {
              const item = task as { taskId?: string; status?: string; durationMs?: number };
              return `- ${item.taskId ?? "?"} ${item.status ?? "?"}（${item.durationMs ?? 0}ms）`;
            })
            .join("\n")}`;
    }
    const header = `外部 agent 任务 ${record.taskId ?? "?"}：${record.status ?? "?"}（${record.durationMs ?? 0}ms）`;
    const body = record.outcome?.text?.trim();
    return body ? `${header}\n\n${body}` : header;
  },
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", description: "Omit to list all tasks." } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string" },
      durationMs: { type: "integer" },
      outcome: { type: "object" },
      tasks: { type: "array", items: { type: "object" } },
    },
    additionalProperties: true,
  },
  runtimeInputSchema: pollInputSchema,
  // 两种形态：单任务快照，或缺省 taskId 时的任务清单。
  runtimeOutputSchema: z.union([
    z
      .object({
        taskId: z.string(),
        sessionId: z.string(),
        status: z.enum(["running", "completed", "failed", "cancelled"]),
        durationMs: z.number().int(),
        outcome: z.unknown().optional(),
      })
      .strict(),
    z
      .object({
        tasks: z.array(
          z
            .object({
              taskId: z.string(),
              status: z.enum(["running", "completed", "failed", "cancelled"]),
              durationMs: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict(),
  ]),
  permission: {
    permission: "agent.external.poll",
    reason: "GetExternalAgentTaskResult reads the status of a delegated external-agent task",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: { maxInlineBytes: 128_000, maxModelBytes: 128_000, strategy: "truncate" },
  timeout: { defaultMs: 15_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: { supported: false, cleanup: "none", userVisibleMessage: "查询不可取消" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

export const cancelExternalAgentTaskToolEntry: ToolEntry = {
  capability: "取消外部 agent 后台任务",
  metadata: {
    ...COMMON_METADATA,
    name: CANCEL_EXTERNAL_AGENT_TASK_TOOL_NAME,
    description: "Cancel a running background external-agent task.",
    modelInstructions: [
      "Use this when the delegation has clearly gone wrong; do not wait for its timeout.",
      "The external process is terminated; partial output is discarded.",
    ],
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 8_000,
    riskLevel: "medium",
  },
  handler: cancelHandler,
  formatModelContent: (output) => {
    const record = output as { taskId?: string; status?: string };
    return `外部 agent 任务 ${record.taskId ?? "?"}：${record.status ?? "?"}`;
  },
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string" },
      durationMs: { type: "integer" },
    },
    required: ["taskId", "status", "durationMs"],
    additionalProperties: true,
  },
  runtimeInputSchema: taskIdInputSchema,
  runtimeOutputSchema: z
    .object({
      taskId: z.string(),
      sessionId: z.string(),
      status: z.enum(["running", "completed", "failed", "cancelled"]),
      durationMs: z.number().int(),
      outcome: z.unknown().optional(),
    })
    .strict(),
  permission: {
    permission: "agent.external.cancel",
    reason: "CancelExternalAgentTask stops a delegated external-agent task",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: { maxInlineBytes: 8_000, maxModelBytes: 8_000, strategy: "truncate" },
  timeout: { defaultMs: 30_000, maxMs: 60_000, allowCallOverride: false },
  cancellation: { supported: false, cleanup: "none", userVisibleMessage: "查询不可取消" },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};
