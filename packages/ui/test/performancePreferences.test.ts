// 性能偏好解析契约：非法/缺失字段一律回退默认 false（fail-closed），
// 未知字段忽略；新增开关必须同步进 DEFAULT_PERFORMANCE_SETTINGS。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERFORMANCE_SETTINGS,
  parsePerformanceSettings,
  type PerformanceSettings,
} from "../src/lib/performancePreferences.js";

const ALL_TRUE: PerformanceSettings = {
  streamingMarkdownIncrementalEnabled: true,
  stableRenderUnitsEnabled: true,
  scopedPresentationClockEnabled: true,
  coalescedBottomScrollEnabled: true,
  coalescedDeltaFramesEnabled: true,
  idleParticlePauseEnabled: true,
  boundedHighlightCacheEnabled: true,
  idleTickScanReductionEnabled: true,
  dedupedIdlePollingEnabled: true,
};

describe("parsePerformanceSettings", () => {
  it("空输入与非 JSON 输入回退全默认（全 false）", () => {
    expect(parsePerformanceSettings(null)).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
    expect(parsePerformanceSettings(undefined)).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
    expect(parsePerformanceSettings("")).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
    expect(parsePerformanceSettings("not-json{")).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
  });

  it("非对象 JSON（数组/数字/null 字面量）回退全默认", () => {
    expect(parsePerformanceSettings("[1,2]")).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
    expect(parsePerformanceSettings("42")).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
    expect(parsePerformanceSettings("null")).toEqual(DEFAULT_PERFORMANCE_SETTINGS);
  });

  it("合法输入逐字段透传，未知字段忽略", () => {
    expect(parsePerformanceSettings(JSON.stringify(ALL_TRUE))).toEqual(ALL_TRUE);
    expect(parsePerformanceSettings(JSON.stringify({ ...ALL_TRUE, unknownFlag: true }))).toEqual(
      ALL_TRUE,
    );
  });

  it("类型不合法的字段单独回退 false，其余字段保留", () => {
    const parsed = parsePerformanceSettings(
      JSON.stringify({
        ...ALL_TRUE,
        idleParticlePauseEnabled: "yes",
        boundedHighlightCacheEnabled: 1,
        dedupedIdlePollingEnabled: null,
      }),
    );
    expect(parsed).toEqual({
      ...ALL_TRUE,
      idleParticlePauseEnabled: false,
      boundedHighlightCacheEnabled: false,
      dedupedIdlePollingEnabled: false,
    });
  });

  it("缺失字段回退 false（旧版本存储升级场景）", () => {
    const parsed = parsePerformanceSettings(
      JSON.stringify({
        streamingMarkdownIncrementalEnabled: true,
      } satisfies Partial<PerformanceSettings>),
    );
    expect(parsed).toEqual({
      ...DEFAULT_PERFORMANCE_SETTINGS,
      streamingMarkdownIncrementalEnabled: true,
    });
  });
});
