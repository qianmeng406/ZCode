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
import type { ExternalAgentPort, ExternalAgentTaskSnapshot } from "@zcode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolHandler } from "../types.js";
import { createExternalAgentProgressEmitter } from "./external-agent-progress.js";
import { waitForExternalAgentTask } from "./external-agent-wait.js";
import {
  createExternalAgentActivityReporter,
  publishExternalAgentTaskStatus,
} from "./external-agent-activity.js";

export const START_EXTERNAL_AGENT_TASK_TOOL_NAME = "StartExternalAgentTask";
export const GET_EXTERNAL_AGENT_TASK_TOOL_NAME = "GetExternalAgentTaskResult";
export const CANCEL_EXTERNAL_AGENT_TASK_TOOL_NAME = "CancelExternalAgentTask";

/**
 * 缺省阻塞等待时长：任务先结束就立刻返回，到点仍在跑就返回 running 快照。
 *
 * 这是为了根除「poll → sleep 60s → poll」的瞎等：那个 sleep 与任务何时结束无关，
 * 任务第 5 秒结束主 agent 也要睡满，反之任务跑了 61 秒就必然多等一轮。
 */
export const DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS = 60;
/** 单次等待上限（再长就分多轮，让模型有机会重新判断要不要继续等）。 */
export const MAX_EXTERNAL_AGENT_WAIT_SECONDS = 240;
/** 等待之外留给端口/序列化的预算。 */
const WAIT_TIMEOUT_MARGIN_MS = 20_000;

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
    /**
     * 阻塞等待秒数：任务收口立即返回；到点仍在跑则返回 running 快照。
     *
     * - 缺省 `DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS`（60s）：一次调用就等它一会儿，
     *   结束得早也就早返回——这就是 sleep 的替代品；
     * - `0` = 只看一眼立刻返回（还想先做别的只读工作、回来再等时用）。
     */
    waitSeconds: z.number().int().min(0).max(MAX_EXTERNAL_AGENT_WAIT_SECONDS).optional(),
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
  // 后台任务的活动卡：工具行会立刻结算，这张卡负责整个执行期的可见性。
  const activity = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
  const emitProgress = createExternalAgentProgressEmitter(
    context,
    START_EXTERNAL_AGENT_TASK_TOOL_NAME,
  );
  const { taskId } = await port.start({
    sessionId: context.sessionId,
    task: parsed.task,
    ...(parsed.context ? { context: parsed.context } : {}),
    ...(parsed.continuation ? { continuation: parsed.continuation } : {}),
    cwd: context.workspaceRoot ?? context.workingDirectory,
    abortSignal: context.abortSignal,
    ...(context.traceContext ? { trace: context.traceContext } : {}),
    onStart: (info) => activity.started(info),
    // 与同步委派共用进度发射器：后台任务同样要能看到实时输出。
    onOutput: (chunk) => {
      emitProgress(chunk);
      activity.progress(chunk);
    },
    onSettled: (settled) =>
      activity.settled({
        ...(settled.kind === "delegated"
          ? {
              label: settled.label,
              isError: settled.isError,
              durationMs: settled.durationMs,
              text: settled.text,
            }
          : {}),
      }),
  });
  return { taskId, status: "running" as const };
};

const pollHandler: ToolHandler = async (input, context) => {
  const parsed = pollInputSchema.parse(input);
  const port = requirePort(context, GET_EXTERNAL_AGENT_TASK_TOOL_NAME);
  if (parsed.taskId) {
    const waitMs = (parsed.waitSeconds ?? DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS) * 1_000;
    if (waitMs > 0) {
      if (!port.wait && !port.poll) {
        throw createCoreError(CoreErrorType.ToolExecutionFailed, "当前执行端不支持后台任务查询", {
          context: { toolCallId: context.toolCallId },
          recoverable: false,
        });
      }
    } else if (!port.poll) {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "当前执行端不支持后台任务查询", {
        context: { toolCallId: context.toolCallId },
        recoverable: false,
      });
    }
    const startedAt = Date.now();
    const snapshot = await waitForExternalAgentTask(
      port,
      parsed.taskId,
      waitMs,
      context.abortSignal,
    );
    if (!snapshot) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `未知的外部 agent 任务：${parsed.taskId}`,
        {
          context: { toolCallId: context.toolCallId },
          recoverable: true,
        },
      );
    }
    // 轮询观察到终态时顺便把活动卡收口：发起委派的工具早已返回，
    // 它的 reporter 不再有机会把状态从 running 推进到 completed。
    syncActivityFromSnapshot(context, snapshot);
    // waitedMs 让模型知道"这次是真等了一会儿还是立刻返回"，避免它再去 sleep 补时间。
    return { ...snapshot, waitedMs: Date.now() - startedAt };
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
  syncActivityFromSnapshot(context, snapshot);
  return snapshot;
};

