// @vitest-environment jsdom
// FloatingParticles 关闭态等价与开启态调度契约（review #1/#4/#5）：
// 1. 关闭态：不注册 IntersectionObserver / visibilitychange，rAF 自续约链与原实现一致；
// 2. 开启态：隐藏暂停（取消在途）、恢复可见立即续画；
// 3. 稳态节流：绘制后排定时器而非连续 rAF；
// 4. 回归：暂停态下关闭开关后恢复可见，粒子链能重新拉起（不冻结）；
// 5. 关闭开关后不再保留门控资源。
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingParticles } from "../src/components/ui/floating-particles.js";

interface FakeContext {
  [key: string]: unknown;
}

const rafQueue: Array<{ handle: number; cb: (now: number) => void }> = [];
let rafSeq = 1;
let frameTimestamp = 0;
let visibility: DocumentVisibilityState = "visible";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  disconnected = false;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function createFakeContext(): FakeContext {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    shadowBlur: 0,
    shadowColor: "",
    globalAlpha: 1,
  };
}

function flushFrame(): void {
  const next = rafQueue.shift();
  if (!next) throw new Error("no pending animation frame");
  frameTimestamp += 50;
  next.cb(frameTimestamp);
}

function setVisibility(next: DocumentVisibilityState, root: ReturnType<typeof createRoot>): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  void root;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  rafQueue.length = 0;
  rafSeq = 1;
  frameTimestamp = 0;
  visibility = "visible";
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
    const handle = rafSeq++;
    rafQueue.push({ handle, cb: callback });
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    const index = rafQueue.findIndex((entry) => entry.handle === handle);
    if (index >= 0) rafQueue.splice(index, 1);
  });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => createFakeContext() as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(props: { pauseWhenHidden?: boolean; idleThrottleMs?: number; settled?: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(FloatingParticles, props)));
  return {
    root,
    rerender: (nextProps: typeof props) =>
      act(() => root.render(createElement(FloatingParticles, nextProps))),
  };
}

describe("FloatingParticles 空闲收敛", () => {
  it("关闭态：不注册 IO/visibilitychange，rAF 自续约链保持原实现节奏", () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const { root } = mount({});
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(addListener.mock.calls.some(([type]) => type === "visibilitychange")).toBe(false);
    expect(rafQueue).toHaveLength(1);

    // 原实现：每帧回调顶部自续约 → 始终恰好一条在途链。
    flushFrame();
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(rafQueue).toHaveLength(1);

    // 关闭态隐藏也不停画（与原行为一致，交由 Chromium backgroundThrottling）。
    setVisibility("hidden", root);
    expect(rafQueue).toHaveLength(1);
    act(() => root.unmount());
  });

  it("开启态：隐藏暂停（取消在途），恢复可见立即续画", () => {
    const { root } = mount({ pauseWhenHidden: true });
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(rafQueue).toHaveLength(1);

    setVisibility("hidden", root);
    expect(rafQueue).toHaveLength(0);

    setVisibility("visible", root);
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(rafQueue).toHaveLength(1);
    act(() => root.unmount());
  });

  it("稳态节流：首帧立即绘制，之后改排 500ms 定时器而非连续 rAF", () => {
    const { root } = mount({ pauseWhenHidden: true, idleThrottleMs: 500 });
    // 启动首帧立即（不空白 500ms）。
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    // 绘制完成后不再连续 rAF，而是排一个 500ms 定时器。
    expect(rafQueue).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(rafQueue).toHaveLength(1);
    act(() => root.unmount());
  });

  it("回归（review #1）：暂停态下关闭开关后恢复可见，链能重新拉起不冻结", () => {
    const { root, rerender } = mount({ pauseWhenHidden: true });
    setVisibility("hidden", root);
    expect(rafQueue).toHaveLength(0); // 暂停：无任何在途排程

    // 暂停态下关闭开关：syncGating 卸载门控并把 legacy 链交还回来。
    rerender({ pauseWhenHidden: false });
    expect(rafQueue).toHaveLength(1);

    // 恢复可见：onChange 不得再取消 legacy 链，也不产生第二条链。
    setVisibility("visible", root);
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(rafQueue).toHaveLength(1);

    // 门控资源已被释放。
    expect(FakeIntersectionObserver.instances.every((instance) => instance.disconnected)).toBe(
      true,
    );
    act(() => root.unmount());
  });

  it("恢复隐藏态：开启态下再次隐藏会被新的门控暂停，恢复后继续", () => {
    const { root } = mount({ pauseWhenHidden: true });
    setVisibility("hidden", root);
    expect(rafQueue).toHaveLength(0);
    setVisibility("visible", root);
    expect(rafQueue).toHaveLength(1);
    setVisibility("hidden", root);
    expect(rafQueue).toHaveLength(0);
    act(() => root.unmount());
  });
});
