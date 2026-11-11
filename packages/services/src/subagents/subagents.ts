import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
  ExternalAgentPresetStatus,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** 只写用户 state 的完整覆盖，不改插件 Markdown。 */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /**
   * 内置身份的执行渠道覆盖（S7）。presetId 缺省 = 恢复 ZCode 内置执行。
   *
   * fail-closed：preset 未标渠道就绪 / Explore 未声明只读档位 / 探测确认不可用，
   * 一律抛错拒绝写入。
   */
  setBuiltInExecutionChannel(params: {
    agentName: "general-purpose" | "Explore";
    presetId?: string;
    /** 传给 CLI 的模型名（原样透传）；缺省 = CLI 默认。 */
    model?: string;
    /** 推理档位；探测目录含所选模型时必须在其候选内。 */
    effort?: string;
    /** 上下文窗口（token）；UI 首期不暴露。 */
    contextWindow?: number;
  }): Promise<void>;

  /** 当前筛选来源对应的用户级 agent 根目录（与内置扫描顺序一致，取 buildUserRoots 的首项）。 */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** 创建新的 agent 文件 */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** 更新现有 agent 文件 */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** 删除 agent 文件 */
  deleteAgent(params: AgentDeleteParams): Promise<void>;

  /**
   * 探测本机可绑定外部 CLI 预设的安装/版本/模型目录（只读、无状态）。
   *
   * 供设置页创建/编辑外部 agent 的表单消费（S6）。未接入执行通道（CLI 环境、
   * 未注入探测实现）返回 null —— UI 退回静态预设目录 + 自由输入模型，功能不残废。
   * 探测编排与绑定对话框的 v4 RPC 同源（shared/node probeExternalPresets），
   * 但只探本机：远端设备 scope 的表单同样走降级路径，不做转发。
   */
  probeExternalAgents(): Promise<ExternalAgentPresetStatus[] | null>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);
