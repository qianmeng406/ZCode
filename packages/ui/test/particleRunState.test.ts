// 粒子层空闲收敛的决策契约（idleParticlePauseEnabled）：
// 1. 运行资格 = 窗口可见 && 画布在视口内，翻转才通知（IO 高频回调不抖动重启）；
// 2. 排程计划：功能关闭 → legacy（原路径）；启用后暂停优先于降频；
// 3. 排程所有权：mode 区分在途归属，暂停后可由外部重新拉起（不冻结）。
import { describe, expect, it, vi } from "vitest";
import {
  createParticleFrameScheduler,
  createParticleRunState,
  resolveParticleFramePlan,
} from "../src/components/ui/particleRunState.js";

describe("createParticleRunState", () => {
  it("默认可见且在视口内（shouldRun=true），IntersectionObserver 首回调再校正", () => {
    expect(createParticleRunState().shouldRun()).toBe(true);
  });

  it("隐藏或离屏任一为真即停止；两者都恢复才重新运行", () => {
    const state = createParticleRunState();
    state.setHidden(true);
    expect(state.shouldRun()).toBe(false);
    state.setHidden(false);
    expect(state.shouldRun()).toBe(true);
    state.setIntersecting(false);
    expect(state.shouldRun()).toBe(false);
    state.setHidden(true);
    state.setIntersecting(true);
    expect(state.shouldRun()).toBe(false);
    state.setHidden(false);
    expect(state.shouldRun()).toBe(true);
  });

  it("onChange 只在 shouldRun 翻转时触发，重复设置同值不通知", () => {
    const onChange = vi.fn();
    const state = createParticleRunState({ onChange });
    state.setHidden(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(false);
    state.setHidden(true);
    state.setIntersecting(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    state.setHidden(false); // intersecting 仍 false：shouldRun 不变，不通知
    expect(onChange).toHaveBeenCalledTimes(1);
    state.setIntersecting(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("resolveParticleFramePlan", () => {
  it("功能关闭（无门控且无节流）恒为 legacy，与原实现路径一致", () => {
    expect(
      resolveParticleFramePlan({ gated: false, throttleMs: undefined, shouldRun: false }),
    ).toEqual({ kind: "legacy" });
    expect(
      resolveParticleFramePlan({ gated: false, throttleMs: undefined, shouldRun: true }),
    ).toEqual({ kind: "legacy" });
  });

  it("功能启用：暂停优先于降频；无节流值为 immediate；有节流值为 throttled", () => {
    expect(resolveParticleFramePlan({ gated: true, throttleMs: 500, shouldRun: false })).toEqual({
      kind: "paused",
    });
    expect(
      resolveParticleFramePlan({ gated: true, throttleMs: undefined, shouldRun: true }),
    ).toEqual({
      kind: "immediate",
    });
    expect(resolveParticleFramePlan({ gated: true, throttleMs: 500, shouldRun: true })).toEqual({
      kind: "throttled",
      throttleMs: 500,
    });
  });

  it("仅传节流值而未开隐藏门控也进入收敛路径（宿主两个 prop 来自同一开关，此为防御组合）", () => {
    expect(resolveParticleFramePlan({ gated: false, throttleMs: 500, shouldRun: true })).toEqual({
      kind: "throttled",
      throttleMs: 500,
    });
    expect(resolveParticleFramePlan({ gated: false, throttleMs: 500, shouldRun: false })).toEqual({
      kind: "paused",
    });
  });
});

describe("createParticleFrameScheduler（注入 rAF/setTimeout 的排程契约）", () => {
  function createHarness() {
    const frames = new Map<number, (now: number) => void>();
    const timers = new Map<number, () => void>();
    const cancelledFrames: number[] = [];
    const cancelledTimers: number[] = [];
    let frameSeq = 0;
    let timerSeq = 0;
    const scheduler = createParticleFrameScheduler({
      requestFrame: (callback) => {
        const handle = ++frameSeq;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => {
        cancelledFrames.push(handle);
        frames.delete(handle);
      },
      scheduleTimer: (callback) => {
        const handle = ++timerSeq;
        timers.set(handle, callback);
        return handle;
      },
      cancelTimer: (handle) => {
        cancelledTimers.push(handle);
        timers.delete(handle);
      },
    });
    const flushFrame = (timestamp: number) => {
      const entry = frames.entries().next().value as [number, (now: number) => void];
      frames.delete(entry[0]);
      entry[1](timestamp);
    };
    const flushTimer = () => {
      const entry = timers.entries().next().value as [number, () => void];
      timers.delete(entry[0]);
      entry[1]();
    };
    return { scheduler, frames, timers, cancelledFrames, cancelledTimers, flushFrame, flushTimer };
  }

  it("legacy：排程 rAF 且 mode=legacy；cancel 清句柄回 none", () => {
    const harness = createHarness();
    harness.scheduler.schedule({ kind: "legacy" }, () => {});
    expect(harness.scheduler.mode).toBe("legacy");
    expect(harness.frames.size).toBe(1);
    harness.scheduler.cancel();
    expect(harness.scheduler.mode).toBe("none");
    expect(harness.frames.size).toBe(0);
    expect(harness.cancelledFrames).toHaveLength(1);
  });

  it("throttled：先定时器（不退化为连续 rAF），定时器到期再排一帧", () => {
    const harness = createHarness();
    const draw = vi.fn();
    harness.scheduler.schedule({ kind: "throttled", throttleMs: 500 }, draw);
    expect(harness.scheduler.mode).toBe("converged");
    expect(harness.frames.size).toBe(0);
    expect(harness.timers.size).toBe(1);
    harness.flushTimer();
    expect(harness.frames.size).toBe(1);
    harness.flushFrame(100);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("paused 等价 cancel：清定时器与 rAF，mode=none", () => {
    const harness = createHarness();
    harness.scheduler.schedule({ kind: "throttled", throttleMs: 500 }, () => {});
    harness.scheduler.schedule({ kind: "paused" }, () => {});
    expect(harness.scheduler.mode).toBe("none");
    expect(harness.timers.size).toBe(0);
    expect(harness.cancelledTimers).toHaveLength(1);
  });

  it("回归（review #1）：暂停态（无在途排程）后显式 schedule 能重新拉起链", () => {
    const harness = createHarness();
    harness.scheduler.schedule({ kind: "immediate" }, () => {});
    harness.scheduler.schedule({ kind: "paused" }, () => {}); // 隐藏 → 暂停，无在途
    expect(harness.scheduler.mode).toBe("none");
    // 开关关闭的交接路径：外部显式交回 legacy 链
    harness.scheduler.schedule({ kind: "legacy" }, () => {});
    expect(harness.scheduler.mode).toBe("legacy");
    expect(harness.frames.size).toBe(1); // 链重新可运行，不再永久冻结
  });

  it("markLegacy 登记自续约句柄；cancel 能清掉 legacy 句柄", () => {
    const harness = createHarness();
    harness.scheduler.schedule({ kind: "immediate" }, () => {});
    harness.scheduler.cancel();
    harness.scheduler.markLegacy(42);
    expect(harness.scheduler.mode).toBe("legacy");
    harness.scheduler.cancel();
    expect(harness.cancelledFrames).toContain(42);
    expect(harness.scheduler.mode).toBe("none");
  });
});
