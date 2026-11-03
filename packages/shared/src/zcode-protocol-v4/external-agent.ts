import { z } from "zod";
import {
  EXTERNAL_AGENT_DRIVER_KINDS,
  EXTERNAL_AGENT_PROMPT_DELIVERIES,
} from "../externalAgentBinding.js";

// ── 会话外部 agent 绑定的投影状态 ──
// 只下发 UI 需要的事实：绑了谁、什么档位、是否处于只读主控。argv/env 等执行细节
// 留在 session entry 里，不进快照——快照会被广播给所有订阅者，不是配置读回通道。
export const externalAgentStateSchema = z.object({
  label: z.string().min(1),
  driver: z.enum(EXTERNAL_AGENT_DRIVER_KINDS),
  command: z.string().min(1),
  promptDelivery: z.enum(EXTERNAL_AGENT_PROMPT_DELIVERIES),
  permissionMode: z.string().optional(),
  /** 来自哪个内置预设；UI 据此回显"已适配"标记与预设名。 */
  presetId: z.string().optional(),
  /** 当前使用的模型（缺省 = 该 CLI 的默认模型）。 */
  model: z.string().optional(),
  /** 当前**这个模型**的推理档位（缺省 = 该模型用 CLI 默认档位）。 */
  effort: z.string().optional(),
  /**
   * 当前模型可选的档位（空 = 该模型没有已知档位能力，UI 不显示档位入口）。
   *
   * 由 CLI 侧按"当前模型"解析后下发：档位是模型能力，UI 不该自己拼一张全局表。
   */
  effortLevels: z.array(z.string()).default([]),
  /** 当前续接的外部会话 id（缺省 = 每次委派由 CLI 开新会话）。 */
  externalSessionId: z.string().optional(),
  /** 绑定强制开启了只读主控：UI 据此显示只读徽标并禁用模式切换。 */
  readOnly: z.literal(true),
});
export type ExternalAgentState = z.infer<typeof externalAgentStateSchema>;

/**
 * 外部 agent 的实时活动（独立卡片的数据源）。
 *
 * 与工具行解耦：后台任务启动后工具行立即结算，而外部 agent 可能还要跑十几分钟。
 * 这张卡只回答三个问题：谁在跑、跑了多久、最近在干什么。
 */
export const externalAgentActivitySchema = z.object({
  taskId: z.string().min(1),
  agentLabel: z.string().min(1),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  /** 开始时间（epoch ms）：UI 本地计时，避免每秒一条事件。 */
  startedAt: z.number().int(),
  /** 已运行时长（结束时是总时长）。 */
  elapsedMs: z.number().int().nonnegative(),
  /** 最近输出尾部（纯文本兜底）。 */
  tail: z.string().optional(),
  /** 结构化活动条目（思考/正文/工具）。 */
  entries: z
    .array(z.object({ kind: z.enum(["reasoning", "text", "tool"]), text: z.string() }).strict())
    .optional(),
  /** 失败/取消原因摘要。 */
  error: z.string().optional(),
});
export type ExternalAgentActivity = z.infer<typeof externalAgentActivitySchema>;
