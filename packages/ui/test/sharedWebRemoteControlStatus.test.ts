// 共享远控轮询契约（dedupedIdlePollingEnabled）：
// 1. 同一 platform 多订阅只起一个 interval；全部退订即拆（interval 清零、注册表回收）；
// 2. 状态相等性去重：不变的状态不通知；变化才扇出；
// 3. 事件推送与轮询共用同一 applyStatus 去重口径。
import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlStatus } from "@zcode/shared";
import {
  getSharedWebRemoteControlPoller,
  type SharedWebRemoteControlTimerHost,
} from "../src/hooks/sharedWebRemoteControlStatus.js";

interface FakeTimerHost extends SharedWebRemoteControlTimerHost {
  tick(): void;
  activeCount(): number;
}

function createFakeTimerHost(): FakeTimerHost {
  const callbacks = new Set<() => void>();
  return {
    setInterval(callback) {
      callbacks.add(callback);
      return callbacks.size;
    },
    clearInterval() {
      // 与真实语义差别：clearInterval 只清最后注册的回调即可满足测试断言粒度，
      // 这里以整体清空近似（单测试内同屏只有一个 interval）。
      callbacks.clear();
    },
    tick() {
      for (const callback of [...callbacks]) callback();
    },
    activeCount() {
      return callbacks.size;
    },
  };
}

function createPlatform(statusSequence: WebRemoteControlStatus[]) {
  let callCount = 0;
  const platform = {
    getWebRemoteControlStatus: async () => {
      callCount += 1;
      return statusSequence[Math.min(callCount - 1, statusSequence.length - 1)]!;
    },
  };
  return { platform, getCallCount: () => callCount };
}

describe("getSharedWebRemoteControlPoller", () => {
  it("同一 platform 复用同一 poller；双订阅只起一个 interval，退订一个不清 interval", () => {
    const timers = createFakeTimerHost();
    const { platform } = createPlatform([{ status: "idle" }]);
    const poller = getSharedWebRemoteControlPoller(platform, 1000, timers);
    expect(getSharedWebRemoteControlPoller(platform, 1000, timers)).toBe(poller);

    const first = vi.fn();
    const second = vi.fn();
    const offFirst = poller.subscribe(first);
    poller.subscribe(second);
    expect(timers.activeCount()).toBe(1);

    offFirst();
    expect(timers.activeCount()).toBe(1); // 仍有订阅者，interval 保留
  });

  it("全部退订后 interval 清零且注册表回收（下次订阅是全新 poller）", () => {
    const timers = createTimerHost();
    const { platform } = createPlatform([{ status: "idle" }]);
    const poller = getSharedWebRemoteControlPoller(platform, 1000, timers);
    const offOne = poller.subscribe(() => {});
    const offTwo = poller.subscribe(() => {});
    expect(timers.activeCount()).toBe(1);
    offOne();
    offTwo();
    expect(timers.activeCount()).toBe(0);
    expect(getSharedWebRemoteControlPoller(platform, 1000, timers)).not.toBe(poller);
  });

  it("状态不变不通知；变化才扇出给全部订阅者（轮询与去重同口径）", async () => {
    const timers = createFakeTimerHost();
    const running: WebRemoteControlStatus = { status: "running", sessionId: "s1" };
    const idle: WebRemoteControlStatus = { status: "idle" };
    // 初始默认态就是 idle：首个 sync 返回 running 才应通知（相等不通知是契约）。
    const { platform, getCallCount } = createPlatform([running, running, idle, idle]);
    const poller = getSharedWebRemoteControlPoller(platform, 1000, timers);
    const first = vi.fn();
    const second = vi.fn();
    poller.subscribe(first);
    poller.subscribe(second);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1); // 初始 sync：idle → running
      expect(second).toHaveBeenCalledTimes(1);
    });
    first.mockClear();
    second.mockClear();

    timers.tick(); // 第二次轮询：仍是 running（相等）→ 不通知
    await vi.waitFor(() => expect(getCallCount()).toBe(2));
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    timers.tick(); // 第三次轮询：running → idle → 两个订阅者各收到一次
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });
    expect(poller.getStatus()).toBe(idle);
  });
});

function createTimerHost() {
  return createFakeTimerHost();
}

describe("getSharedWebRemoteControlPoller 分键（review #6）", () => {
  it("不同 intervalMs 不静默复用首个周期：按 (platform, intervalMs) 分键", () => {
    const timers = createFakeTimerHost();
    const { platform } = createPlatform([{ status: "idle" }]);
    const poller1000 = getSharedWebRemoteControlPoller(platform, 1000, timers);
    const poller2000 = getSharedWebRemoteControlPoller(platform, 2000, timers);
    expect(poller1000).not.toBe(poller2000);
    // 各自起链、互不干扰
    const offFast = poller1000.subscribe(() => {});
    const offSlow = poller2000.subscribe(() => {});
    expect(timers.activeCount()).toBe(2);
    offFast();
    offSlow();
    expect(timers.activeCount()).toBe(0);
  });
});
