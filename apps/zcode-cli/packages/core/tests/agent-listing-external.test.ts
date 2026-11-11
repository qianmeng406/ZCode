// S7 Part B+A：Agent 工具类型列表的外部渠道路由引导。
//
// 钉住三件事：
// 1. 外部 CLI profile 在列表行里排前（组内字母序不变）；
// 2. addedLines 含外部 profile 时注入引导行（按任务形状引导，非一刀切）；
// 3. 纯 native 列表不注入引导行（不浪费 token，既有行为逐字不变）。
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/subagent/profile.js";
import { collectAgentListingAttachment } from "../src/subagent/listing.js";
import type { AgentDefinitionsSnapshot } from "../src/subagent/definitions.js";

function profile(name: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name,
    description: `Description ${name}`,
    source: "user",
    systemPrompt: "private",
    ...overrides,
  };
}

function snapshot(...profiles: AgentProfile[]): AgentDefinitionsSnapshot {
  return { activeAgents: profiles };
}

const TOOLS = [{ name: "Agent" }];

function collect(...profiles: AgentProfile[]) {
  const attachment = collectAgentListingAttachment({
    definitions: snapshot(...profiles),
    entries: [],
    tools: TOOLS,
  });
  expect(attachment).toBeDefined();
  return attachment!.content;
}

describe("agent listing 外部渠道路由引导", () => {
  it("外部 profile 排在 native 之前，同组内保持字母序", () => {
    const content = collect(
      profile("zeta"),
      profile("mid", { backend: "external", preset: "codebuddy" }),
      profile("alpha"),
      profile("aaa", { backend: "external", preset: "codebuddy" }),
    );
    const lines = content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split(":")[0]);
    expect(lines).toEqual(["aaa", "mid", "alpha", "zeta"]);
  });

  it("addedLines 含外部 profile 时注入引导行", () => {
    const content = collect(profile("cb-runner", { backend: "external", preset: "codebuddy" }));
    expect(content).toContain("External CLI agents run in their own process");
    expect(content).toContain("prefer naming an external CLI agent explicitly");
  });

  it("纯 native 列表不注入引导行（既有行为不变）", () => {
    const content = collect(profile("alpha"), profile("zeta"));
    expect(content).not.toContain("External CLI agents");
  });

  it("后续 delta 新增外部 profile 时也注入引导行（非 initial）", () => {
    const first = collectAgentListingAttachment({
      definitions: snapshot(profile("alpha")),
      entries: [],
      tools: TOOLS,
    });
    expect(first).toBeDefined();
    // 模拟 alpha 已宣布过：entries 里带上它的 delta。
    const second = collectAgentListingAttachment({
      definitions: snapshot(profile("alpha"), profile("cb", { backend: "external", preset: "codebuddy" })),
      entries: [
        {
          kind: "attachment",
          content: first!.content,
          metadata: { source: "agent_listing_delta", agentListingDelta: first!.metadata.agentListingDelta },
        },
      ],
      tools: TOOLS,
    });
    expect(second).toBeDefined();
    expect(second!.content).toContain("New agent types are now available");
    expect(second!.content).toContain("External CLI agents run in their own process");
  });
});
