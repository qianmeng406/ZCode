// @vitest-environment jsdom
// localTtft flush 定时器的生命周期契约（review #3/#7）：
// 1. dedupedIdlePollingEnabled 开启时：定时器跟随 observer.enabled 启停；
// 2. 配置拉取 reject 时兜底启动定时器（缓冲记录不漏冲刷）；
// 3. 开关关闭时立即常驻（与原实现一致）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsState = vi.hoisted(() => ({ dedupedIdlePollingEnabled: true }));

vi.mock("@zcode/ui", () => ({
  PERFORMANCE_SETTINGS_STORAGE_KEY: "zcode-performance-settings",
  LocalTtftObserver: class {
    enabled = false;
    constructor(_onRecord: unknown, _a?: unknown, _b?: unknown, _visible?: unknown) {}
    sampleClock(): void {}
    expire(): void {}
    background(): void {}
    foreground(): void {}
    interrupt(): void {}
  },
  setLocalTtftObserver: vi.fn(),
  loadPerformanceSettings: () => ({
    dedupedIdlePollingEnabled: settingsState.dedupedIdlePollingEnabled,
  }),
}));

import type { IPlatformService } from "@zcode/shared";
import {
  initializeDesktopLocalTtft,
  type LocalTtftTimerHost,
} from "../src/renderer/src/local-ttft/initialize.js";

interface FakeTimerHost extends LocalTtftTimerHost {
  activeCount(): number;
  clearCount(): number;
}

function createFakeTimerHost(): FakeTimerHost {
  const handles = new Set<number>();
  let sequence = 0;
  let clearCount = 0;
  return {
    setInterval() {
      sequence += 1;
      handles.add(sequence);
      return sequence as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) {
      clearCount += 1;
      handles.delete(handle as unknown as number);
    },
    activeCount() {
      return handles.size;
    },
    clearCount() {
      return clearCount;
    },
  };
}

function createPlatform(options: { configResult: "enabled" | "disabled" | "reject" | "pending" }) {
  let resolveConfig: ((value: { localTtftEnabled?: boolean }) => void) | undefined;
  let rejectConfig: ((error: Error) => void) | undefined;
  let configListener: ((config: { localTtftEnabled?: boolean }) => void) | undefined;
  const platform = {
    reportLocalTtftBatch: vi.fn(),
    getRendererActionTraceConfig: vi.fn(
      () =>
        new Promise<{ localTtftEnabled?: boolean }>((resolve, reject) => {
          resolveConfig = resolve;
          rejectConfig = reject;
          if (options.configResult === "enabled") resolve({ localTtftEnabled: true });
          else if (options.configResult === "disabled") resolve({ localTtftEnabled: false });
          else if (options.configResult === "reject") reject(new Error("config unavailable"));
        }),
    ),
    onRendererActionTraceConfigChanged: (
      listener: (config: { localTtftEnabled?: boolean }) => void,
    ) => {
      configListener = listener;
      return () => {
        configListener = undefined;
      };
    },
  };
  return {
    platform: platform as unknown as IPlatformService,
    pushConfig: (config: { localTtftEnabled?: boolean }) => configListener?.(config),
    pushReject: () => rejectConfig?.(new Error("late failure")),
    resolve: (config: { localTtftEnabled?: boolean }) => resolveConfig?.(config),
  };
}

beforeEach(() => {
  settingsState.dedupedIdlePollingEnabled = true;
});

describe("initializeDesktopLocalTtft flush 定时器生命周期", () => {
  it("开关开启 + 配置启用：定时器启动；推送关闭后停止；再启用恢复（review #3）", async () => {
    const timers = createFakeTimerHost();
    const harness = createPlatform({ configResult: "enabled" });
    const dispose = initializeDesktopLocalTtft(harness.platform, timers);
    await vi.waitFor(() => expect(timers.activeCount()).toBe(1));

    harness.pushConfig({ localTtftEnabled: false });
    expect(timers.activeCount()).toBe(0);

    harness.pushConfig({ localTtftEnabled: true });
    expect(timers.activeCount()).toBe(1);

    dispose();
    expect(timers.activeCount()).toBe(0);
  });

  it("开关开启 + 配置禁用：定时器不启动（不空转）", async () => {
    const timers = createFakeTimerHost();
    const harness = createPlatform({ configResult: "disabled" });
    const dispose = initializeDesktopLocalTtft(harness.platform, timers);
    await vi.waitFor(() =>
      expect(harness.platform.getRendererActionTraceConfig).toHaveBeenCalled(),
    );
    await Promise.resolve();
    expect(timers.activeCount()).toBe(0);
    dispose();
  });

  it("配置拉取 reject：兜底启动定时器，缓冲记录不会被漏冲刷（review #7）", async () => {
    const timers = createFakeTimerHost();
    const harness = createPlatform({ configResult: "reject" });
    const dispose = initializeDesktopLocalTtft(harness.platform, timers);
    await vi.waitFor(() => expect(timers.activeCount()).toBe(1));
    dispose();
    expect(timers.activeCount()).toBe(0);
  });

  it("开关关闭：与原实现一致立即常驻定时器（不等待配置）", () => {
    settingsState.dedupedIdlePollingEnabled = false;
    const timers = createFakeTimerHost();
    const harness = createPlatform({ configResult: "pending" });
    const dispose = initializeDesktopLocalTtft(harness.platform, timers);
    expect(timers.activeCount()).toBe(1);
    dispose();
    expect(timers.activeCount()).toBe(0);
  });

  it("开关开启 + 配置长时间未返回：定时器不启动（避免无意义空转）", () => {
    const timers = createFakeTimerHost();
    const harness = createPlatform({ configResult: "pending" });
    const dispose = initializeDesktopLocalTtft(harness.platform, timers);
    expect(timers.activeCount()).toBe(0);
    dispose();
  });
});
