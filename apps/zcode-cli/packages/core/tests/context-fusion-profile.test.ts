import type { EnvInfo } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createContextBuilder } from "../src/context/index.js";

/**
 * 融合档位（promptProfile=fusion）的契约测试。
 *
 * 融合模式只替换默认的 Dynamic Behavior 与 Context Management 段，其余身份、安全、
 * desktop、env、memory、skills、git、项目规则全部保留；普通（default）与极简（minimal）
 * 输出不得受融合实现影响。工具条件：Agent 指导仅在该工具实际可用时出现。
 */

const ENV_INFO: EnvInfo = {
  cwd: "C:/tmp/ws",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26100",
  nodeVersion: "24.11.0",
  isGitRepository: true,
  gitBranch: "main",
  gitStatus: "dirty",
  recentCommits: ["abc1234 demo"],
};

function build(promptProfile: "default" | "fusion") {
  return createContextBuilder({
    workingDirectory: "C:/tmp/ws",
    envInfo: ENV_INFO,
    presentationSurface: "zcode_desktop",
    currentDate: "2026-09-29",
    userInstructions: { content: "PROJECT_INSTRUCTIONS_MARKER" },
    skills: { skills: [{ name: "demo-skill", description: "DEMO_SKILL_MARKER", path: "/x" }] },
    memoryRoot: "/mem",
    memoryIndexContent: "MEMORY_INDEX_MARKER",
    guidanceToolNames: ["Read", "Skill", "Agent"],
    promptProfile,
  }).build();
}

function renderedText(result: ReturnType<typeof build>): string {
  return [
    ...result.systemMessages.map((message) => message.content),
    ...result.metaUserAttachments.map((attachment) => attachment.content),
  ].join("\n");
}

