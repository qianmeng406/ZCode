// 子智能体 profile 的跨进程契约兼容性。
//
// 存在理由：`agentProfileSchema` 与 `subagentRuntimeConfigSchema` 都是 `.strict()`。
// 给 AgentProfile 加字段时，最容易踩的坑不是"新字段没解析"，而是**新字段进了
// interface 却没进 schema**——Desktop 把带新字段的快照发给 CLI 时被 strict 直接
// 拒掉，表现为"子智能体列表整个消失"，而不是某个字段缺失。
//
// 这里钉住三个不变量：
// 1. 存量 profile（无 backend/preset）原样通过，不被迫补字段；
// 2. 外部 profile 的新字段能安全跨进程往返；
// 3. 未知字段仍然被拒（strict 没有被顺手放松）。
import { describe, expect, it } from "vitest";
import { agentProfileSchema, type AgentProfile } from "../src/subagent-profile.js";
import { subagentRuntimeConfigSchema } from "../src/subagent-runtime-config.js";

const nativeProfile: AgentProfile = {
  name: "reviewer",
  description: "Review changes",
  source: "user",
  systemPrompt: "Review carefully.",
  tools: ["Read", "Grep"],
};

const externalProfile: AgentProfile = {
  name: "cb-runner",
  description: "把实现任务交给 CodeBuddy",
  source: "user",
  systemPrompt: "执行实现任务。",
  backend: "external",
  preset: "codebuddy",
  model: "glm-4.6",
  effort: "high",
  contextWindow: 200000,
};

describe("agentProfileSchema 兼容性", () => {
  it("存量 native profile（无外部字段）原样通过", () => {
    const parsed = agentProfileSchema.parse(nativeProfile);
    expect(parsed).toEqual(nativeProfile);
    expect(parsed.backend).toBeUndefined();
    expect(parsed.preset).toBeUndefined();
  });

  it("外部 profile 的新字段能往返", () => {
    const parsed = agentProfileSchema.parse(externalProfile);
    expect(parsed).toEqual(externalProfile);
  });

  it("未知字段仍然被拒（strict 未被放松）", () => {
    expect(() =>
      agentProfileSchema.parse({ ...nativeProfile, somethingElse: true } as never),
    ).toThrow();
  });

  it("backend 只接受 native / external", () => {
    expect(() => agentProfileSchema.parse({ ...nativeProfile, backend: "wasm" })).toThrow();
  });

  it("contextWindow 必须是正整数", () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => agentProfileSchema.parse({ ...nativeProfile, contextWindow: value })).toThrow();
    }
  });
});

describe("subagentRuntimeConfigSchema 兼容性", () => {
  it("带外部 profile 的快照能跨进程解析", () => {
    const parsed = subagentRuntimeConfigSchema.parse({
      kind: "ready",
      profiles: [nativeProfile, externalProfile],
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
    });
    expect(parsed.kind).toBe("ready");
    if (parsed.kind !== "ready") throw new Error("unreachable");
    expect(parsed.profiles.map((profile) => profile.name)).toEqual(["reviewer", "cb-runner"]);
  });

  it("旧 Host 发来的快照（无新字段）仍然可用", () => {
    const parsed = subagentRuntimeConfigSchema.parse({
      kind: "ready",
      profiles: [nativeProfile],
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
    });
    expect(parsed.kind).toBe("ready");
  });

  it("built-in profile 不能被跨进程传递（既有约束保持不变）", () => {
    expect(() =>
      subagentRuntimeConfigSchema.parse({
        kind: "ready",
        profiles: [{ ...nativeProfile, source: "built-in" }],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      }),
    ).toThrow();
  });
});
