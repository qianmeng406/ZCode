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
import { CoreErrorType, createCoreError, type TraceContext } from "@zcode/contracts";
import { z } from "zod";
import type { ToolEntry, ToolHandler } from "../types.js";

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
  })
  .strict();

type DelegateInput = z.infer<typeof inputSchema>;

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
  },
  required: ["agent", "success", "exitCode", "durationMs", "result", "continued"],
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

  const outcome = await port.delegate({
    sessionId: context.sessionId,
    task: parsed.task,
    ...(parsed.context ? { context: parsed.context } : {}),
    ...(parsed.continuation ? { continuation: parsed.continuation } : {}),
    cwd: context.workspaceRoot ?? context.workingDirectory,
    abortSignal: context.abortSignal,
    ...(context.traceContext ? { trace: context.traceContext as TraceContext } : {}),
    onOutput: (chunk) => {
      // 外部 agent 的输出按工具进度事件回传，用户能实时看到它在做什么。
      //
      // 刻意不 await：进度只是展示。会话被切走/释放时事件写入可能长时间挂起，
      // await 会把整个工具卡在"执行中"（外部进程早已退出，用户却只能等超时）。
      // 进度丢了不影响结果，结果本身走后继的返回值。
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
    ...(outcome.changes && outcome.changes.files.length > 0
      ? { changes: outcome.changes }
      : {}),
  };
};

function formatModelContent(output: unknown): string {
  const record = output as {
    agent?: string;
    success?: boolean;
    exitCode?: number;
    durationMs?: number;
    result?: string;
  };
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
  changes: { files?: Array<{ path: string; added: number; deleted: number }>; truncated?: boolean } | undefined,
): string {
  const files = changes?.files ?? [];
  if (files.length === 0) return "";
  const lines = files.map((file) => `- ${file.path} +${file.added} -${file.deleted}`);
  return [`工作区改动（${files.length}${changes?.truncated ? "+" : ""} 个文件）：`, ...lines].join("\n");
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
    },
    required: ["task"],
    additionalProperties: false,
  },
  outputSchema: PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: inputSchema,
  runtimeOutputSchema: z
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
