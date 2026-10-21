import { describe, expect, it } from "vitest";
import { computeAvailability } from "../src/zcode-protocol-v4/index.js";

const base = {
  phase: "completedSuccess" as const,
  goalStatus: "paused" as const,
  compacting: false,
  goalVerifying: false,
  queueLength: 0,
  autoDrain: true,
};

describe("clearGoal availability", () => {
  it("没有目标时拒绝（noGoalToClear）", () => {
    expect(computeAvailability({ ...base, goalStatus: null }).clearGoal).toEqual({
      allowed: false,
      reasonCode: "noGoalToClear",
    });
  });

  it("空闲且目标在场时允许删除", () => {
    expect(computeAvailability(base).clearGoal).toEqual({ allowed: true });
  });

  it.each(["running", "prewarming"] as const)("phase=%s 时拒绝（goalBusy）", (phase) => {
    expect(computeAvailability({ ...base, phase }).clearGoal).toEqual({
      allowed: false,
      reasonCode: "goalBusy",
    });
  });

  it("goalVerifying 时拒绝：verifier 不一定设置 activeAbortController", () => {
    expect(computeAvailability({ ...base, goalVerifying: true }).clearGoal).toEqual({
      allowed: false,
      reasonCode: "goalBusy",
    });
  });

  it("compacting 时拒绝", () => {
    expect(computeAvailability({ ...base, compacting: true }).clearGoal).toEqual({
      allowed: false,
      reasonCode: "goalBusy",
    });
  });
});
