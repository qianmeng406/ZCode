// 粒子层空闲收敛的纯决策模块（性能开关 idleParticlePauseEnabled）。
// 组件里的 rAF/setTimeout 接线保持薄层；这里只做可单测的状态与排程裁决。

/** 运行资格状态机：窗口可见 && 画布在视口内才继续绘制。 */
export interface ParticleRunState {
  setHidden(hidden: boolean): void;
  setIntersecting(intersecting: boolean): void;
  shouldRun(): boolean;
}

/**
 * onChange 只在 shouldRun 翻转时触发一次（IntersectionObserver 高频回调不会抖动重启）。
 * 初始按「可见 + 在视口内」乐观启动：IntersectionObserver 首次回调会立即校正。
 */
export function createParticleRunState(
  options: {
    onChange?: (running: boolean) => void;
  } = {},
): ParticleRunState {
  let hidden = false;
  let intersecting = true;
  const shouldRun = () => !hidden && intersecting;
  // 只在 shouldRun 翻转时通知：IO 高频回调里输入变化但资格不变时不重启调度。
  let lastNotified = shouldRun();
  const notifyIfFlipped = () => {
    const running = shouldRun();
    if (running === lastNotified) return;
    lastNotified = running;
    options.onChange?.(running);
  };
  return {
    setHidden(next: boolean): void {
      if (hidden === next) return;
      hidden = next;
      notifyIfFlipped();
    },
    setIntersecting(next: boolean): void {
      if (intersecting === next) return;
      intersecting = next;
      notifyIfFlipped();
    },
    shouldRun,
  };
}

export type ParticleFramePlan =
  /** 功能未启用：保持原有「回调顶部自续约 rAF」路径，逐字节等价。 */
  | { kind: "legacy" }
  /** 收敛路径：立即排下一帧（无节流）。 */
  | { kind: "immediate" }
  /** 收敛路径：延迟 throttleMs 再排下一帧（稳态降频）。 */
  | { kind: "throttled"; throttleMs: number }
  /** 隐藏/离屏：取消在途排程，等待 resume。 */
  | { kind: "paused" };

/**
 * 单帧结束后的排程裁决。gated=false 且无节流值 ⇒ legacy（开关关闭的原始路径）；
 * 功能启用后先看运行资格（隐藏/离屏优先于降频），再按节流值决定延迟。
 */
export function resolveParticleFramePlan(input: {
  gated: boolean;
  throttleMs: number | undefined;
  shouldRun: boolean;
}): ParticleFramePlan {
  if (!input.gated && input.throttleMs === undefined) return { kind: "legacy" };
  if (!input.shouldRun) return { kind: "paused" };
  if (input.throttleMs === undefined) return { kind: "immediate" };
  return { kind: "throttled", throttleMs: input.throttleMs };
}
