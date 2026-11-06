// 外部 coding agent 的绑定候选探测（只读查询）。
//
// 绑定对话框需要回答两件事：本机装了哪些已适配的 CLI、每个能用哪些模型。
// 这两件事都只能由 CLI 侧回答（进程边界在工作机上），所以收敛成一条 v4 查询，
// 而不是让 Host 自己 spawn。
//
// 只读、无状态、超时重发安全：同一参数多次调用等价，客户端不需要自己缓存。
import { z } from "zod";
import {
  externalAgentPresetSchema,
  type ExternalAgentPresetStatus,
} from "../externalAgentCatalog.js";
import { externalAgentTranscriptPageSchema } from "../externalAgentSessions.js";

const presetStatusSchema = z
  .object({
    preset: externalAgentPresetSchema,
    installed: z.boolean(),
    /** `--version` 首行；未安装时缺席。 */
    version: z.string().optional(),
    /** 模型候选；空 = 该 CLI 不支持枚举，UI 应退回自由输入。 */
    models: z.array(z.string()),
    /**
     * 逐模型档位事实（CLI 自带模型目录）。空 = 读不到目录，UI 退回静态兜底表。
     * 这是"某模型能选哪些档位"的唯一权威来源。
     */
    modelCatalog: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            supportedEfforts: z.array(z.string()),
            defaultEffort: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const v4ExternalAgentProbeParamsSchema = z
  .object({
    /** 会话 id：探测必须落到该会话真正执行的那台机器（远程会话的 CLI 在远端）。 */
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ExternalAgentProbeParams = z.infer<typeof v4ExternalAgentProbeParamsSchema>;

export const v4ExternalAgentProbeResultSchema = z
  .object({
    agents: z.array(presetStatusSchema),
  })
  .strict();
export type V4ExternalAgentProbeResult = z.infer<typeof v4ExternalAgentProbeResultSchema>;

// ── 历史会话列表（续接选择菜单）──
export const v4ExternalAgentSessionsParamsSchema = z
  .object({
    /** 会话 id：扫描落到该会话真正执行的那台机器（远程会话的 CLI 在远端）。 */
    sessionId: z.string().min(1),
  })
  .strict();
export type V4ExternalAgentSessionsParams = z.infer<typeof v4ExternalAgentSessionsParamsSchema>;

export const v4ExternalAgentSessionsResultSchema = z
  .object({
    sessions: z.array(
      z.object({
        /** CLI 自报的会话 id（`-r` 续接用它，可能 ≠ 文件名）。 */
        sessionId: z.string().min(1),
        title: z.string(),
        updatedAt: z.number().int(),
        preview: z.string().optional(),
      }),
    ),
  })
  .strict();
export type V4ExternalAgentSessionsResult = z.infer<typeof v4ExternalAgentSessionsResultSchema>;

// ── 删除一个外部会话（续接菜单的行内删除）──
// 幂等：本来就不存在时返回 deleted:false，不报错（与"删两次"等价）。
export const v4ExternalAgentDeleteSessionParamsSchema = z
  .object({
    /** zcode 会话 id：删除必须落到该会话真正执行的那台机器（远程会话的 CLI 在远端）。 */
    sessionId: z.string().min(1),
    /** 要删除的外部 CLI 会话 id。 */
    externalSessionId: z.string().min(1),
  })
  .strict();
export type V4ExternalAgentDeleteSessionParams = z.infer<
  typeof v4ExternalAgentDeleteSessionParamsSchema
>;

export const v4ExternalAgentDeleteSessionResultSchema = z
  .object({
    deleted: z.boolean(),
  })
  .strict();
export type V4ExternalAgentDeleteSessionResult = z.infer<
  typeof v4ExternalAgentDeleteSessionResultSchema
>;

// ── 外部会话的完整上下文（只读、无状态、可重发）──
// 游标是"条目序号"：会话文件只追加，已有条目的序号稳定，「加载更早」不会跳段。
export const v4ExternalAgentTranscriptParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    externalSessionId: z.string().min(1),
    /** 取 (before-limit, before) 这一段；缺省 = 最新的一页。 */
    before: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(60).optional(),
  })
  .strict();
export type V4ExternalAgentTranscriptParams = z.infer<typeof v4ExternalAgentTranscriptParamsSchema>;

export const v4ExternalAgentTranscriptResultSchema = externalAgentTranscriptPageSchema;
export type V4ExternalAgentTranscriptResult = z.infer<typeof v4ExternalAgentTranscriptResultSchema>;

/** 与 shared 顶层同形（两个定义必须一致；此处只做类型对齐，避免两份漂移）。 */
export type { ExternalAgentPresetStatus };
