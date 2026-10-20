import { describe, expect, it } from "vitest";

import { isPromptOptimizerContextRange, isPromptOptimizerMode } from "./contract.js";
import { sharedAiFeaturesModule } from "./module.js";

describe("shared-ai-features contract", () => {
  it("declares its module manifest", () => {
    expect(sharedAiFeaturesModule.id).toBe("shared-ai-features");
  });

  it("accepts only the persisted optimizer values", () => {
    expect(isPromptOptimizerMode("polish")).toBe(true);
    expect(isPromptOptimizerMode("structure")).toBe(true);
    expect(isPromptOptimizerMode("invalid")).toBe(false);
    expect(isPromptOptimizerContextRange("draft")).toBe(true);
    expect(isPromptOptimizerContextRange("conversation")).toBe(true);
    expect(isPromptOptimizerContextRange("window")).toBe(false);
  });
});
