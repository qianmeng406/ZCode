import { describe, expect, it } from "vitest";
import { resolveGoalIterationAction } from "../src/v4/conversationGoalSummaryModel.js";

const base = {
  planEnabled: false,
  goalStatus: "active" as const,
  isCurrentOpenRow: false,
  hasTitle: true,
};

describe("resolveGoalIterationAction", () => {
  it("paused + 当前未完成行 → resume，即使该行是 goal.iteration + 1", () => {
    // 面板的“当前未完成条”由 requiredIterationCount 推导，paused+notSatisfied 时
    // row.iteration = goal.iteration + 1，不能用 iteration === goal.iteration 判定。
    expect(
      resolveGoalIterationAction({
        ...base,
        goalStatus: "paused",
        isCurrentOpenRow: true,
      }),
    ).toBe("resume");
  });

  it("notSatisfied + 当前未完成行 → continue（保留目标，不重置进度）", () => {
    expect(
      resolveGoalIterationAction({
        ...base,
        goalStatus: "notSatisfied",
        isCurrentOpenRow: true,
      }),
    ).toBe("continue");
  });

  it("active/verifying + 当前未完成行 → already-running", () => {
    expect(
      resolveGoalIterationAction({
        ...base,
        goalStatus: "active",
        isCurrentOpenRow: true,
      }),
    ).toBe("already-running");
    expect(
      resolveGoalIterationAction({
        ...base,
        goalStatus: "verifying",
        isCurrentOpenRow: true,
      }),
    ).toBe("already-running");
  });

  it("历史/已完成行 → restart（替换目标并重置进度）", () => {
    expect(
      resolveGoalIterationAction({
        ...base,
        goalStatus: "paused",
        isCurrentOpenRow: false,
      }),
    ).toBe("restart");
  });

  it("Plan 模式优先拦住所有分支", () => {
    for (const isCurrentOpenRow of [true, false]) {
      expect(
        resolveGoalIterationAction({
          ...base,
          planEnabled: true,
          goalStatus: "paused",
          isCurrentOpenRow,
        }),
      ).toBe("blocked-plan");
    }
  });

  it("没有标题的历史行 → noop，不发送空目标", () => {
    expect(
      resolveGoalIterationAction({
        ...base,
        hasTitle: false,
        isCurrentOpenRow: false,
      }),
    ).toBe("noop");
  });
});