/** 任务终态 → 活动卡终态（幂等；running 快照不写）。 */
function syncActivityFromSnapshot(
  context: Parameters<ToolHandler>[1],
  snapshot: ExternalAgentTaskSnapshot,
): void {
  if (snapshot.status === "running") return;
  const outcome = snapshot.outcome;
  publishExternalAgentTaskStatus(context, {
    taskId: snapshot.taskId,
    agentLabel: outcome?.kind === "delegated" ? outcome.label : "外部 agent",
    status: snapshot.status,
    durationMs: snapshot.durationMs,
    ...(outcome?.kind === "delegated" ? { text: outcome.text } : {}),
  });
}

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
      "Then call GetExternalAgentTaskResult with the taskId: it returns the moment the task settles (no sleep needed).",
      "External-session continuity is controlled by the user in the badge menu; do not pass continuation — it is not honored.",
    ],
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 8_000,
    riskLevel: "medium",
  },
  handler: startHandler,
  formatModelContent: (output) => {
    const record = output as { taskId?: string };
    const taskId = record.taskId ?? "(未知)";
    // 这段是模型决定"怎么等"的时刻唯一可靠读到的文本：工具都是 shouldDefer
    // （按需加载 schema），metadata.modelInstructions 在它发起委派时不一定进过上下文
    // ——实测（2026-11-07）模型仍然去 Bash sleep 45。下一步指令必须写在结果里。
    return [
      `已启动外部 agent 后台任务：${taskId}`,
      `下一步：调用 GetExternalAgentTaskResult({ "taskId": "${taskId}" }) 等它结束——该调用会阻塞到任务收口并直接返回报告（一轮最多等 60s，没等完就再调一次）。`,
      "不要用 Bash sleep 等待，也不要重复委派；等待期间可以先做其他只读工作。",
    ].join("\n");
  },
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete task for the external agent." },
      context: { type: "string", description: "Optional acceptance criteria or constraints." },
      continuation: {
        type: "string",
        enum: ["auto", "fresh"],
        description:
          "Deprecated and ignored: external-session continuity is controlled by the user's badge menu.",
      },
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
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const getExternalAgentTaskResultToolEntry: ToolEntry = {
  capability: "查询外部 agent 后台任务的进度与结果",
  metadata: {
    ...COMMON_METADATA,
    name: GET_EXTERNAL_AGENT_TASK_TOOL_NAME,
    description:
      "Wait for a background external-agent task to settle (or list this session's tasks when taskId is omitted).",
    modelInstructions: [
      "Pass taskId: the call blocks until the task settles or waitSeconds elapses, then returns the snapshot.",
      "waitSeconds defaults to 60 and is capped at 240; pass 0 to peek without blocking.",
      "Never sleep in Bash to wait for a delegation — call this instead; it returns the moment the task finishes.",
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
      waitedMs?: number;
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
    if (body) return `${header}\n\n${body}`;
    // 等过一轮仍在跑：明确告诉模型"已经等过了，不是没等"，它不该再用 sleep 补时间。
    if (record.status === "running" && (record.waitedMs ?? 0) > 0) {
      return `${header}\n\n已等待 ${Math.round((record.waitedMs ?? 0) / 1_000)}s，任务仍在运行。可以直接再次调用等待，或先做其他工作。`;
    }
    return header;
  },
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Omit to list all tasks." },
      waitSeconds: {
        type: "integer",
        minimum: 0,
        maximum: MAX_EXTERNAL_AGENT_WAIT_SECONDS,
        description:
          "Block until the task settles or this many seconds elapse. Default 60. 0 = return immediately.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string" },
      durationMs: { type: "integer" },
      waitedMs: { type: "integer" },
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
        /** 这次调用实际阻塞了多久（0 = 立刻返回）。 */
        waitedMs: z.number().int().nonnegative().optional(),
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
  // 等待是入参决定的：预算必须覆盖 waitSeconds，否则工具会在自己等待的过程中被
  // executor 的超时打断，模型拿到的是失败而不是"还在跑"。
  timeout: {
    defaultMs: 15_000,
    maxMs: MAX_EXTERNAL_AGENT_WAIT_SECONDS * 1_000 + WAIT_TIMEOUT_MARGIN_MS,
    allowCallOverride: false,
  },
  resolveTimeoutBudgetMs: (input) => {
    if (!input || typeof input !== "object") return undefined;
    const record = input as { taskId?: unknown; waitSeconds?: unknown };
    // 列表形态不等待，沿用默认预算。
    if (typeof record.taskId !== "string" || record.taskId.length === 0) return undefined;
    const seconds =
      typeof record.waitSeconds === "number"
        ? record.waitSeconds
        : DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS;
    const clamped = Math.min(Math.max(seconds, 0), MAX_EXTERNAL_AGENT_WAIT_SECONDS);
    return clamped * 1_000 + WAIT_TIMEOUT_MARGIN_MS;
  },
  // 等待可以被用户打断（停止生成 / 取消）：外部任务本身不受影响，仍会在后台跑完。
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "已停止等待（外部任务仍在后台运行）",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
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
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
