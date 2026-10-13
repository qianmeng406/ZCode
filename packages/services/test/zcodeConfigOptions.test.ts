import { describe, expect, it } from "vitest";
import type { ZCodeSessionSettingsState } from "@zcode/shared";
import {
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  settingsToConfigOptions,
} from "../src/zcode-agent/zcodeConfigOptions.js";

function settingsWithMode(
  mode: ZCodeSessionSettingsState["mode"]["current"],
): ZCodeSessionSettingsState {
  return {
    model: {
      current: { providerId: "glm", modelId: "glm-5" },
      available: [],
    },
    thoughtLevel: {
      enabled: false,
      available: [],
    },
    mode: { current: mode },
  };
}

describe("zcodeConfigOptions", () => {
  it("keeps persisted edit while the shared menu replaces it with guarded", () => {
    const options = settingsToConfigOptions(settingsWithMode("edit"));
    const modeOption = options.find((option) => option.category === "mode");

    expect(modeOption?.currentValue).toBe("edit");
    // 本定制版在官方 build/guarded/plan/yolo 之外新增 research/minimal/zcodeUpdate 三个模式，
    // 这里按 fork 事实源（shared ZCODE_AGENT_MODE_OPTIONS）断言完整菜单，而非官方四项子集。
    expect(modeOption?.options?.map((option) => option.value)).toEqual([
      "build",
      "guarded",
      "plan",
      "research",
      "minimal",
      "zcodeUpdate",
      "yolo",
    ]);
    expect(getZCodeAgentAvailableModes().map((mode) => mode.id)).toEqual([
      "build",
      "guarded",
      "plan",
      "research",
      "minimal",
      "zcodeUpdate",
      "yolo",
    ]);
    expect(normalizeAvailableZCodeMode("edit")).toBe("edit");
  });
});
