import { describe, expect, it } from "vitest";

import { buildAiFeatureSelection, formatAiFeatureModelValue } from "./aiFeatureModelOptions.js";
import { settingsAiFeaturesModule } from "./module.js";

describe("settings-ai-features contract", () => {
  it("declares its module manifest", () => {
    expect(settingsAiFeaturesModule.id).toBe("settings-ai-features");
  });

  it("round-trips model selections without inventing a reasoning level", () => {
    const selection = buildAiFeatureSelection("openai", "gpt-5", undefined);
    expect(selection).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect(formatAiFeatureModelValue(selection)).toBe("openai/gpt-5");
  });
});
