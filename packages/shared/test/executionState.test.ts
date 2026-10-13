import { describe, expect, it } from "vitest";
import { resolveExecutionState } from "../src/execution-state.js";

describe("独立 Plan 与旧提交兼容", () => {
  // fork 双轴：resolveExecutionState 的结果始终携带 contextProfile（缺省由兼容映射补齐 standard）；
  // 输入/持久化形态才允许缺省。
  const current = { mode: "yolo", planEnabled: true, contextProfile: "standard" } as const;
  it("显式 false 不等同缺失", () => {
    expect(resolveExecutionState({ planEnabled: false }, current)).toEqual({
      mode: "yolo",
      planEnabled: false,
      contextProfile: "standard",
    });
    expect(resolveExecutionState({}, current)).toEqual(current);
  });
  it("旧 plan 保留基础权限；旧非 Plan 选择退出规划", () => {
    expect(resolveExecutionState({ mode: "plan" }, current)).toEqual(current);
    expect(resolveExecutionState({ mode: "edit" }, current)).toEqual({
      mode: "edit",
      planEnabled: false,
      contextProfile: "standard",
    });
  });
  it("显式新字段独立于权限；旧 Plan 冷恢复不猜完全访问", () => {
    expect(resolveExecutionState({ mode: "edit", planEnabled: true }, current)).toEqual({
      mode: "edit",
      planEnabled: true,
      contextProfile: "standard",
    });
    expect(resolveExecutionState({ mode: "plan" })).toEqual({
      mode: "build",
      planEnabled: true,
      contextProfile: "standard",
    });
  });
});
