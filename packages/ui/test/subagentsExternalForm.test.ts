// 设置页外部 agent 表单的纯函数行为（S6 创建体验）。
//
// 覆盖三件事：
// 1. 从 AgentSummary 回读的初始状态带出外部字段（S6 前读了就丢，编辑表单全瞎）；
// 2. 提交字段组装：空串 = 继承（省略字段），窗口字符串转正整数，非法值静默省略；
// 3. 档位候选解析：探测目录优先且"模型对不上不给候选"，目录为空退静态表。
import { describe, expect, it } from "vitest";
import type { ExternalAgentPresetStatus } from "@zcode/shared";
import { EXTERNAL_AGENT_BINDABLE_PRESETS } from "@zcode/shared";
import {
  composeExternalSubAgentConfigFields,
  createSubagentFormInitialState,
  resolveExternalEffortCandidates,
} from "../src/settings/SubagentsSection.js";
import { resetSubagentsExternalProbeCache } from "../src/settings/subagentsExternalProbe.js";

const codebuddyPreset = EXTERNAL_AGENT_BINDABLE_PRESETS.find((preset) => preset.id === "codebuddy");
expect(codebuddyPreset).toBeDefined();

describe("createSubagentFormInitialState 外部字段回读", () => {
  it("外部 profile 的 backend/presetId/model/effort/contextWindow 进入表单状态", () => {
    const state = createSubagentFormInitialState({
      name: "cb-runner",
      description: "d",
      systemPrompt: "p",
      backend: "external",
      presetId: "codebuddy",
      externalModel: "DeepSeek-V4-Pro",
      externalEffort: "high",
      externalContextWindow: 128000,
    });
    expect(state.backend).toBe("external");
    expect(state.presetId).toBe("codebuddy");
    expect(state.externalModel).toBe("DeepSeek-V4-Pro");
    expect(state.externalEffort).toBe("high");
    expect(state.externalContextWindow).toBe("128000");
  });

  it("native / 缺省输入回落到原生模式", () => {
    const empty = createSubagentFormInitialState();
    expect(empty.backend).toBe("native");
    expect(empty.presetId).toBe("");
    expect(empty.externalModel).toBe("");
    const native = createSubagentFormInitialState({ backend: "native" });
    expect(native.backend).toBe("native");
  });
});

describe("composeExternalSubAgentConfigFields", () => {
  it("空串字段全部省略（继承语义），presetId 必出", () => {
    const fields = composeExternalSubAgentConfigFields({
      presetId: " codebuddy ",
      externalModel: "",
      externalEffort: "",
      externalContextWindow: "",
    });
    expect(fields).toEqual({ backend: "external", presetId: "codebuddy" });
  });

  it("非空字段 trim 后进入 config，窗口字符串转正整数", () => {
    const fields = composeExternalSubAgentConfigFields({
      presetId: "codebuddy",
      externalModel: " DeepSeek-V4-Pro ",
      externalEffort: "high",
      externalContextWindow: " 128000 ",
    });
    expect(fields).toEqual({
      backend: "external",
      presetId: "codebuddy",
      externalModel: "DeepSeek-V4-Pro",
      externalEffort: "high",
      externalContextWindow: 128000,
    });
  });

  it("非法窗口值静默省略（继承），不抛错也不写坏值", () => {
    for (const bad of ["abc", "0", "-5", "12.5"]) {
      const fields = composeExternalSubAgentConfigFields({
        presetId: "codebuddy",
        externalModel: "",
        externalEffort: "",
        externalContextWindow: bad,
      });
      expect(fields.externalContextWindow).toBeUndefined();
    }
  });
});

describe("resolveExternalEffortCandidates", () => {
  it("探测目录有该模型条目时用目录值（唯一权威）", () => {
    const status = {
      preset: codebuddyPreset,
      installed: true,
      models: ["m1"],
      modelCatalog: [{ id: "m1", name: "m1", supportedEfforts: ["low", "high"] }],
    } as unknown as ExternalAgentPresetStatus;
    expect(resolveExternalEffortCandidates(status, codebuddyPreset!, "m1")).toEqual([
      "low",
      "high",
    ]);
  });

  it("目录非空但模型对不上时不给候选（不猜）", () => {
    const status = {
      preset: codebuddyPreset,
      installed: true,
      models: ["m1"],
      modelCatalog: [{ id: "m1", name: "m1", supportedEfforts: ["low"] }],
    } as unknown as ExternalAgentPresetStatus;
    expect(resolveExternalEffortCandidates(status, codebuddyPreset!, "free-typed")).toEqual([]);
  });

  it("目录为空（读不到）时退 preset 静态兜底表", () => {
    const status = {
      preset: codebuddyPreset,
      installed: true,
      models: [],
      modelCatalog: [],
    } as unknown as ExternalAgentPresetStatus;
    const fromStatic = resolveExternalEffortCandidates(status, codebuddyPreset!, undefined);
    const expected = codebuddyPreset!.effortLevelsByModel[""] ?? [];
    expect(fromStatic).toEqual(expected);
  });
});

describe("loadSubagentsExternalProbe 缓存", () => {
  it("命中缓存不再发送；null 不缓存；force 绕过缓存", async () => {
    resetSubagentsExternalProbeCache();
    const { loadSubagentsExternalProbe } =
      await import("../src/settings/subagentsExternalProbe.js");
    let calls = 0;
    const send = async () => {
      calls += 1;
      return [{ preset: codebuddyPreset, installed: true, models: [], modelCatalog: [] }];
    };
    const first = await loadSubagentsExternalProbe("k1", send);
    const second = await loadSubagentsExternalProbe("k1", send);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    await loadSubagentsExternalProbe("k1", send, { force: true });
    expect(calls).toBe(2);

    let nullCalls = 0;
    const sendNull = async () => {
      nullCalls += 1;
      return null;
    };
    await loadSubagentsExternalProbe("k2", sendNull);
    await loadSubagentsExternalProbe("k2", sendNull);
    expect(nullCalls).toBe(2);
    resetSubagentsExternalProbeCache();
  });
});
