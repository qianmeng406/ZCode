// ============================================================
// Context Builder Types
// ============================================================

import type {
  EnvInfo,
  Model,
  ModelInputMessage,
  ProjectContext,
  ResolvedUserInstructions,
  SkillLoadOutcome,
  UserInstructionsOptions,
} from "@zcode/contracts";
import type { AutoCompactPolicyConfig } from "../compact/index.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { SessionExecutionEnvironment } from "@zcode/shared";

export type {
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@zcode/contracts";

// -----------------------------------------------
// Context Source
// -----------------------------------------------

export type ContextSource =
  | "cli_prefix" // CLI / 产品身份前缀
  | "identity" // Agent 基础描述
  | "env_info" // 环境信息 (cwd, platform, git repo boolean)
  | "session_execution" // 会话执行环境路由（仅 WSL 激活时存在）
  | "system_context" // git snapshot context
  | "skills" // 可用 skills
  | "tools" // 工具定义
  | "request_user_context" // request-level user context provider-visible 组合块
  | "memory" // 长期 memory read path
  | "current_date" // 当前日期
  | "custom_system_prompt" // 自定义 stable system body
  | "workflow_actor_identity" // 动态工作流子代理身份：契约 + persona 叠加
  | "subagent_agent_prompt" // 子 agent 专属身份/任务 prompt
  | "subagent_notes" // 子 agent 通用操作提醒
  | "subagent_environment" // 子 agent 环境和模型上下文
  | "dynamic_behavior" // 动态行为边界
  | "session_guidance" // 当前可用内置能力指导
  | "output_style" // 输出风格
  | "context_management" // 长上下文管理提示
  | "desktop_context" // ZCode Desktop 渲染与交互协议
  | "minimal_guardrails" // 极简模式的最简护栏（该模式没有其余任何指引）
  | "fusion_behavior" // 融合档位的行为段（替换默认 Dynamic Behavior）
  | "fusion_context_management"; // 融合档位的上下文连续性段（替换默认 Context Management）

export type ContextInjectionTarget = "system" | "meta_user";

export type ContextCacheHint = "stable" | "dynamic";

export type PresentationSurface = "terminal" | "zcode_desktop";

// -----------------------------------------------
// Context Section
// -----------------------------------------------

export interface ContextSection {
  name: string; // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: ContextInjectionTarget; // 注入位置
  cacheHint: ContextCacheHint; // 缓存稳定性提示
  chars: number; // 字符数
  tokens: number; // 估算 token 数
  content: string; // 完整内容
  preview: string; // 前 100 字符预览
}

export type ContextMetaUserAttachmentSource = "skills_listing" | "context_prefix";

export interface ContextMetaUserAttachment {
  source: ContextMetaUserAttachmentSource;
  content: string;
}

// -----------------------------------------------
// Context Build Result
// -----------------------------------------------

export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: ModelInputMessage[]; // ContextBuilder 只组装 system messages
  metaUserAttachments: ContextMetaUserAttachment[]; // 未包裹 <system-reminder> 的 meta user body
}

export interface OutputStylePromptConfig {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

// -----------------------------------------------
// Context Builder Config
// -----------------------------------------------

export interface ContextBuilderConfig {
  workingDirectory: string;
  envInfo: EnvInfo;
  /** 当前步骤的执行对象，不进入 Context Source 或持久化环境快照。 */
  model?: Model;
  presentationSurface?: PresentationSurface;
  genUiOutputDirectory?: string;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  memoryRoot?: string;
  memoryIndexContent?: string;
  skills?: SkillLoadOutcome;
  agentProfiles?: readonly AgentProfile[];
  embeddedSearchEnabled?: boolean;
  skillMetadataBudget?: number;
  /**
   * 当前会话实际生效的执行环境（实时读取）。仅 WSL 激活时返回 wsl；
   * local/未注入时返回 undefined，提示词与改动前完全一致。
   */
  getSessionExecutionEnvironment?: () => SessionExecutionEnvironment | undefined;
  customSystemPrompt?: string;
  /**
   * 动态工作流子代理（workflow child）的身份输入。在场即走 builder 的第三条路径：
   * 基座段（CLI prefix、安全行、Harness、memory）+ 工作流子代理契约 + persona 叠加，
   * 而不是像 `customSystemPrompt` 那样整段替换。与 `customSystemPrompt` 互斥。
   */
  workflowActor?: WorkflowActorContext;
  /**
   * 提示词档位。`minimal` 只下发身份行 + 环境（工作目录/平台），
   * 其余段（身份行为、desktop context、session guidance、memory、output style、
   * context management、git、skills、workspace instructions、当前日期）与 meta_user
   * 附件全部不发；工具说明本就由 model request 的 tools 字段承载，不在 system 段内。
   * 缺省即 `default`。仅极简模式使用；与 `customSystemPrompt` / `workflowActor` 不同路径，
   * 三者同时在场属于接线错误，builder 会大声失败。
   *
   * `fusion` 只替换默认 Dynamic Behavior 与 Context Management 两个动态段，其余段与
   * meta_user 附件全部保留（见 docs/design/v2/loop/fusion-context-profile.md）。与
   * `customSystemPrompt` / `workflowActor` 不互斥：后两者保持各自身份契约，跳过融合
   * 交互行为段，builder 不为这种组合失败。
   */
  promptProfile?: "default" | "minimal" | "fusion";
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  compact?: AutoCompactPolicyConfig;
  guidanceToolNames?: readonly string[];
}

/**
 * 工作流子代理的身份输入：有效名（匿名缺席）、作者写的 persona system prompt（可缺席）。
 * 没有工具档位：每个子代理都有完整工作工具集，契约只有一份文本。
 */
export interface WorkflowActorContext {
  name?: string;
  persona?: string;
}

export type ContextUserInstructionsRequest = UserInstructionsOptions;
