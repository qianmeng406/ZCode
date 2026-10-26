import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORK_FEATURES,
  forkFeaturesPatchSchema,
  forkFeaturesSchema,
  pickForkToolPreferences,
  resolveForkFeatures,
} from "../src/fork-features.js";

describe("fork feature preferences", () => {
  it("defaults every new capability off and keeps the prompt optimizer on", () => {
    // promptOptimizer 是唯一默认开启的项：该功能在本 fork 已存在，默认关闭等于删功能。
    expect(DEFAULT_FORK_FEATURES).toEqual({
      monitorTool: false,
      notebookEdit: false,
      applyPatch: false,
      promptOptimizer: true,
      memoryFileEditing: false,
      memoryCapture: false,
      memoryDreamManual: false,
    });
  });

  it("fills the whole object when settings.json has no forkFeatures yet", () => {
    expect(forkFeaturesSchema.parse(undefined)).toEqual(DEFAULT_FORK_FEATURES);
  });

  it("accepts partial persisted values by filling defaults (读取路径)", () => {
    expect(forkFeaturesSchema.parse({ monitorTool: true })).toEqual({
      ...DEFAULT_FORK_FEATURES,
      monitorTool: true,
    });
  });

  it("rejects partial or unknown keys on the write path (patch 必须是完整对象)", () => {
    expect(forkFeaturesPatchSchema.safeParse({ monitorTool: true }).success).toBe(false);
    expect(
      forkFeaturesPatchSchema.safeParse({ ...DEFAULT_FORK_FEATURES, unknownKey: true }).success,
    ).toBe(false);
    expect(forkFeaturesPatchSchema.safeParse(DEFAULT_FORK_FEATURES).success).toBe(true);
  });

  it("resolves partial persisted values without leaking defaults onto other switches", () => {
    expect(resolveForkFeatures({ monitorTool: true, memoryCapture: true })).toEqual({
      ...DEFAULT_FORK_FEATURES,
      monitorTool: true,
      memoryCapture: true,
    });
  });

  it("projects only the three runtime tool switches", () => {
    expect(
      pickForkToolPreferences({
        ...DEFAULT_FORK_FEATURES,
        monitorTool: true,
        applyPatch: true,
      }),
    ).toEqual({ monitorTool: true, notebookEdit: false, applyPatch: true });
  });
});
