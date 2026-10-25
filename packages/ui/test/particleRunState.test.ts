// 粒子层空闲收敛的决策契约（idleParticlePauseEnabled）：
// 1. 运行资格 = 窗口可见 && 画布在视口内，翻转才通知（IO 高频回调不抖动重启）；
// 2. 排程计划：功能关闭 → legacy（原路径）；启用后暂停优先于降频。
import { describe, expect, it, vi } from "vitest";
import {
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
