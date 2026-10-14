// ============================================================
// Plan Mode Tools - plan approval flow
// ============================================================

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

// 与 shared/model-selection 的 modelSelectionSchema 同形状。contracts 的 zod 与
// cli shared 的 zod 是两个大版本实例，schema 不能跨实例组合，这里本地声明同构
// 值（类型对 shared 的 ModelSelection 结构兼容）。
const ExecutionModelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    options: z
      .object({
        reasoningLevel: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

/**
 * 计划批准换模 follow-up（ExitPlanMode 批准时指定执行模型产生）的稳定标记。
 * 生产方 core 把它写进 follow-up 的 sourceCommandId 前缀；消费方 bootstrap 的
 * 自动队列消费据此豁免 held/targetStatus 闸门——该输入是系统交接指令而非用户
 * 手排消息，不能因队列暂停或 goal 未收口而永久滞留（否则换模在批准后就地卡死）。
 */
export const PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX = "plan_exit_approved_";

export function isPlanExitApprovedFollowUpSourceCommandId(sourceCommandId: string): boolean {
  return sourceCommandId.startsWith(PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX);
}

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

export const EnterPlanModeOutputSchema = z
  .object({
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto", "research", "minimal"])
      .describe("Session mode before EnterPlanMode ran."),
    mode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto", "research", "minimal"])
      .describe("Current permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
  })
  .strict();
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

export const ExitPlanModeAllowedPromptSchema = z
  .object({
    tool: z.enum(["Bash"]).describe("The tool this prompt applies to"),
    prompt: z
      .string()
      .describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
  })
  .strict();
export type ExitPlanModeAllowedPrompt = z.infer<typeof ExitPlanModeAllowedPromptSchema>;

// plan file 需要保存最终批准的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const ExitPlanModePlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

export const ExitPlanModeInputSchema = z
  .object({
    plan: ExitPlanModePlanSchema,
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
    // 非模型产出字段：批准确认窗上用户指定的执行模型经 broker 的 modify 决策合并进输入。
    // 刻意不进 ExitPlanModeInputJsonSchema（模型面契约由下方 Model 基形生成）——模型
    // 侧不可见即不会被幻觉填写；运行时校验/归一化按本 schema 放行该字段。
    executionModelSelection: ExecutionModelSelectionSchema.optional(),
  })
  .catchall(z.unknown());
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
// 模型可见契约：不含 executionModelSelection（用户在批准确认窗上选择，模型不可见）。
const ExitPlanModeModelInputSchema = z
  .object({
    plan: ExitPlanModePlanSchema,
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
  })
  .catchall(z.unknown());
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeModelInputSchema);

export const ExitPlanModeOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was approved by the user."),
    approved: z.literal(true).describe("True when the user approved exiting plan mode."),
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto", "research", "minimal"])
      .describe("Previous permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
    mode: z
      .enum(["build", "edit", "yolo", "guarded", "auto", "research", "minimal"])
      .describe("Current session mode after exiting plan mode."),
    allowedPrompts: z.array(ExitPlanModeAllowedPromptSchema).optional(),
    // 批准确认窗上用户指定的执行模型；缺省 = 跟随会话模型（同回合继续，现行行为）。
    executionModelSelection: ExecutionModelSelectionSchema.optional(),
  })
  .strict();
export type ExitPlanModeOutput = z.infer<typeof ExitPlanModeOutputSchema>;
export const ExitPlanModeOutputJsonSchema = toToolJsonSchema(ExitPlanModeOutputSchema);

export interface SessionModeTransitionInput {
  toolCallId?: string;
  traceContext?: TraceContext;
}

export interface EnterPlanModeTransitionResult {
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface ExitPlanModeTransitionResult {
  mode: Exclude<CollaborationMode, "plan">;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface SessionModePort {
  supportsPermissionFullAccess?(): boolean;
  isPlanEnabled?(): boolean;
  getMode(): CollaborationMode;
  getPrePlanMode(): Exclude<CollaborationMode, "plan"> | undefined;
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
  exitPlanMode(input?: SessionModeTransitionInput): Promise<ExitPlanModeTransitionResult>;
}
