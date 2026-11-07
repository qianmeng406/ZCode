// DelegateToExternalAgent：把当前会话的计划交给绑定的外部 coding agent 执行。
//
// 存在理由：会话绑定外部 agent 后主会话是只读的（plan 模式），它能读、能分析、
// 能出计划，但不能改文件。这个工具是唯一的「出手」通道——把计划正文送出去，
// 由外部 agent 在自己的进程里执行，结果回到时间线。
//
// 权限形状（关键）：
// - readOnly: true —— 本工具自身不写工作区；
// - sideEffectScope: "session" + allowedInPlanMode: true —— 因此 checkPlanMode 会放行它
//   （service.ts 的显式会话能力分支），而 Write/Edit/Bash 仍被拦。
// - needsApproval: false —— 委派动作已在绑定绑定时获得用户明示同意，
//   逐次弹窗会毁掉「主会话自动推进」的体验。
import {
  CoreErrorType,
  createCoreError,
  type ExternalAgentDelegateInput,
  type ExternalAgentDelegateOutcome,
  type TraceContext,
} from "@zcode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolHandler } from "../types.js";
import { createExternalAgentProgressEmitter } from "./external-agent-progress.js";
import { waitForExternalAgentTask } from "./external-agent-wait.js";
import { createExternalAgentActivityReporter } from "./external-agent-activity.js";

export const DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME = "DelegateToExternalAgent";

const MAX_DELEGATION_OUTPUT_BYTES = 64_000;

const inputSchema = z
  .object({
    /** 交给外部 agent 的完整任务描述（通常就是主会话产出的计划）。 */
    task: z.string().min(1).max(200_000),
    /** 可选补充：验收标准、约束、相关文件线索。 */
    context: z.string().max(50_000).optional(),
    /**
     * 续接策略：auto（默认，有上一轮外部会话就续接）/ fresh（强制新会话）。
     * 任务与上一轮无关时用 fresh，避免被历史带偏。
     */
    continuation: z.enum(["auto", "fresh"]).optional(),
    /**
     * 本次等待多久（分钟）。0 = 启动后立即返回任务 ID，完全不占用对话。
     *
     * 默认 2 分钟：短任务仍能一次拿全结果，长任务不再把整轮对话卡死——
     * 超时后本工具返回 running + taskId，主 agent 可以继续干别的，稍后用
     * GetExternalAgentTaskResult 续查。
     */
    waitMinutes: z.number().int().min(0).max(60).optional(),
  })
  .strict();

type DelegateInput = z.infer<typeof inputSchema>;

/** 默认等待上限：短任务一次拿全，长任务把控制权还给主 agent。 */
const DEFAULT_WAIT_MS = 120_000;
/** running 结果里附带的输出尾巴（模型据此判断"它在干什么"）。 */
const RUNNING_PREVIEW_CHARS = 2_000;

const PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    agent: { type: "string" },
    success: { type: "boolean" },
    exitCode: { type: "integer" },
    durationMs: { type: "integer" },
    result: { type: "string" },
    continued: { type: "boolean" },
    externalSessionId: { type: "string" },
    changes: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              added: { type: "integer" },
              deleted: { type: "integer" },
            },
            required: ["path", "added", "deleted"],
            additionalProperties: false,
          },
        },
        truncated: { type: "boolean" },
      },
      required: ["files", "truncated"],
      additionalProperties: false,
    },
    waitMinutes: {
      type: "integer",
      minimum: 0,
      maximum: 60,
      description: "How long to wait inline (minutes). 0 returns a taskId immediately; default 2.",
    },
    // running 形态（等待超时）：任务在后台继续跑，用 GetExternalAgentTaskResult 续查。
    running: { type: "boolean" },
    taskId: { type: "string" },
    preview: { type: "string" },
  },
  // 两种形态：完成（success/result 等）或仍在运行（running + taskId）。
  anyOf: [
    { required: ["agent", "success", "exitCode", "durationMs", "result", "continued"] },
    { required: ["agent", "running", "taskId"] },
  ],
  additionalProperties: false,
};

