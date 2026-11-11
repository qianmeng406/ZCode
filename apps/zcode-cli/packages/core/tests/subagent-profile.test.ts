import { describe, expect, it } from "vitest";
import {
  createBuiltInExploreAgentProfile,
  createBuiltInGeneralPurposeAgentProfile,
  formatAgentProfilesForPrompt,
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  parseAgentProfileFromMarkdown,
} from "../src/subagent/profile.js";

describe("subagent profile Markdown parser", () => {
  it.each(['{"providerId":"wrong","modelId":"wrong"}', "null", '{"modelId":"broken"}'])(
    "中间字段不参与正式 Markdown 读取：%s",
    (value) => {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review changes
modelSelection: ${value}
model: custom-openai/legacy
thoughtLevel: high
---
Review carefully.`,
      });
      expect(result.profile?.modelSelection).toEqual({
        providerId: "custom-openai",
        modelId: "legacy",
        options: { reasoningLevel: "high" },
      });
    },
  );

  it("parses only exact persistent memory scopes", () => {
    const exact = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
---
Review carefully.`,
    });
    const padded = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: " project "
---
Review carefully.`,
    });

    expect(exact.diagnostic).toBeUndefined();
    expect(exact.profile?.memory).toBe("project");
    expect(padded.diagnostic?.code).toBe("agent_invalid_memory_scope");
    expect(padded.profile).toMatchObject({ name: "reviewer", description: "Review changes" });
    expect(padded.profile?.memory).toBeUndefined();
  });

  it("preserves an explicitly empty tools list for persistent memory projection", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
tools: []
---
Review carefully.`,
    });

    expect(result.profile?.tools).toEqual([]);
  });

  it("parses the P0 custom agent fields consumed by zcode-cli", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      content: `---
name: zcode-reviewer
description: 检查实现边界\\n输出中文结论
model: custom-openai/reviewer-model
thoughtLevel: high
tools: Read, Grep Bash(ls -la)
disallowedTools:
  - Edit
  - Write
skills: code review
color: cyan
permissionMode: acceptEdits
maxTurns: "7"
background: "true"
injectAgentsMd: "false"
mcpServers:
  - local-tools
---
你是 zcode-reviewer。
只输出中文。`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile).toMatchObject({
      background: true,
      color: "cyan",
      description: "检查实现边界\n输出中文结论",
      disallowedTools: ["Edit", "Write"],
      maxTurns: 7,
      injectAgentsMd: false,
      modelSelection: {
        providerId: "custom-openai",
        modelId: "reviewer-model",
        options: { reasoningLevel: "high" },
      },
      name: "zcode-reviewer",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      skills: ["code", "review"],
      source: "project",
      systemPrompt: "你是 zcode-reviewer。\n只输出中文。",
      tools: ["Read", "Grep", "Bash"],
    });
    expect(result.profile?.mcpServers).toEqual(["local-tools"]);
    expect(result.profile?.permissionMode).toBeUndefined();
  });

  it("preserves concrete provider and custom model values from frontmatter", () => {
    const providerModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer.md",
      content: `---
name: reviewer
description: Use a concrete provider model
model: custom-openai/gpt-5.4
thoughtLevel: high
---
Review carefully.`,
    });
    const customModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer-custom.md",
      content: `---
name: reviewer-custom
description: Use the UI custom model value
model: custom:custom-openai:gpt-5.4
---
Review carefully.`,
    });

    expect(providerModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
    expect(customModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("accepts only server-name lists for mcpServers", () => {
    const invalidFrontmatterValues = [
      "mcpServers: local-tools",
      `mcpServers:
  local-tools:
    type: stdio`,
      "mcpServers: { local-tools: { type: stdio } }",
      "mcpServers: [{ type: stdio, command: local-mcp }]",
      "mcpServers: [local-tools, 42]",
      "mcpServers: [local-tools,, analytics]",
      "mcpServers: [null]",
      "mcpServers: [-1, 1.5]",
      "mcpServers: [[alpha, beta]]",
      "mcpServers:",
    ];

    for (const mcpServers of invalidFrontmatterValues) {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review code
${mcpServers}
---
Review carefully.`,
      });

      expect(result.profile).toBeUndefined();
      expect(result.diagnostic?.code).toBe("agent_invalid_mcp_servers");
    }
  });

  it("accepts an explicit empty mcpServers list and trims server names", () => {
    const empty = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: empty-scope
description: Use the parent MCP snapshot
mcpServers: []
---`,
    });
    const scoped = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: scoped
description: Use selected parent MCP servers
mcpServers: [" local-tools ", analytics, "plugin:tools:", "[alpha]"]
---`,
    });

    expect(empty.diagnostic).toBeUndefined();
    expect(empty.profile?.mcpServers).toEqual([]);
    expect(scoped.diagnostic).toBeUndefined();
    expect(scoped.profile?.mcpServers).toEqual([
      "local-tools",
      "analytics",
      "plugin:tools:",
      "[alpha]",
    ]);
  });

  it("keeps invalid nested syntax from reviving a non-MCP list", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: reviewer
description: Review code
tools:
  invalid: nested
  - Read
---`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile?.tools).toBeUndefined();
  });

  it("formats available profiles for Agent tool descriptions with built-in default agents", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "zcode-reviewer",
        description: "检查实现边界。",
        source: "project",
        systemPrompt: "只输出中文。",
        tools: ["Read"],
        background: true,
      },
    ]);

    expect(prompt).toContain("Available agent types and the tools they have access to:");
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("Explore");
    expect(prompt).toContain("- zcode-reviewer: 检查实现边界。 (Tools: Read)");
    expect(prompt).not.toContain("tools: Read");
    expect(prompt).not.toContain("background: true");
    expect(prompt).not.toContain("model:");
  });

  it("assigns explicit identity colors to built-in agents", () => {
    expect(createBuiltInGeneralPurposeAgentProfile().color).toBe("blue");
    expect(createBuiltInExploreAgentProfile().color).toBe("cyan");
  });

  it("uses explicit AGENTS.md injection defaults for built-in agents", () => {
    expect(createBuiltInGeneralPurposeAgentProfile().injectAgentsMd).toBe(true);
    expect(createBuiltInExploreAgentProfile().injectAgentsMd).toBe(false);
  });

  it("parses explicit AGENTS.md injection while leaving missing custom values unset", () => {
    const explicit = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: inheriting-reviewer
description: Review with workspace instructions
injectAgentsMd: true
---
Review carefully.`,
    });
    const missing = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: legacy-reviewer
description: Legacy profile without the new field
---
Review carefully.`,
    });

    expect(explicit.profile?.injectAgentsMd).toBe(true);
    expect(missing.profile?.injectAgentsMd).toBeUndefined();
  });

  it("identifies Explore by both name and loader-owned source", () => {
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "built-in" })).toBe(true);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "user" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "project" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "general-purpose", source: "built-in" })).toBe(
      false,
    );
  });

  it("keeps a custom Explore profile intact when it overrides the built-in profile", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "Explore",
          description: "Custom mutable explorer",
          source: "project",
          systemPrompt: "Use the project workflow.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
          tools: ["Write", "mcp__local-tools__query"],
        },
      ],
      {
        builtInModelSelectionOverrides: {
          Explore: {
            providerId: "custom-openai",
            modelId: "glm-5.2",
            options: { reasoningLevel: "max" },
          },
        },
      },
    );

    expect(profiles.find((profile) => profile.name === "Explore")).toMatchObject({
      source: "project",
      modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      tools: ["Write", "mcp__local-tools__query"],
    });
  });

  it("formats a custom Explore with its declared tools", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "Explore",
        description: "Custom mutable explorer",
        source: "user",
        systemPrompt: "Use the user workflow.",
        tools: ["Write", "mcp__local-tools__query"],
      },
    ]);

    expect(prompt).toContain(
      "- Explore: Custom mutable explorer (Tools: Write, mcp__local-tools__query)",
    );
    expect(prompt).not.toContain("Tools: Read, Bash, WebFetch, WebSearch, TodoWrite");
  });

  it("leaves built-in Explore on inherited model by default", () => {
    expect(createBuiltInExploreAgentProfile().modelSelection).toBeUndefined();
    expect(
      normalizeAgentProfiles([]).find((profile) => profile.name === "Explore")?.modelSelection,
    ).toBeUndefined();
  });

  it("applies built-in model overrides without changing custom profile precedence", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "code-reviewer",
          description: "Review code",
          source: "user",
          systemPrompt: "Review carefully.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
        },
      ],
      {
        builtInModelSelectionOverrides: {
          Explore: {
            providerId: "custom-openai",
            modelId: "glm-5.2",
            options: { reasoningLevel: "max" },
          },
          "general-purpose": {
            providerId: "custom-openai",
            modelId: "gpt-5.4",
            options: { reasoningLevel: "high" },
          },
        },
      },
    );

    expect(profiles.find((profile) => profile.name === "general-purpose")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
    expect(profiles.find((profile) => profile.name === "Explore")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "glm-5.2",
      options: { reasoningLevel: "max" },
    });
    expect(profiles.find((profile) => profile.name === "code-reviewer")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("formats built-in Explore tools for the embedded search branch", () => {
    const prompt = formatAgentProfilesForPrompt([], {
      embeddedSearchEnabled: true,
    });

    expect(prompt).toContain("Explore");
    expect(prompt).toContain("Tools: Read, Bash, WebFetch, WebSearch, TodoWrite");
    expect(prompt).not.toContain("Glob");
    expect(prompt).not.toContain("Grep");
  });
});

