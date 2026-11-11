import { z } from "zod";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";
import type { AgentPermissionMode } from "./subagents-types.js";

export type AgentProfileSource = "built-in" | "project" | "user";
export type AgentMemoryScope = "user" | "project" | "local";

/**
 * 子智能体的执行后端。
 *
 * - `native`（缺省）：ZCode 自己的 AgentRuntime，profile 的 model/tools/skills 全部生效；
 * - `external`：由外部 coding CLI 执行，profile 只声明"用哪个预设"，其余执行细节
 *   交给预设（模型/档位/上下文窗口来自 profile 的可选覆盖）。
 *
 * 为什么必须是显式字段：把外部 CLI 编码成 model/provider 别名会让整条链路
 * （权限、注入提示词、工具策略）以为自己在跑原生模型；而按 agent 名字猜后端
 * 只是把隐式耦合藏得更深。缺省 native 保证存量 profile 一个字不用改。
 */
export const AGENT_PROFILE_BACKENDS = ["native", "external"] as const;
export type AgentProfileBackend = (typeof AGENT_PROFILE_BACKENDS)[number];

export interface AgentProfile {
  background?: boolean;
  /** 执行后端；缺省 native。 */
  backend?: AgentProfileBackend;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
  description: string;
  disallowedTools?: readonly string[];
  injectAgentsMd?: boolean;
  maxTurns?: number;
  mcpServers?: readonly string[];
  memory?: AgentMemoryScope;
  /**
   * backend=external 时使用的上下文窗口（token）。
   *
   * 与绑定弹窗的「上下文大小」同义：只在预设声明了 `contextWindowFlag` 时才会
   * 变成命令行参数。缺省 = 预设默认。
   */
  contextWindow?: number;
  /** backend=external 时的推理档位（预设的 effort 值域内）；缺省 = CLI 默认。 */
  effort?: string;
  /**
   * backend=external 时使用的模型；缺省 = CLI 默认模型。
   *
   * 注意与 `modelSelection` 的区别：后者是**原生**子智能体的模型选择（走 provider
   * 目录），这里是外部 CLI 的 `--model` 值，原样透传给预设的 model flag。
   */
  model?: string;
  modelSelection?: ModelSelection;
  /**
   * backend=external 时使用的外部 agent 预设 id（`EXTERNAL_AGENT_PRESETS` 的 key）。
   *
   * 必须是 `adaptation: "full"` 的预设：半适配预设自己都不能正常跑，
   * 让模型通过 profile 去调用它只会得到含糊的失败。
   */
  preset?: string;
  name: string;
  path?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * permissionMode 只能收紧父会话模式。插件 loader 在 CLI 进程内设置；
   * 不进入下方跨进程 schema，若被跨边界发送，strict schema 会直接拒绝。
   */
  permissionModeRestrictOnly?: boolean;
  skills?: readonly string[];
  source: AgentProfileSource;
  systemPrompt: string;
  tools?: readonly string[];
}

export interface AgentProfileParseDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentProfileLoadResult {
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

/** 完整运行时 profile 的跨进程边界，不使用 Settings 摘要代替。 */
export const agentProfileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["built-in", "project", "user"]),
    systemPrompt: z.string(),
    path: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    background: z.boolean().optional(),
    injectAgentsMd: z.boolean().optional(),
    color: z
      .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
      .optional(),
    permissionMode: z
      .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
      .optional(),
    memory: z.enum(["user", "project", "local"]).optional(),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).readonly().optional(),
    disallowedTools: z.array(z.string()).readonly().optional(),
    skills: z.array(z.string()).readonly().optional(),
    mcpServers: z.array(z.string()).readonly().optional(),
    // 外部后端（2026-11-11）：一律 `.optional()`，绝不 `.default()`——定义为
    // `as const` 内置 profile 与插件快照会在 default 语义下被迫补字段，
    // 跨进程 strict schema 直接把它们拒掉（同 `modelListSkipHeader` 的坑）。
    backend: z.enum(AGENT_PROFILE_BACKENDS).optional(),
    preset: z.string().min(1).max(60).optional(),
    model: z.string().max(200).optional(),
    effort: z.string().max(40).optional(),
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();