const handler: ToolHandler = async (input, context) => {
  const parsed = inputSchema.parse(input) as DelegateInput;
  const port = context.externalAgentPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "External agent port is not configured for DelegateToExternalAgent",
      {
        context: { toolCallId: context.toolCallId, toolName: DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME },
        recoverable: false,
      },
    );
  }

  // 活动卡：用户在只读会话里始终能看到"codebuddy 现在在做什么"。
  const activity = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
  const emitProgress = createExternalAgentProgressEmitter(
    context,
    DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  );

  // running 形态要带上"它现在在干什么"的尾巴：模型据此判断该等还是该干别的。
  let lastOutput = "";
  const delegateInput = {
    sessionId: context.sessionId,
    task: parsed.task,
    ...(parsed.context ? { context: parsed.context } : {}),
    ...(parsed.continuation ? { continuation: parsed.continuation } : {}),
    cwd: context.workspaceRoot ?? context.workingDirectory,
    abortSignal: context.abortSignal,
    ...(context.traceContext ? { trace: context.traceContext as TraceContext } : {}),
    onStart: (info) => activity.started(info),
    // 外部 agent 的实时输出 → 工具进度事件（与 Bash 同形）+ 活动卡。
    onOutput: (chunk: { stream: "stdout" | "stderr"; text: string; preview?: unknown }) => {
      emitProgress(chunk);
      activity.progress(chunk);
      if (chunk.text) {
        lastOutput = (lastOutput + chunk.text).slice(-RUNNING_PREVIEW_CHARS);
      }
    },
    onSettled: (settled: ExternalAgentDelegateOutcome) =>
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
  } satisfies ExternalAgentDelegateInput;

  const waitMs = parsed.waitMinutes === undefined ? DEFAULT_WAIT_MS : parsed.waitMinutes * 60_000;

  // 有界等待：能 start 就先启动后台任务，等一会儿拿结果；等不到就把控制权交还
  // 主 agent（返回 running + taskId），而不是把整轮对话卡在一条工具调用上。
  // 不能 start 的宿主退回原来的阻塞式 delegate（行为不变）。
  let outcome: ExternalAgentDelegateOutcome | undefined;
  if (port.start && (port.wait || port.poll)) {
    const { taskId } = await port.start(delegateInput);
    const startedAt = Date.now();
    // 事件驱动等待：任务收口当刻返回，不按固定节拍采样（旧端口内部退回轮询）。
    const snapshot = await waitForExternalAgentTask(port, taskId, waitMs, context.abortSignal);
    if (snapshot && snapshot.status !== "running" && snapshot.outcome) {
      outcome = snapshot.outcome;
    } else {
      // 仍在跑：返回任务句柄。活动卡/进度继续由后台任务的 onOutput 推送。
      return {
        agent: "外部 agent",
        running: true,
        taskId,
        durationMs: snapshot?.durationMs ?? Date.now() - startedAt,
        ...(lastOutput ? { preview: lastOutput } : {}),
      };
    }
  } else {
    outcome = await port.delegate(delegateInput);
  }

  if (outcome.kind === "unbound") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "当前会话没有绑定外部 agent。请先在会话菜单里绑定一个外部 coding agent。",
      { context: { toolCallId: context.toolCallId }, recoverable: true },
    );
  }

  return {
    agent: outcome.label,
    success: !outcome.isError,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    result: outcome.text,
    continued: outcome.continued,
    ...(outcome.externalSessionId ? { externalSessionId: outcome.externalSessionId } : {}),
    ...(outcome.changes && outcome.changes.files.length > 0 ? { changes: outcome.changes } : {}),
  };
};

function formatModelContent(output: unknown): string {
  const record = output as {
    agent?: string;
    success?: boolean;
    exitCode?: number;
    durationMs?: number;
    result?: string;
    running?: boolean;
    taskId?: string;
    preview?: string;
  };
  // 等待超时：任务还在后台跑。给出任务句柄与续查方式，别让模型以为它失败了。
  if (record.running) {
    const seconds = Math.max(1, Math.round((record.durationMs ?? 0) / 1000));
    const lines = [
      `外部 agent「${record.agent}」仍在执行（已等待 ${seconds}s，任务 ${record.taskId}）。`,
      "它已经在后台继续跑；你可以先做别的事，随时用 GetExternalAgentTaskResult 查询进度或结果，或用 CancelExternalAgentTask 取消。",
    ];
    const preview = (record.preview ?? "").trim();
    if (preview) lines.push("", `最近输出：`, preview);
    return lines.join("\n");
  }
  const header = record.success
    ? `外部 agent「${record.agent}」已完成（${record.durationMs}ms，exit ${record.exitCode}）`
    : `外部 agent「${record.agent}」执行失败（${record.durationMs}ms，exit ${record.exitCode}）`;
  const body = (record.result ?? "").trim();
  const base = body ? `${header}\n\n${body}` : header;
  // 变更摘要附在正文后：主 agent 据此判断要不要自己读 diff 复审。
  const summary = formatChangeSummary(
    (
      record as {
        changes?: {
          files?: Array<{ path: string; added: number; deleted: number }>;
          truncated?: boolean;
        };
      }
    ).changes,
  );
  return summary ? `${base}\n\n${summary}` : base;
}