describe("外部后端 profile（backend/preset）", () => {
  const externalMarkdown = (frontmatter: string) =>
    `---
name: cb-runner
description: 把实现任务交给 CodeBuddy
${frontmatter}
---
执行实现任务。`;

  it("backend: external + full 预设 → 解析出外部后端与执行覆盖项", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: codebuddy
model: glm-4.6
effort: high
contextWindow: 200000`),
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile).toMatchObject({
      name: "cb-runner",
      backend: "external",
      preset: "codebuddy",
      model: "glm-4.6",
      effort: "high",
      contextWindow: 200000,
    });
    // 外部 profile 的 model 是 CLI 参数，不是原生 provider/model 选择。
    expect(result.profile?.modelSelection).toBeUndefined();
  });

  it("存量 native profile 不写 backend 时行为逐字不变", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: reviewer
description: Review changes
model: custom-openai/gpt-5.4
tools: Read, Grep
---
Review.`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile?.backend).toBeUndefined();
    expect(result.profile?.preset).toBeUndefined();
    // native 的 model 仍然走 provider/model 选择解析。
    expect(result.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
    expect(result.profile?.tools).toEqual(["Read", "Grep"]);
  });

  it("backend 值非法时报 agent_invalid_backend", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown("backend: wasm"),
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_invalid_backend");
  });

  it("backend: external 缺 preset 时报缺必填字段", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown("backend: external"),
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_missing_required_frontmatter");
    expect(result.diagnostic?.message).toContain("preset");
  });

  it("未知预设报 agent_unknown_external_preset", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: no-such-cli`),
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_unknown_external_preset");
  });

  it("半适配预设（claude-code）被拒：agent_external_preset_not_bindable", () => {
    // 与绑定弹窗同口径：半适配预设自身都跑不通，让模型通过 profile 调用它
    // 只会得到含糊的失败，不如在解析期就说清楚。
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: claude-code`),
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_external_preset_not_bindable");
  });

  it("native profile 上写 preset 是矛盾配置，直接报错而非静默忽略", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: reviewer
description: Review
preset: codebuddy
---
Review.`,
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_preset_requires_external_backend");
  });

  it("contextWindow 必须是正整数 tokens", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: codebuddy
contextWindow: 1.5`),
    });

    expect(result.profile).toBeUndefined();
    expect(result.diagnostic?.code).toBe("agent_invalid_context_window");
  });

  it("外部 profile 在提示词里不能谎报工具集，并标出 CLI 与权限边界", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: codebuddy
model: glm-4.6
tools: Read, Grep`),
    });
    const profile = result.profile!;

    const line = formatAgentProfilesForPrompt([profile]);
    expect(line).toContain("cb-runner");
    expect(line).toContain("External CLI codebuddy");
    expect(line).toContain("model: glm-4.6");
    // ZCode 的 tools 限制对另一个进程里的 CLI 不成立，不能照抄成 Tools: 列表。
    expect(line).not.toContain("Tools: Read, Grep");
    expect(line).toContain("ZCode tool permissions do not apply");
  });

  it("外部 profile 写了原生专属字段时给出软诊断（profile 仍可用）", () => {
    // 方案 §5.3 要求：这些字段对 external profile 不生效，但要提示，否则用户
    // 会以为 tools: Read 真的限制了外部 agent 的能力。
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: codebuddy
tools: Read, Grep
maxTurns: 5`),
    });

    expect(result.diagnostic?.code).toBe("agent_external_ignores_native_fields");
    expect(result.diagnostic?.message).toContain("tools");
    expect(result.diagnostic?.message).toContain("maxTurns");
    // 软诊断不阻断加载：profile 必须在场，否则用户改一个字就整条失效。
    expect(result.profile?.backend).toBe("external");
    expect(result.profile?.preset).toBe("codebuddy");
  });

  it("没有原生专属字段时不产生该诊断", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: externalMarkdown(`backend: external
preset: codebuddy`),
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile?.backend).toBe("external");
  });
});
