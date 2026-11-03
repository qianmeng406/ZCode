import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import {
  clearExternalAgentActivity,
  getExternalAgentActivity,
  publishExternalAgentActivity,
  subscribeExternalAgentActivity,
} from "@/v4/externalAgent/externalAgentActivityStore.js";

function activity(overrides: Partial<ExternalAgentActivity> = {}): ExternalAgentActivity {
  return {
    taskId: "task-1",
    agentLabel: "CodeBuddy",
    status: "running",
    startedAt: 1_000,
    elapsedMs: 2_000,
    ...overrides,
  };
}

describe("externalAgentActivityStore", () => {
  it("按 sessionId 隔离记录", () => {
    const first = activity({ taskId: "a" });
    const second = activity({ taskId: "b" });
    publishExternalAgentActivity("s1", first);
    publishExternalAgentActivity("s2", second);
    expect(getExternalAgentActivity("s1")).toBe(first);
    expect(getExternalAgentActivity("s2")).toBe(second);
    expect(getExternalAgentActivity("s3")).toBeNull();
  });

  it("引用未变化时不通知订阅者", () => {
    const value = activity({ taskId: "same" });
    publishExternalAgentActivity("s-ref", value);
    const listener = vi.fn();
    const unsubscribe = subscribeExternalAgentActivity("s-ref", listener);
    publishExternalAgentActivity("s-ref", value);
    expect(listener).not.toHaveBeenCalled();
    publishExternalAgentActivity("s-ref", activity({ taskId: "same", elapsedMs: 3_000 }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("退订后不再收到通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeExternalAgentActivity("s-unsub", listener);
    unsubscribe();
    publishExternalAgentActivity("s-unsub", activity({ taskId: "x" }));
    expect(listener).not.toHaveBeenCalled();
  });

  it("从未有过活动的会话写 null 不落记录", () => {
    publishExternalAgentActivity("s-empty", null);
    expect(getExternalAgentActivity("s-empty")).toBeNull();
  });

  it("完成后快照给 null 不清掉已完成记录（冷恢复/重订阅的过渡帧）", () => {
    const settled = activity({ taskId: "done", status: "completed" });
    publishExternalAgentActivity("s-keep", activity({ taskId: "done" }));
    publishExternalAgentActivity("s-keep", settled);
    const listener = vi.fn();
    const unsubscribe = subscribeExternalAgentActivity("s-keep", listener);
    publishExternalAgentActivity("s-keep", null);
    expect(getExternalAgentActivity("s-keep")).toBe(settled);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("新任务开始时替换上一条完成记录", () => {
    publishExternalAgentActivity("s-next", activity({ taskId: "old", status: "completed" }));
    const next = activity({ taskId: "new" });
    publishExternalAgentActivity("s-next", next);
    expect(getExternalAgentActivity("s-next")).toBe(next);
  });

  it("显式清除（解绑）仍然生效", () => {
    publishExternalAgentActivity("s-clear", activity({ taskId: "run", status: "completed" }));
    const listener = vi.fn();
    const unsubscribe = subscribeExternalAgentActivity("s-clear", listener);
    clearExternalAgentActivity("s-clear");
    expect(getExternalAgentActivity("s-clear")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
