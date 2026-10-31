import { describe, expect, it } from "vitest";
import { canRequestInputPrediction } from "@/v4/composer/useInputPrediction.js";

describe("input prediction trigger", () => {
  it("requires the setting, a session and a non-rich draft", () => {
    expect(canRequestInputPrediction({ enabled: true, sessionId: "s1", blocked: false })).toBe(
      true,
    );
    expect(canRequestInputPrediction({ enabled: false, sessionId: "s1", blocked: false })).toBe(
      false,
    );
    expect(canRequestInputPrediction({ enabled: true, sessionId: null, blocked: false })).toBe(
      false,
    );
    expect(canRequestInputPrediction({ enabled: true, sessionId: "s1", blocked: true })).toBe(
      false,
    );
  });
});
