import { memo, useEffect, useRef } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  createParticleFrameScheduler,
  createParticleRunState,
  resolveParticleFramePlan,
} from "@/components/ui/particleRunState.js";

const PARTICLE_COUNT = 96;
const PARTICLE_FRAME_INTERVAL_MS = 1_000 / 30;
const PARTICLE_SPRITE_SIZE = 24;
const PARTICLE_RADIUS = 1;
const HIGHLIGHT_PARTICLE_RADIUS = 1.5;
const HIGHLIGHT_PARTICLE_BLUR = 7;
// 高亮 index 按 seeded startLeft 选取，横向覆盖约 8%–92%，避免亮点集中在同一区域。
const HIGHLIGHT_PARTICLE_INDICES = new Set([1, 22, 42, 56, 57, 74, 90]);
// 超过最大相位偏移 2.6s + 最长周期 11.2s，粒子直接处于循环稳态，不再从空场逐个冒出。
const PARTICLE_SETTLED_ELAPSED_MS = 14_000;
// idleParticlePauseEnabled 开启后的稳态绘制间隔（2fps）：慢速漂移粒子在该频率下
// 视觉上无顿挫，帧成本相对 30fps 下降约 93%。宿主按相位决定是否传入。
export const IDLE_PARTICLE_THROTTLE_MS = 500;

interface FloatingParticle {
  cycleDuration: number;
  highlight: boolean;
  horizontalDrift: number;
  opacity: number;
  phaseOffset: number;
  riseDistance: number;
  startLeft: number;
  startTop: number;
  swayDistance: number;
}

function seededUnit(index: number, salt: number) {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

const PARTICLES: FloatingParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, index) => {
  const highlight = HIGHLIGHT_PARTICLE_INDICES.has(index);
  return {
    startTop: 94 + seededUnit(index, 1) * 6,
    startLeft: seededUnit(index, 2) * 100,
    riseDistance: 72 + seededUnit(index, 3) * 64,
    horizontalDrift: seededUnit(index, 4) * 36 - 18,
    swayDistance: seededUnit(index, 5) * 16 - 8,
    opacity: highlight ? 0.82 + seededUnit(index, 6) * 0.16 : 0.4 + seededUnit(index, 6) * 0.32,
    cycleDuration: 6.4 + seededUnit(index, 7) * 4.8,
    phaseOffset: seededUnit(index, 8) * 2.6,
    highlight,
  };
});

const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;

function interpolateParticleChannel(progress: number, values: readonly number[]): number {
  const times = [0, 0.12, 0.38, 0.7, 1];
  const nextIndex = times.findIndex((time) => time > progress);
  const segment = Math.max(0, Math.min(times.length - 2, nextIndex - 1));
  const start = times[segment] ?? 0;
  const end = times[segment + 1] ?? 1;
  return lerp(
    values[segment] ?? 0,
    values[segment + 1] ?? 0,
    (progress - start) / Math.max(end - start, Number.EPSILON),
  );
}

function createParticleSprite({
  color,
  glowColor,
  highlight,
  pixelRatio,
}: {
  color: string;
  glowColor?: string;
  highlight: boolean;
  pixelRatio: number;
}): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  sprite.height = Math.ceil(PARTICLE_SPRITE_SIZE * pixelRatio);
  const context = sprite.getContext("2d", { alpha: true });
  if (!context) return sprite;

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = color;
  if (highlight) {
    context.shadowBlur = HIGHLIGHT_PARTICLE_BLUR;
    context.shadowColor = glowColor ?? "transparent";
  }
  context.beginPath();
  context.arc(
    PARTICLE_SPRITE_SIZE / 2,
    PARTICLE_SPRITE_SIZE / 2,
    highlight ? HIGHLIGHT_PARTICLE_RADIUS : PARTICLE_RADIUS,
    0,
    Math.PI * 2,
  );
  context.fill();
  return sprite;
}

