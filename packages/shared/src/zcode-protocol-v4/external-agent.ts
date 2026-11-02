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
  /** 当前推理档位（缺省 = 该 CLI 的默认档位）。 */
  effort: z.string().optional(),
  /** 绑定强制开启了只读主控：UI 据此显示只读徽标并禁用模式切换。 */
  readOnly: z.literal(true),
});
export type ExternalAgentState = z.infer<typeof externalAgentStateSchema>;
