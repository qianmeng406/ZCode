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

/** 与 shared 顶层同形（两个定义必须一致；此处只做类型对齐，避免两份漂移）。 */
export type { ExternalAgentPresetStatus };
