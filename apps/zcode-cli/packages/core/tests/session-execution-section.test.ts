import { describe, expect, it } from "vitest";
import type { SessionExecutionEnvironment } from "@zcode/shared";
import { createContextBuilder } from "../src/context/index.js";
import { buildEnvInfoSection } from "../src/context/sections/env-info.js";
import { buildSessionExecutionSection } from "../src/context/sections/session-execution.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";

const WSL: SessionExecutionEnvironment = {
  kind: "wsl",
  distro: "Ubuntu-24.04",
  user: "zcodewslp2",
};

/** user 留空 = 发行版默认用户：提示词不得虚构用户名。 */
const WSL_DEFAULT_USER: SessionExecutionEnvironment = {
  kind: "wsl",
  distro: "Ubuntu-24.04",
};

const ENV_INFO = {
  cwd: "/workspace",
  platform: "win32",
  shell: "powershell",
  osVersion: "Windows 11",
  nodeVersion: "v24.14.0",
};

function sourceNames(sections: Array<{ source: string }>): string[] {
  return sections.map((section) => section.source);
}

describe("session execution environment section", () => {
  it("does not exist for local or unconfigured sessions", () => {
    expect(buildSessionExecutionSection(undefined)).toBeNull();
    expect(buildSessionExecutionSection({ kind: "local" })).toBeNull();
  });

  it("renders routing and measured guidance for WSL", () => {
    const section = buildSessionExecutionSection(WSL);
    expect(section).not.toBeNull();
    expect(section?.source).toBe("session_execution");
    expect(section?.injectionTarget).toBe("system");
    expect(section?.content).toContain("# Session Execution Environment");
    expect(section?.content).toContain("WSL Linux (Ubuntu-24.04, user zcodewslp2)");
    expect(section?.content).toContain("MCP servers, Browser Use and Computer Use");
    expect(section?.content).toContain("Windows-only commands");
    // 提示词只给建议，能否执行由绑定决定；WSL interop 可能允许 .exe，
    // 因此既不能用 "Never"/"Do not" 写成硬约束，也不能声称技术上不可能。
    expect(section?.content).toContain("guidance, not hard restrictions");
    expect(section?.content).toContain("execution binding is authoritative");
    expect(section?.content).not.toContain("cannot run here");
    expect(section?.content).not.toContain("Never");
    expect(section?.content).not.toContain("Do not");
    expect(section?.content).toContain("not part of this session's command routing");
    expect(section?.content).toContain("~10x SLOWER");
    expect(section?.content).toContain("~107-179 ms");
    expect(section?.content).toContain("~1.0x");
  });

  it("renders a compact variant for minimal and subagent prompts", () => {
    const section = buildSessionExecutionSection(WSL, { compact: true });
    expect(section?.content).toContain("WSL Linux (Ubuntu-24.04, user zcodewslp2)");
    expect(section?.content).toContain("Guidance only");
    expect(section?.content).not.toContain("Never");
    expect(section?.content).not.toContain("Do not");
    expect(section?.content).toContain("~10x slower");
    expect(section?.content).not.toContain("Measured performance guidance");
    expect(section?.chars).toBeLessThan(buildSessionExecutionSection(WSL)?.chars ?? 0);
  });

  it("writes default-user wording when the user is omitted", () => {
    expect(buildSessionExecutionSection(WSL_DEFAULT_USER)?.content).toContain(
      "WSL Linux (Ubuntu-24.04, the distribution's default user)",
    );
    expect(buildSessionExecutionSection(WSL_DEFAULT_USER, { compact: true })?.content).toContain(
      "the distribution's default user",
    );
    expect(buildEnvInfoSection(ENV_INFO, [], WSL_DEFAULT_USER).content).toContain(
      "- Command execution: WSL Ubuntu-24.04 (default user)",
    );
  });

  it("declares POSIX shell and WSL command execution in env info", () => {
    const content = buildEnvInfoSection(ENV_INFO, [], WSL).content;
    expect(content).toContain("- Platform: win32");
    expect(content).toContain("- Shell: bash (POSIX, WSL)");
    expect(content).toContain("- Command execution: WSL Ubuntu-24.04 (user zcodewslp2)");

    const local = buildEnvInfoSection(ENV_INFO).content;
    expect(local).toContain("- Shell: powershell");
    expect(local).not.toContain("Command execution");
  });
});

describe("ContextBuilder execution environment switching", () => {
  it("injects only while WSL is active, and removes it after switching back", () => {
    let current: SessionExecutionEnvironment | undefined = WSL;
    const builder = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV_INFO,
      getSessionExecutionEnvironment: () => current,
      guidanceToolNames: ["Read", "Edit", "Bash"],
    });

    const wsl = builder.build();
    expect(sourceNames(wsl.sections).filter((source) => source === "session_execution")).toEqual([
      "session_execution",
    ]);
    expect(wsl.sections.find((section) => section.source === "env_info")?.content).toContain(
      "- Command execution: WSL Ubuntu-24.04 (user zcodewslp2)",
    );

    current = undefined;
    const local = builder.build();
    expect(sourceNames(local.sections)).not.toContain("session_execution");
    expect(local.sections.find((section) => section.source === "env_info")?.content).not.toContain(
      "Command execution",
    );
    expect(local.sections.find((section) => section.source === "env_info")?.content).toContain(
      "- Shell: powershell",
    );
  });

  it("keeps the section for custom system prompts and compacts it for minimal/workflow", () => {
    const custom = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV_INFO,
      customSystemPrompt: "Custom identity.",
      getSessionExecutionEnvironment: () => WSL,
    }).build();
    expect(sourceNames(custom.sections)).toContain("session_execution");

    const minimal = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV_INFO,
      promptProfile: "minimal",
      getSessionExecutionEnvironment: () => WSL,
    }).build();
    const minimalSection = minimal.sections.find(
      (section) => section.source === "session_execution",
    );
    expect(minimalSection?.content).toContain("~10x slower");
    expect(minimalSection?.content).not.toContain("Measured performance guidance");

    const workflow = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: ENV_INFO,
      workflowActor: { name: "child" },
      getSessionExecutionEnvironment: () => WSL,
    }).build();
    const workflowSection = workflow.sections.find(
      (section) => section.source === "session_execution",
    );
    expect(workflowSection?.content).toContain("~10x slower");
    expect(workflowSection?.content).not.toContain("Measured performance guidance");
  });

  it("gives subagents the compact WSL routing section", () => {
    const result = createSubagentContextBuilder({
      agentPrompt: "Explore the repository.",
      envInfo: ENV_INFO,
      getSessionExecutionEnvironment: () => WSL,
    }).build();
    const section = result.sections.find((entry) => entry.source === "session_execution");
    expect(section?.content).toContain("WSL Linux (Ubuntu-24.04, user zcodewslp2)");
    expect(section?.content).toContain("~10x slower");
    // 环境段是 meta_user 公告（upstream 结构），由 runtime 单独宣告；builder 里读 section。
    expect(result.sections.find((entry) => entry.source === "env_info")?.content).toContain(
      "bash (POSIX, WSL)",
    );
  });
});
