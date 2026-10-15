import { describe, expect, it } from "vitest";
import type { EnvInfo } from "@zcode/contracts";
import { resolveContextProfile } from "@zcode/shared";
import { createContextBuilderFromSnapshot } from "../src/runtime/methods/context.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * promptProfile 映射契约：runtime config 的 contextProfile 必须逐档映射到
 * ContextBuilder 的 promptProfile（standard→缺省、minimal→minimal、fusion→fusion）。
 * 回归目标：新增档位时若只改 schema 不改映射，context 会静默回落 standard。
 */

const ENV_INFO: EnvInfo = {
  cwd: "C:/tmp/ws",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26100",
  nodeVersion: "24.11.0",
};

function makeRuntime(contextProfile?: string): AgentRuntimeInternal {
  return {
    config: {
      mode: "build",
      planEnabled: false,
      ...(contextProfile === undefined ? {} : { contextProfile }),
    },
    presentationSurface: "terminal",
    getTools: () => [],
    registry: { toContracts: () => [] },
    skillLoadOutcome: undefined,
    resolveRuntimeEmbeddedSearchEnabled: undefined,
  } as unknown as AgentRuntimeInternal;
}

function snapshot() {
  return {
    workingDirectory: "C:/tmp/ws",
    envInfo: ENV_INFO,
    currentDate: "2026-09-29",
    diagnostics: [],
  };
}

describe("context profile mapping", () => {
  it("maps standard config to the default promptProfile", () => {
    expect(resolveContextProfile({ contextProfile: "standard" })).toBe("standard");
    const builder = createContextBuilderFromSnapshot.call(makeRuntime("standard"), snapshot());
    // standard 走默认段（Dynamic Behavior），不发极简/融合专属段。
    const sources = builder.build().sections.map((s) => s.source);
    expect(sources).toContain("dynamic_behavior");
    expect(sources).not.toContain("fusion_behavior");
  });

  it("maps minimal config to the minimal promptProfile branch", () => {
    const builder = createContextBuilderFromSnapshot.call(makeRuntime("minimal"), snapshot());
    const sources = builder.build().sections.map((s) => s.source);
    expect(sources).toContain("minimal_guardrails");
  });

  it("maps fusion config to the fusion promptProfile branch", () => {
    const builder = createContextBuilderFromSnapshot.call(makeRuntime("fusion"), snapshot());
    const sources = builder.build().sections.map((s) => s.source);
    expect(sources).toContain("fusion_behavior");
    expect(sources).toContain("fusion_context_management");
    expect(sources).not.toContain("dynamic_behavior");
    expect(sources).not.toContain("context_management");
  });
});
