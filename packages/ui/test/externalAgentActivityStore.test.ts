import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import {
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

  it("清除已有活动（解绑/新会话）时通知并把快照置空", () => {
    publishExternalAgentActivity("s-clear", activity({ taskId: "run" }));
    const listener = vi.fn();
    const unsubscribe = subscribeExternalAgentActivity("s-clear", listener);
    publishExternalAgentActivity("s-clear", null);
    expect(getExternalAgentActivity("s-clear")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