/**
 * 变更摘要渲染：主 agent 在只读模式下看不到外部 agent 改了什么，这段是它判断
 * "要不要自己读 diff 复审"的唯一线索。
 */
function formatChangeSummary(
  changes:
    | { files?: Array<{ path: string; added: number; deleted: number }>; truncated?: boolean }
    | undefined,
): string {
  const files = changes?.files ?? [];
  if (files.length === 0) return "";
  const lines = files.map((file) => `- ${file.path} +${file.added} -${file.deleted}`);
  return [`工作区改动（${files.length}${changes?.truncated ? "+" : ""} 个文件）：`, ...lines].join(
    "\n",
  );
}

export const delegateToExternalAgentToolEntry: ToolEntry = {
  capability: "把计划交给绑定的外部 coding agent 执行",
  metadata: {
    name: DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
    description:
      "Delegate the plan to the external coding agent bound to this session and return its report.",
    modelInstructions: [
      "Use this tool when the session is bound to an external coding agent and the plan is ready to be executed.",
      "Put the complete plan in `task`; the external agent does not see this conversation.",
      "Add `context` for acceptance criteria, constraints, or file hints the executor needs.",
      "The external agent works in its own process. This session stays read-only.",
      "Delegations continue the previous external session by default; pass continuation=fresh for unrelated work.",
      "The result includes a workspace change summary when git is available — review the diff yourself if it matters.",
      "Waiting is bounded (default 2 minutes): if the external agent is still running, the tool returns running=true and a taskId. Call GetExternalAgentTaskResult with that taskId — it blocks until the task settles and returns the report; never sleep in Bash to wait, and do not re-delegate.",
      "Use waitMinutes to change the inline wait: 0 returns a taskId immediately, up to 60.",
      "Do not use this tool for analysis or exploration — do those yourself with read-only tools.",
    ],
    // 关键：本工具在 plan（只读）模式下必须可用，否则主会话没有任何"出手"通道。
    allowedInPlanMode: true,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 600_000,
    maxOutputBytes: MAX_DELEGATION_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "medium",
    needsApproval: false,
    // 非驻留工具：ToolSearch 模式下按需加载 schema。绑定会话是长会话（外部 agent
    // 单次执行可达数分钟），把它的完整 schema 常驻在请求里没有收益。
    shouldDefer: true,
  },
  handler,
  formatModelContent,
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete plan/task for the external agent." },
      context: { type: "string", description: "Optional acceptance criteria or constraints." },
      continuation: {
        type: "string",
        enum: ["auto", "fresh"],
        description: "auto continues the previous external session; fresh starts a new one.",
      },
      waitMinutes: {
        type: "integer",
        minimum: 0,
        maximum: 60,
        description:
          "How long to wait inline (minutes). 0 returns a taskId immediately; default 2.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  outputSchema: PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: inputSchema,
  runtimeOutputSchema: z.union([
    z
      .object({
        agent: z.string(),
        running: z.literal(true),
        taskId: z.string().min(1),
        durationMs: z.number().int().nonnegative(),
        preview: z.string().optional(),
      })
      .strict(),
    z
      .object({
        agent: z.string(),
        success: z.boolean(),
        exitCode: z.number().int(),
        durationMs: z.number().int(),
        result: z.string(),
        continued: z.boolean(),
        externalSessionId: z.string().optional(),
        changes: z
          .object({
            files: z.array(
              z.object({ path: z.string(), added: z.number().int(), deleted: z.number().int() }),
            ),
            truncated: z.boolean(),
            unavailable: z.boolean().optional(),
          })
          .optional(),
      })
      .strict(),
  ]),
  permission: {
    permission: "agent.external.delegate",
    reason: "DelegateToExternalAgent runs the session's bound external coding agent",
    riskLevel: "medium",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_DELEGATION_OUTPUT_BYTES,
    maxModelBytes: MAX_DELEGATION_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: 8_000, direction: "head" },
  },
  timeout: { defaultMs: 600_000, maxMs: 1_800_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "外部 agent 委派已取消",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// 绑定的读写实现住在 bootstrap（session-external-agent.ts）；core 只通过注入的
// externalAgentPort 使用，保持 core 不依赖 bootstrap 的分层约束。
