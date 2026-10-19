// ============================================================
// Context Builder - System prompt assembly
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import type {
  ContextMetaUserAttachment,
  ContextSection,
  ContextBuildResult,
  ContextBuilderConfig,
  EnvInfo,
} from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import { estimateTokens } from "./utils.js";
import { buildCliPrefixSection } from "./sections/cli-prefix.js";
import { buildIdentitySection } from "./sections/identity.js";
import { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
import { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
import { buildSessionExecutionSection } from "./sections/session-execution.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildRequestUserContextSection } from "./sections/request-user-context.js";
import { buildCurrentDateSection } from "./sections/current-date.js";
import { buildMemorySection } from "./sections/memory.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../memory/project-memory-retrieval-branch.js";
import { buildDesktopContextSection } from "./sections/desktop.js";
import { buildMinimalGuardrailsSection } from "./sections/minimal-guardrails.js";
import {
  buildContextManagementSection,
  buildDynamicBehaviorSection,
  buildOutputStyleSection,
  buildSessionGuidanceSection,
} from "./dynamic-sections.js";
import {
  buildFusionBehaviorSection,
  buildFusionContextManagementSection,
} from "./fusion-sections.js";
import {
  buildContextMetaUserBody as buildContextMetaUserBodyImpl,
  buildSkillsMetaUserBody as buildSkillsMetaUserBodyImpl,
} from "./meta-user-body.js";
import {
  assembleMetaUserAttachments,
  assembleSystemMessages,
  orderSectionsForInjection,
} from "./message-assembly.js";

// -----------------------------------------------
// Context Builder
// -----------------------------------------------

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };
/** Skill 工具的注册名（与 tool/handlers/skill.ts 的 metadata.name 同字面；contracts 没有常量）。 */
const SKILL_TOOL_NAME = "Skill";

export class ContextBuilder {
  private config: ContextBuilderConfig;
  private customSections: ContextSection[] = [];

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  /**
   * 保留兼容入口。工具说明由 model request 的 tools 字段承载，不再镜像进 system prompt。
   */
  setToolRegistry(_registry: ToolRegistry): this {
    return this;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = {
      ...this.config,
      envInfo,
    };
    return this;
  }

  /**
   * 添加自定义 section（用于后续扩展）
   */
  addSection(
    section: Omit<ContextSection, "chars" | "tokens" | "injectionTarget" | "cacheHint"> &
      Partial<Pick<ContextSection, "injectionTarget" | "cacheHint">>,
  ): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: estimateTokens(section.content),
    });
    return this;
  }

  /**
   * 构建 context，返回结构化结果
   */
  build(): ContextBuildResult {
    const sections: ContextSection[] = [];
    // 执行环境是实时状态：切换后下一轮 build 直接读取当前 binding，
    // 不依赖持久化快照。local/未注入时为 undefined，提示词与改动前一致。
    const sessionExecutionEnvironment = this.config.getSessionExecutionEnvironment?.();
    const activeOutputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    const customSystemPrompt = this.config.customSystemPrompt?.trim();
    const hasCustomSystemPrompt = Boolean(customSystemPrompt);
    // 工作流子代理身份：第三条路径。与
    // customSystemPrompt 互斥——两者同在只可能是接线错误（persona 该经 workflowActor 进来，
    // 不该再塞 systemPrompt），大声失败而不是默默二选一。
    const workflowActor = this.config.workflowActor;
    if (workflowActor !== undefined && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: workflowActor and customSystemPrompt are mutually exclusive",
      );
    }
    const isWorkflowActor = workflowActor !== undefined;
    const isMinimalProfile = this.config.promptProfile === "minimal";
    // 融合只属于主代理默认身份路径；customSystemPrompt / workflowActor 保留自身契约，
    // 不注入融合交互行为（见 fusion-context-profile.md）。
    const useFusionSections =
      this.config.promptProfile === "fusion" && !hasCustomSystemPrompt && !isWorkflowActor;
    // 三条身份路径互斥：极简档位不该同时拿到自定义提示词或子代理身份，
    // 同时在场只可能是接线错误，大声失败而不是默默让其中一条生效。
    if (isMinimalProfile && hasCustomSystemPrompt) {
      throw new Error(
        "ContextBuilder: promptProfile=minimal and customSystemPrompt are mutually exclusive",
      );
    }
    if (isMinimalProfile && isWorkflowActor) {
      throw new Error(
        "ContextBuilder: promptProfile=minimal and workflowActor are mutually exclusive",
      );
    }

    // 1. CLI / product prefix. Keep this as the short leading identity block.
    // 「You are ZCode, an interactive coding agent」对一个
    // 只对脚本说话、可能连读文件工具都没有的子代理是错的身份，且走在正确身份段前面。
    if (!isWorkflowActor) {
      sections.push(buildCliPrefixSection());
    }

    // 2. Stable agent behavior or custom prompt body
    if (hasCustomSystemPrompt) {
      sections.push(
        createSection({
          name: "Custom System Prompt",
          source: "custom_system_prompt",
          injectionTarget: "system",
          cacheHint: "stable",
          content: customSystemPrompt ? `\n${customSystemPrompt}` : "",
        }),
      );
    } else if (workflowActor !== undefined) {
      sections.push(buildWorkflowActorIdentitySection(workflowActor));
    } else if (!isMinimalProfile) {
      // 极简模式刻意不发身份行为段：身份只保留上面 CLI prefix 的一行。
      sections.push(buildIdentitySection(activeOutputStyle));
    }

    // 3. Dynamic system context
    // custom prompt 不是只替换
    // stable body，而是跳过默认 system prompt 体系和 systemContext；否则用户提供
    // custom prompt 后仍会混入 Session Guidance / output style 等动态 system 段。
    // 工作流子代理跳过其中面向「与用户对话」的三段（desktop、Dynamic Behavior、session
    // guidance——契约里已把 Report outcomes faithfully 搬过去），保留 memory 与其后各段。
    if (isMinimalProfile) {
      // 极简模式只保留环境（工作目录 / 平台）：desktop context、Dynamic Behavior、
      // session guidance、memory、output style、context management、git 段全部不发。
      // 但该模式是自动执行权限，护栏段必须留在场——否则模型手里一条防线都没有。
      sections.push(
        buildEnvInfoSection(this.config.envInfo, this.config.model, sessionExecutionEnvironment),
      );
      sections.push(buildMinimalGuardrailsSection());
    } else if (!hasCustomSystemPrompt) {
      if (!isWorkflowActor && this.config.presentationSurface === "zcode_desktop") {
        sections.push(buildDesktopContextSection(this.config.genUiOutputDirectory));
      }

      // behaviour part right after stable sp...
      if (!isWorkflowActor) {
        if (useFusionSections) {
          sections.push(
            buildFusionBehaviorSection({
              agentGuidance: (this.config.guidanceToolNames ?? []).includes("Agent"),
            }),
          );
        } else {
          sections.push(buildDynamicBehaviorSection());
        }
      }

      // Session-specific guidance
      const sessionGuidanceSection = isWorkflowActor
        ? null
        : buildSessionGuidanceSection(
            this.config.guidanceToolNames ?? [],
            (this.config.skills?.skills.length ?? 0) > 0,
          );
      if (sessionGuidanceSection) {
        sections.push(sessionGuidanceSection);
      }

      // Memory
      if (this.config.memoryRoot) {
        const memorySection = buildMemorySection(
          this.config.memoryRoot,
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        if (memorySection) {
          sections.push(memorySection);
        }
      }
      sections.push(
        buildEnvInfoSection(this.config.envInfo, this.config.model, sessionExecutionEnvironment),
      );

      // Output Style
      const outputStyleSection = buildOutputStyleSection(activeOutputStyle);
      if (outputStyleSection) {
        sections.push(outputStyleSection);
      }

      // Context Management
      sections.push(
        useFusionSections ? buildFusionContextManagementSection() : buildContextManagementSection(),
      );

      const gitSystemContextSection = buildGitSystemContextSection(this.config.envInfo);
      if (gitSystemContextSection) {
        sections.push(gitSystemContextSection);
      }
    }

    // 执行环境路由：只在 WSL binding 真正生效时注入；local/未注入时完全缺席。
    // 极简档位与工作流子代理使用紧凑版，避免挤占体积预算。
    const sessionExecutionSection = buildSessionExecutionSection(sessionExecutionEnvironment, {
      compact: isMinimalProfile || isWorkflowActor,
    });
    if (sessionExecutionSection) {
      sections.push(sessionExecutionSection);
    }

    // 4. Skills appear as a meta user system-reminder, matching provider block layout.
    // guidanceToolNames 是 runtime 当下的
    // 工具表；一个 Skill 工具未注册的工作流子代理被告知「以下技能可经 Skill 工具使用」，
    // 只会让它相信自己有一个没有的工具。表缺席（测试 / 旧调用方）时保持既有行为。
    if (!isMinimalProfile && this.config.skills && this.skillToolAvailable()) {
      const skillsSection = buildSkillsSection({
        outcome: this.config.skills,
        metadataBudget: this.config.skillMetadataBudget,
      });
      if (skillsSection) {
        sections.push(skillsSection);
      }
    }

    // 5. Meta user context: workspace instructions/project memory first, date second.
    // 极简模式连 meta_user 附件一起不发：workspace instructions / 项目记忆 / 当前日期
    // 都不进请求，因此本段整体跳过。
    if (!isMinimalProfile) {
      const requestUserContextSection = buildRequestUserContextSection({
        userInstructions: this.config.userInstructions,
        memoryIndexContent: this.config.memoryIndexContent,
        memoryRoot: this.config.memoryRoot,
      });
      if (requestUserContextSection) {
        sections.push(requestUserContextSection);
      }

      const currentDateSection = buildCurrentDateSection(this.config.currentDate);
      if (currentDateSection) {
        sections.push(currentDateSection);
      }
    }

    // 6. Custom sections
    if (!isMinimalProfile) {
      sections.push(...this.customSections);
    }

    const orderedSections = orderSectionsForInjection(sections);

    // 计算总计
    const totalChars = orderedSections.reduce((sum, s) => sum + s.chars, 0);
    const totalTokens = orderedSections.reduce((sum, s) => sum + s.tokens, 0);

    const systemMessages = assembleSystemMessages(orderedSections);
    const metaUserAttachments = assembleMetaUserAttachments(orderedSections);

    return {
      sections: orderedSections,
      totalChars,
      totalTokens,
      systemMessages,
      metaUserAttachments,
    };
  }

  private skillToolAvailable(): boolean {
    const names = this.config.guidanceToolNames;
    return names === undefined || names.includes(SKILL_TOOL_NAME);
  }
}

export { orderSectionsForInjection } from "./message-assembly.js";

export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  return buildContextMetaUserBodyImpl(sections);
}

export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  return buildSkillsMetaUserBodyImpl(sections);
}

function createSection(input: {
  name: string;
  source: ContextSection["source"];
  injectionTarget: ContextSection["injectionTarget"];
  cacheHint: ContextSection["cacheHint"];
  content: string;
}): ContextSection {
  return {
    ...input,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    preview: input.content.slice(0, 100),
  };
}

// -----------------------------------------------
// Factory
// -----------------------------------------------

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
