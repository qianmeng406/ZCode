import { basename } from "node:path";
import { GENERAL_PURPOSE_AGENT_TYPE, buildGeneralPurposeSystemPrompt, buildExternalGeneralPurposeSystemPrompt } from "./general-purpose.js";
import { EXPLORE_AGENT_TYPE, buildExternalExploreSystemPrompt } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import {
  findExternalAgentPreset,
  isChannelReadyPreset,
  type BuiltInExecutionChannelOverrides,
  type ModelSelection,
  type AgentProfile,
} from "@zcode/shared";
export { parseAgentProfileFromMarkdown } from "@zcode/shared";
export type {
  AgentProfile,
  AgentPermissionMode,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
  AgentProfileLoadResult,
} from "@zcode/shared";

export const DEFAULT_SUBAGENT_TYPE = GENERAL_PURPOSE_AGENT_TYPE;

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<typeof DEFAULT_SUBAGENT_TYPE | typeof EXPLORE_AGENT_TYPE, ModelSelection>
>;

/**
 * 渠道覆盖 → 实际生效的 preset id（fail-closed 收敛点）。
 *
 * 三层防线里的最后一道（前两层：UI 候选不出现、services 写入拒绝）：state 文件
 * 被手改绕过 UI 也产不出半残渠道——preset 未标 `subagentChannelReady`（含不存在）
 * 一律回 native。Explore 额外要求 preset 声明只读档位，否则同样忽略：
 * 外部 Explore 没有 ZCode 工具白名单，只读完全靠 CLI 侧 plan 模式，没声明的
 * CLI 承接不了这个承诺。
 */
function resolveEffectiveChannelPreset(
  channelPresetId: string | undefined,
  requireReadOnlyMode: boolean,
): string | undefined {
  if (!channelPresetId || !isChannelReadyPreset(channelPresetId)) return undefined;
  const preset = findExternalAgentPreset(channelPresetId);
  if (requireReadOnlyMode && preset?.readOnlyPermissionMode === undefined) return undefined;
  return channelPresetId;
}

export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection; channelPresetId?: string } = {},
): AgentProfile {
  const channelPresetId = resolveEffectiveChannelPreset(options.channelPresetId, true);
  const readOnlyMode = channelPresetId
    ? findExternalAgentPreset(channelPresetId)?.readOnlyPermissionMode
    : undefined;
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches — when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    // 外部渠道下 injectAgentsMd/tools 是 native 专属语义（S6 同口径）：不写。
    ...(channelPresetId
      ? {
          backend: "external" as const,
          preset: channelPresetId,
          // 只读档位以 profile.permissionMode 承载 → 端口转 binding 覆盖（S7 §3.2）。
          permissionMode: readOnlyMode as AgentProfile["permissionMode"],
          systemPrompt: buildExternalExploreSystemPrompt(),
        }
      : {
          injectAgentsMd: false,
          systemPrompt: "",
          tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
        }),
    // modelSelection 与渠道互斥（两种 model 语义，S6 同口径）。
    ...(channelPresetId ? {} : (options.modelSelection ? { modelSelection: options.modelSelection } : {})),
    source: "built-in",
  };
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // 用户/项目 profile 可以同名覆盖内置 Explore，不能只按名称套用内置行为。
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
    /** 内置身份的执行渠道覆盖（S7）；达标的 preset 才生效（见 resolveEffectiveChannelPreset）。 */
    builtInExecutionChannel?: BuiltInExecutionChannelOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const channels = options.builtInExecutionChannel ?? {};
  const active = new Map<string, AgentProfile>();
  active.set(
    DEFAULT_SUBAGENT_TYPE,
    createBuiltInGeneralPurposeAgentProfile({
      modelSelection: overrides[DEFAULT_SUBAGENT_TYPE],
      channelPresetId: channels[DEFAULT_SUBAGENT_TYPE]?.presetId,
    }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
      channelPresetId: channels[EXPLORE_AGENT_TYPE]?.presetId,
    }),
  );
  for (const profile of profiles) {
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

export function createBuiltInGeneralPurposeAgentProfile(
  options: { modelSelection?: ModelSelection; channelPresetId?: string } = {},
): AgentProfile {
  const channelPresetId = resolveEffectiveChannelPreset(options.channelPresetId, false);
  return {
    name: DEFAULT_SUBAGENT_TYPE,
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
    color: "blue",
    ...(channelPresetId
      ? {
          // 执行型身份与外部 bypassPermissions 语义≈等价，不需要 profile 级档位覆盖。
          backend: "external" as const,
          preset: channelPresetId,
          systemPrompt: buildExternalGeneralPurposeSystemPrompt(),
        }
      : {
          injectAgentsMd: true,
          systemPrompt: buildGeneralPurposeSystemPrompt(),
          tools: ["*"],
        }),
    // modelSelection 与渠道互斥（两种 model 语义，S6 同口径）。
    ...(channelPresetId ? {} : (options.modelSelection ? { modelSelection: options.modelSelection } : {})),
    source: "built-in",
  };
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  const active = normalizeAgentProfiles(profiles);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => formatAgentProfileForPrompt(profile, options)),
  ].join("\n");
}

export function formatAgentProfileForPrompt(
  profile: Readonly<AgentProfile>,
  options: { embeddedSearchEnabled?: boolean } = {},
): string {
  // 外部后端不能按"工具集"描述：那些工具是 ZCode 子智能体的限制，对跑在与
  // ZCode 无关进程里的 CLI 不成立。谎报可用工具会让主 agent 误判它能做什么、
  // 以及自己是否已经限制了它。
  if (profile.backend === "external") {
    const preset = profile.preset ? ` ${profile.preset}` : "";
    const detail = [
      profile.model ? `model: ${profile.model}` : undefined,
      profile.effort ? `effort: ${profile.effort}` : undefined,
      profile.contextWindow ? `contextWindow: ${profile.contextWindow}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const note = "runs as its own CLI process; ZCode tool permissions do not apply to it";
    return `- ${profile.name}: ${profile.description} (External CLI${preset}: ${detail ? `${detail}; ` : ""}${note})`;
  }
  const tools = isBuiltInExploreAgentProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const toolText = typeof tools === "string" ? tools : tools?.join(", ");
  return `- ${profile.name}: ${profile.description}${toolText ? ` (Tools: ${toolText})` : ""}`;
}

export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}