export const FloatingParticles = memo(function FloatingParticles({
  className,
  settled = false,
  pauseWhenHidden = false,
  idleThrottleMs,
}: {
  className?: string;
  /** 直接从循环稳态开始绘制（Highspeed 恢复入场），跳过从空场逐个冒出的起始段。 */
  settled?: boolean;
  /** 性能开关 idleParticlePauseEnabled：隐藏/离屏暂停 + 节流排程；false 时路径与原实现一致。 */
  pauseWhenHidden?: boolean;
  /** 稳态降频间隔（ms）；undefined 表示本相位维持 30fps。运行期动态读取，切换不重建动画时钟。 */
  idleThrottleMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 节流/暂停输入经 ref 动态读取：effect 依赖保持 [settled]，切换开关或相位变化
  // 不会重建 effect（否则 startedAt 重置会让入场动画从空场重播一遍）。
  const pauseWhenHiddenRef = useRef(pauseWhenHidden);
  pauseWhenHiddenRef.current = pauseWhenHidden;
  const idleThrottleMsRef = useRef(idleThrottleMs);
  idleThrottleMsRef.current = idleThrottleMs;
  // effect 内门控资源的装卸入口：开关翻转时经这个 ref 触发（不重建 effect）。
  const syncGatingRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Bug 根因：旧实现同时挂载 96 个 motion.span 与独立动画控制器，恰好和扩散 Canvas
    // 收尾竞争 renderer 主线程。统一到一张 Canvas 后，交接只剩父层 opacity 合成。
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !context) return;

    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let lastFrameAt = -PARTICLE_FRAME_INTERVAL_MS;
    let color = "";
    let highlightColor = "";
    let glowColor = "";
    let particleSprite: HTMLCanvasElement | undefined;
    let highlightParticleSprite: HTMLCanvasElement | undefined;
    const startedAt = performance.now() - (settled ? PARTICLE_SETTLED_ELAPSED_MS : 0);

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      const style = getComputedStyle(canvas);
      color = style.getPropertyValue("--color-highspeed-particle");
      highlightColor = style.getPropertyValue("--color-highspeed-particle-highlight");
      glowColor = style.getPropertyValue("--color-highspeed-particle-highlight-glow");
      // Bug 根因：Canvas shadowBlur 在部分 Electron/macOS 环境会逐帧触发昂贵的软件栅格化。
      // 辉光只在尺寸变化时离屏生成一次，动画帧复用位图，避免 Renderer 长期满载。
      particleSprite = createParticleSprite({ color, highlight: false, pixelRatio: scale });
      highlightParticleSprite = createParticleSprite({
        color: highlightColor,
        glowColor,
        highlight: true,
        pixelRatio: scale,
      });
    };

    const renderFrame = (now: number) => {
      context.clearRect(0, 0, width, height);
      const elapsedSeconds = Math.max(0, (now - startedAt) / 1_000);

      for (const particle of PARTICLES) {
        const activeElapsed = elapsedSeconds - particle.phaseOffset;
        if (activeElapsed < 0 && !reducedMotion) continue;
        const progress = reducedMotion
          ? 0.48
          : (activeElapsed % particle.cycleDuration) / particle.cycleDuration;
        const x = interpolateParticleChannel(progress, [
          0,
          particle.swayDistance * 0.35,
          -particle.swayDistance * 0.25,
          particle.horizontalDrift * 0.65 + particle.swayDistance * 0.2,
          particle.horizontalDrift,
        ]);
        const y = interpolateParticleChannel(progress, [
          0,
          -particle.riseDistance * 0.38,
          -particle.riseDistance * 0.64,
          -particle.riseDistance * 0.82,
          -particle.riseDistance,
        ]);
        const opacity = reducedMotion
          ? particle.opacity * 0.72
          : interpolateParticleChannel(progress, [
              0,
              particle.opacity,
              particle.opacity * 0.92,
              particle.opacity * 0.7,
              0,
            ]);
        const particleScale = interpolateParticleChannel(progress, [0.55, 1.1, 1, 0.8, 0.4]);
        const sprite = particle.highlight ? highlightParticleSprite : particleSprite;
        if (!sprite) continue;
        const spriteSize = PARTICLE_SPRITE_SIZE * particleScale;
        const particleX = (particle.startLeft / 100) * width + x;
        const particleY = (particle.startTop / 100) * height + y;
        context.globalAlpha = opacity;
        context.drawImage(
          sprite,
          particleX - spriteSize / 2,
          particleY - spriteSize / 2,
          spriteSize,
          spriteSize,
        );
      }
      context.globalAlpha = 1;
    };

    // —— 空闲收敛（idleParticlePauseEnabled）的调度基建 ——
    // 排程所有权归 scheduler：mode 是「是否有在途排程 + 归属路径」的唯一事实来源。
    // 暂停恢复/开关关闭时只有 mode==="none" 才补排程，避免双重链或永久冻结。
    const scheduler = createParticleFrameScheduler({
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      scheduleTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancelTimer: (handle) => window.clearTimeout(handle),
    });

    const runState = createParticleRunState({
      onChange: () => {
        if (!runState.shouldRun()) {
          // 只有收敛链由我们接管取消；legacy（开关关闭）保持原「隐藏也继续画」行为。
          if (scheduler.mode === "converged") scheduler.cancel();
          return;
        }
        // 恢复运行：只有在无任何在途排程（如暂停态）时才补一次，避免双重链。
        if (scheduler.mode === "none") {
          lastFrameAt = -PARTICLE_FRAME_INTERVAL_MS; // 恢复可见立即补一帧
          scheduler.schedule({ kind: "immediate" }, draw);
        }
      },
    });

    // 门控资源按开关动态装卸：功能关闭时不注册任何 IO/visibility 监听（与原实现一致）。
    let intersectionObserver: IntersectionObserver | undefined;
    let gatingAttached = false;
    const onVisibilityChange = () => runState.setHidden(document.visibilityState === "hidden");
    const attachGating = () => {
      if (gatingAttached) return;
      gatingAttached = true;
      runState.setHidden(document.visibilityState === "hidden");
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (typeof IntersectionObserver !== "undefined") {
        intersectionObserver = new IntersectionObserver((entries) => {
          runState.setIntersecting(entries.some((entry) => entry.isIntersecting));
        });
        intersectionObserver.observe(canvas);
      }
    };
    const detachGating = () => {
      if (!gatingAttached) return;
      gatingAttached = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      intersectionObserver?.disconnect();
      intersectionObserver = undefined;
    };
    const syncGating = () => {
      if (pauseWhenHiddenRef.current === true) {
        attachGating();
        return;
      }
      detachGating();
      // 开关由开转关时若处于暂停态（无在途排程），显式交回 legacy 自续约路径，
      // 否则 draw 不会再被唤醒，画布会永久停在最后一帧。
      if (scheduler.mode === "none") scheduler.schedule({ kind: "legacy" }, draw);
    };
    syncGatingRef.current = syncGating;

    const draw = (now: number) => {
      const plan = resolveParticleFramePlan({
        gated: pauseWhenHiddenRef.current === true,
        throttleMs: idleThrottleMsRef.current,
        shouldRun: runState.shouldRun(),
      });
      if (plan.kind === "legacy") {
        // 功能关闭：保持原实现「回调顶部自续约 + 帧间隔早退」路径，行为逐字节一致。
        scheduler.markLegacy(window.requestAnimationFrame(draw));
        if (now - lastFrameAt < PARTICLE_FRAME_INTERVAL_MS) return;
        lastFrameAt = now;
        renderFrame(now);
        if (reducedMotion) scheduler.cancel();
        return;
      }
      // 收敛路径：暂停态取消在途排程（由 runState 的 resume 唤醒），其余先绘制再排下一帧。
      if (plan.kind === "paused") {
        scheduler.cancel();
        return;
      }
      if (now - lastFrameAt < PARTICLE_FRAME_INTERVAL_MS) {
        scheduler.schedule(plan, draw);
        return;
      }
      lastFrameAt = now;
      renderFrame(now);
      if (reducedMotion) {
        scheduler.cancel();
        return;
      }
      scheduler.schedule(plan, draw);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    // 被隐藏/离屏挂载且功能开启时不启动循环，等门控 resume 唤醒；
    // 功能关闭时启动语义与原实现一致（直接 legacy 自续约）。
    // 节流相位也先立即绘制首帧（避免开启/进入稳态后空白 500ms），随后按节流排程。
    const initialPlan = resolveParticleFramePlan({
      gated: pauseWhenHiddenRef.current === true,
      throttleMs: idleThrottleMsRef.current,
      shouldRun: runState.shouldRun(),
    });
    if (initialPlan.kind !== "paused") {
      scheduler.schedule(
        initialPlan.kind === "throttled" ? { kind: "immediate" } : initialPlan,
        draw,
      );
    }
    return () => {
      observer.disconnect();
      detachGating();
      scheduler.cancel();
      syncGatingRef.current = () => {};
    };
  }, [settled]);

  // 开关翻转时重装门控资源并处理暂停态交接（effect 依赖保持 [settled]，
  // 避免重建 effect 重置 startedAt 导致入场动画重播）。
  useEffect(() => {
    syncGatingRef.current();
  }, [pauseWhenHidden]);

  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <canvas ref={canvasRef} className="highspeed-particle-canvas absolute inset-0 size-full" />
    </div>
  );
});