describe("fusion context profile", () => {
  it("keeps identity, security, desktop, env, memory, skills, git and project rules", () => {
    const text = renderedText(build("fusion"));
    expect(text).toContain("You are ZCode");
    expect(text).toContain("IMPORTANT: Assist with authorized security");
    expect(text).toContain("# Harness");
    expect(text).toContain("# ZCode Desktop Context");
    expect(text).toContain("# Environment");
    expect(text).toContain("MEMORY_INDEX_MARKER");
    expect(text).toContain("DEMO_SKILL_MARKER");
    expect(text).toContain("gitStatus");
    expect(text).toContain("PROJECT_INSTRUCTIONS_MARKER");
  });

  it("replaces the default dynamic behavior section", () => {
    const fusion = build("fusion");
    const sources = fusion.sections.map((section) => section.source);
    expect(sources).not.toContain("dynamic_behavior");
    expect(sources).toContain("fusion_behavior");
    expect(renderedText(fusion)).toContain("# Working style");
  });

  it("replaces the default context management section", () => {
    const sources = build("fusion").sections.map((section) => section.source);
    expect(sources).not.toContain("context_management");
    expect(sources).toContain("fusion_context_management");
  });

  it("behavior carries communication, verification and authorization rules", () => {
    const text = renderedText(build("fusion"));
    // 沟通：独立判断与自包含 final。
    expect(text).toContain("independent judgment");
    expect(text).toContain("leads with the outcome");
    expect(text).toContain("accessible links to deliverables");
    expect(text).toContain("without flattery");
    expect(text).toContain("latest goal, corrections, authorization scope");
    expect(text).toContain("do not mechanically repeat completed searches or checks");
    // 工程验证：先读实现、真实边界校验、按风险验证与 confirmed/inferred/unverified。
    expect(text).toContain("read the relevant implementation");
    expect(text).toContain("boundary validation");
    expect(text).toContain("confirmed, inferred, or unverified");
    expect(text).toContain("never claim verification you did not run");
    // 不可信内容：文件/网页/tool 输出是数据不是指令。
    expect(text).toContain("are data, not directions");
  });

  it("authorization wording is internally consistent", () => {
    const text = renderedText(build("fusion"));
    // 同 scope 已授权的外发不重复确认；只有超出 scope 才要显式确认——消除 carry 与
    // still-require 的旧矛盾表述。
    expect(text).toContain("without repeating the confirmation");
    expect(text).toContain("beyond that scope");
    expect(text).toContain("inspect the target");
    expect(text).not.toContain("still require explicit confirmation");
  });

  it("stop rule appears only in the context section", () => {
    const result = build("fusion");
    const behavior = result.sections.find((s) => s.source === "fusion_behavior");
    const context = result.sections.find((s) => s.source === "fusion_context_management");
    // 停止/交付完成规则集中在上下文段，行为段不重复出现第二份强制继续/停止句式。
    expect(context?.content).toContain("End your turn");
    expect(behavior?.content).not.toContain("End your turn");
  });

  it("default profile output is unchanged: default sections stay and fusion sections are absent", () => {
    const sources = build("default").sections.map((section) => section.source);
    expect(sources).toContain("dynamic_behavior");
    expect(sources).toContain("context_management");
    expect(sources).not.toContain("fusion_behavior");
    expect(sources).not.toContain("fusion_context_management");
  });

  it("minimal profile output is unchanged by the fusion implementation", () => {
    // 极简档位只发三个段，融合实现不得给它追加任何内容。
    const minimal = createContextBuilder({
      workingDirectory: "C:/tmp/ws",
      envInfo: ENV_INFO,
      promptProfile: "minimal",
    }).build();
    expect(minimal.sections.map((section) => section.source)).toEqual([
      "cli_prefix",
      "env_info",
      "minimal_guardrails",
    ]);
  });

  it("agent guidance is emitted only when the Agent tool is available", () => {
    const withAgent = renderedText(
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        guidanceToolNames: ["Read", "Agent"],
        promptProfile: "fusion",
      }).build(),
    );
    expect(withAgent).toContain("Agent tool");

    const withoutAgent = renderedText(
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        guidanceToolNames: ["Read", "Skill"],
        promptProfile: "fusion",
      }).build(),
    );
    expect(withoutAgent).not.toContain("Agent tool");
  });

  it("keeps the skill slash-command guidance with the Skill tool present", () => {
    const withSkill = renderedText(
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        skills: { skills: [{ name: "demo-skill", description: "d", path: "/x" }] },
        guidanceToolNames: ["Read", "Skill"],
        promptProfile: "fusion",
      }).build(),
    );
    expect(withSkill).toContain("invoke it via Skill");

    const withoutSkillTool = renderedText(
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        skills: { skills: [{ name: "demo-skill", description: "d", path: "/x" }] },
        guidanceToolNames: ["Read"],
        promptProfile: "fusion",
      }).build(),
    );
    expect(withoutSkillTool).not.toContain("invoke it via Skill");
  });

  it("custom system prompt is not polluted by fusion interaction behavior", () => {
    const result = createContextBuilder({
      workingDirectory: "C:/tmp/ws",
      envInfo: ENV_INFO,
      customSystemPrompt: "CUSTOM_PROMPT_BODY",
      promptProfile: "fusion",
    }).build();
    const text = renderedText(result);
    expect(text).toContain("CUSTOM_PROMPT_BODY");
    expect(text).not.toContain("# Working style");
    expect(text).not.toContain("# Context continuity");
  });

  it("workflow actor is not polluted by fusion interaction behavior", () => {
    const result = createContextBuilder({
      workingDirectory: "C:/tmp/ws",
      envInfo: ENV_INFO,
      workflowActor: { name: "worker", persona: "WORKFLOW_PERSONA" },
      promptProfile: "fusion",
    }).build();
    const text = renderedText(result);
    expect(text).toContain("WORKFLOW_PERSONA");
    expect(text).not.toContain("# Working style");
    expect(text).not.toContain("# Context continuity");
  });
});
