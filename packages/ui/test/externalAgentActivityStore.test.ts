import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import {
  clearExternalAgentActivity,
  getExternalAgentActivity,
  getExternalAgentActivityState,
  isExternalAgentActivityUnread,
  markExternalAgentActivitySeen,
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

  it("显式清空（cleared）只清掉卡住的 running，完成态记录保留", () => {
    // 冷恢复会补发一条 activity: null：进程没了，卡片不能永远显示"运行中"。
    publishExternalAgentActivity("s-stale", activity({ taskId: "stale" }));
    publishExternalAgentActivity("s-stale", null, { cleared: true });
    expect(getExternalAgentActivity("s-stale")).toBeNull();
    expect(getExternalAgentActivityState("s-stale").lastChangedAt).toBeNull();

    // 完成态是「上次执行结果」，清运行期事实不该把它一起抹掉。
    const done = activity({ taskId: "done", status: "completed" });
    publishExternalAgentActivity("s-stale-done", done);
    publishExternalAgentActivity("s-stale-done", null, { cleared: true });
    expect(getExternalAgentActivity("s-stale-done")).toBe(done);
  });

  it("没有 cleared 标记的 null 一律不动记录（过渡帧/旧服务端）", () => {
    const running = activity({ taskId: "live" });
    publishExternalAgentActivity("s-absent", running);
    publishExternalAgentActivity("s-absent", null);
    expect(getExternalAgentActivity("s-absent")).toBe(running);
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

describe("externalAgentActivityStore 注意力（seen / 无输出）", () => {
  it("running → 终态记一条未读；看到后才清掉", () => {
    publishExternalAgentActivity("s-unread", activity({ taskId: "job" }));
    publishExternalAgentActivity("s-unread", activity({ taskId: "job", status: "completed" }));
    expect(isExternalAgentActivityUnread("s-unread")).toBe(true);

    // taskId 对不上不清：完成的是别的任务。
    markExternalAgentActivitySeen("s-unread", "other-job");
    expect(isExternalAgentActivityUnread("s-unread")).toBe(true);

    markExternalAgentActivitySeen("s-unread", "job");
    expect(isExternalAgentActivityUnread("s-unread")).toBe(false);
  });

  it("冷恢复直接拿到终态帧不产生未读（历史任务不该刷未读点）", () => {
    publishExternalAgentActivity(
      "s-cold",
      activity({ taskId: "old", status: "completed", elapsedMs: 60_000 }),
    );
    expect(isExternalAgentActivityUnread("s-cold")).toBe(false);
  });

  it("新任务开始清掉上一条的未读", () => {
    publishExternalAgentActivity("s-next-unread", activity({ taskId: "first" }));
    publishExternalAgentActivity(
      "s-next-unread",
      activity({ taskId: "first", status: "completed" }),
    );
    expect(isExternalAgentActivityUnread("s-next-unread")).toBe(true);
    publishExternalAgentActivity("s-next-unread", activity({ taskId: "second" }));
    expect(isExternalAgentActivityUnread("s-next-unread")).toBe(false);
  });

  it("同一任务的迟到 running 帧不清未读（异步投递可能乱序）", () => {
    publishExternalAgentActivity("s-late", activity({ taskId: "job" }));
    publishExternalAgentActivity("s-late", activity({ taskId: "job", status: "completed" }));
    expect(isExternalAgentActivityUnread("s-late")).toBe(true);
    // 一个早于收口、但晚到的进度帧：任务已经结束，不能再把它当成"又开始跑了"。
    publishExternalAgentActivity("s-late", activity({ taskId: "job" }));
    expect(isExternalAgentActivityUnread("s-late")).toBe(true);
  });

  it("lastChangedAt 随新帧刷新，显式清除归零", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      publishExternalAgentActivity("s-idle", activity({ taskId: "run" }));
      expect(getExternalAgentActivityState("s-idle").lastChangedAt).toBe(10_000);

      // 引用不变 = 没有新输出：时间不刷新（面板据此显示「已 N 分钟无新输出」）。
      publishExternalAgentActivity("s-idle", getExternalAgentActivity("s-idle")!);
      vi.setSystemTime(70_000);
      expect(getExternalAgentActivityState("s-idle").lastChangedAt).toBe(10_000);

      publishExternalAgentActivity("s-idle", activity({ taskId: "run", elapsedMs: 61_000 }));
      expect(getExternalAgentActivityState("s-idle").lastChangedAt).toBe(70_000);

      clearExternalAgentActivity("s-idle");
      expect(getExternalAgentActivityState("s-idle").lastChangedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replayed 终态帧（切走期间完成）的未读不标记为实时，等用户显式查看", () => {
    publishExternalAgentActivity("s-replay", activity({ taskId: "job" }));
    // 切回会话后补发的第一帧：任务其实早就结束了。
    publishExternalAgentActivity("s-replay", activity({ taskId: "job", status: "completed" }), {
      replayed: true,
    });
    expect(isExternalAgentActivityUnread("s-replay")).toBe(true);
    expect(getExternalAgentActivityState("s-replay").unreadLive).toBe(false);

    // 实时帧记的未读才允许卡片自动销。
    publishExternalAgentActivity("s-live", activity({ taskId: "job" }));
    publishExternalAgentActivity("s-live", activity({ taskId: "job", status: "completed" }));
    expect(getExternalAgentActivityState("s-live").unreadLive).toBe(true);
  });

  it("历史摘要（冷恢复补发的上次执行）不产生未读，也不清掉已有未读", () => {
    publishExternalAgentActivity("s-hist", activity({ taskId: "real" }));
    publishExternalAgentActivity(
      "s-hist",
      activity({ taskId: "history_1", status: "completed", historical: true }),
    );
    expect(isExternalAgentActivityUnread("s-hist")).toBe(false);
    expect(getExternalAgentActivity("s-hist")?.historical).toBe(true);
  });

  it("空 sessionId 直接返回同一份空状态（useSyncExternalStore 不会死循环）", () => {
    expect(getExternalAgentActivityState(null)).toBe(getExternalAgentActivityState(undefined));
    expect(getExternalAgentActivityState("")).toEqual({
      activity: null,
      lastChangedAt: null,
      unreadTaskId: null,
      unreadLive: false,
    });
  });
});
