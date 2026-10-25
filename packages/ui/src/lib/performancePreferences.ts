// 性能优化偏好：纯客户端展示/渲染偏好，全部默认关闭（fail-closed）。
// 这些开关只在开启时改变渲染策略（流式 markdown 分块、渲染单元复用、时钟局部化、
// 贴底滚动合并、流式帧合并），关闭时渲染路径与默认行为逐字节一致。
// 存储用单个 JSON key（便于版本化/迁移）；逐字段校验，非法或缺失一律按 false 处理。
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

export const PERFORMANCE_SETTINGS_STORAGE_KEY = "zcode-performance-settings";

export interface PerformanceSettings {
  streamingMarkdownIncrementalEnabled: boolean;
  stableRenderUnitsEnabled: boolean;
  scopedPresentationClockEnabled: boolean;
  coalescedBottomScrollEnabled: boolean;
  coalescedDeltaFramesEnabled: boolean;
  idleParticlePauseEnabled: boolean;
  boundedHighlightCacheEnabled: boolean;
  idleTickScanReductionEnabled: boolean;
  dedupedIdlePollingEnabled: boolean;
}

export const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = {
  streamingMarkdownIncrementalEnabled: false,
  stableRenderUnitsEnabled: false,
  scopedPresentationClockEnabled: false,
  coalescedBottomScrollEnabled: false,
  coalescedDeltaFramesEnabled: false,
  idleParticlePauseEnabled: false,
  boundedHighlightCacheEnabled: false,
  idleTickScanReductionEnabled: false,
  dedupedIdlePollingEnabled: false,
};

export function parsePerformanceSettings(raw: string | null | undefined): PerformanceSettings {
  if (!raw) return { ...DEFAULT_PERFORMANCE_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PERFORMANCE_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_PERFORMANCE_SETTINGS };
  }
  const record = parsed as Record<string, unknown>;
  const flag = (key: keyof PerformanceSettings) =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : DEFAULT_PERFORMANCE_SETTINGS[key];
  return {
    streamingMarkdownIncrementalEnabled: flag("streamingMarkdownIncrementalEnabled"),
    stableRenderUnitsEnabled: flag("stableRenderUnitsEnabled"),
    scopedPresentationClockEnabled: flag("scopedPresentationClockEnabled"),
    coalescedBottomScrollEnabled: flag("coalescedBottomScrollEnabled"),
    coalescedDeltaFramesEnabled: flag("coalescedDeltaFramesEnabled"),
    idleParticlePauseEnabled: flag("idleParticlePauseEnabled"),
    boundedHighlightCacheEnabled: flag("boundedHighlightCacheEnabled"),
    idleTickScanReductionEnabled: flag("idleTickScanReductionEnabled"),
    dedupedIdlePollingEnabled: flag("dedupedIdlePollingEnabled"),
  };
}

export function loadPerformanceSettings(): PerformanceSettings {
  return parsePerformanceSettings(readSafeLocalStorage(PERFORMANCE_SETTINGS_STORAGE_KEY));
}

function persistPerformanceSettings(settings: PerformanceSettings): void {
  writeSafeLocalStorage(PERFORMANCE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

/** 逐字段写入：调用方持有当前值（store 初始化时读一次），避免每个 setter 重读解析。 */
export function persistPerformanceSetting<K extends keyof PerformanceSettings>(
  key: K,
  enabled: boolean,
  current: PerformanceSettings,
): void {
  persistPerformanceSettings({ ...current, [key]: enabled });
}
