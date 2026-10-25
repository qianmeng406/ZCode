// shiki tokensCache 容量策略与缓存 key 契约（boundedHighlightCacheEnabled）：
// 1. LRU：条数/字符量超限按最久未用淘汰，onAccess 刷新 recency；
// 2. 活跃订阅（in-flight tokenize）的 key 本轮跳过；
// 3. 缓存 key 含全文哈希：等长且首尾相同的代码不再碰撞。
import { describe, expect, it, vi } from "vitest";
import {
  createTokensCacheLimiter,
  DEFAULT_TOKENS_CACHE_LIMITS,
} from "../src/lib/shikiTokensCachePolicy.js";
import { getCodeTokensCacheKey } from "../src/lib/shikiHighlighter.js";
import {
  persistPerformanceSetting,
  subscribePerformanceSettings,
  type PerformanceSettings,
} from "../src/lib/performancePreferences.js";

const neverActive = () => false;

describe("createTokensCacheLimiter", () => {
  it("条数超限淘汰最旧条目", () => {
    const limiter = createTokensCacheLimiter({ maxEntries: 3, maxTotalChars: 1_000_000 });
    expect(limiter.onInsert("a", 10, neverActive)).toEqual([]);
    expect(limiter.onInsert("b", 10, neverActive)).toEqual([]);
    expect(limiter.onInsert("c", 10, neverActive)).toEqual([]);
    expect(limiter.onInsert("d", 10, neverActive)).toEqual(["a"]);
    expect(limiter.totalApproxChars).toBe(30);
  });

  it("onAccess 刷新 recency：被访问的条目不再是最旧", () => {
    const limiter = createTokensCacheLimiter({ maxEntries: 3, maxTotalChars: 1_000_000 });
    limiter.onInsert("a", 10, neverActive);
    limiter.onInsert("b", 10, neverActive);
    limiter.onInsert("c", 10, neverActive);
    limiter.onAccess("a");
    expect(limiter.onInsert("d", 10, neverActive)).toEqual(["b"]);
  });

  it("字符量预算独立生效：单条超预算时淘汰旧条目直到回到限内", () => {
    const limiter = createTokensCacheLimiter({ maxEntries: 100, maxTotalChars: 50 });
    limiter.onInsert("a", 20, neverActive);
    limiter.onInsert("b", 20, neverActive);
    expect(limiter.onInsert("c", 20, neverActive)).toEqual(["a"]);
    expect(limiter.totalApproxChars).toBe(40);
  });

  it("活跃订阅（in-flight）的 key 本轮跳过，订阅释放后的下一轮写入补淘汰", () => {
    const limiter = createTokensCacheLimiter({ maxEntries: 2, maxTotalChars: 1_000_000 });
    limiter.onInsert("a", 10, neverActive);
    limiter.onInsert("b", 10, neverActive);
    const active = new Set(["a"]);
    const isActive = (key: string) => active.has(key);
    expect(limiter.onInsert("c", 10, isActive)).toEqual(["b"]);
    active.delete("a");
    expect(limiter.onInsert("d", 10, isActive)).toEqual(["a"]);
  });

  it("同 key 重复写入更新字符量且不淘汰自己", () => {
    const limiter = createTokensCacheLimiter({ maxEntries: 2, maxTotalChars: 1_000_000 });
    limiter.onInsert("a", 10, neverActive);
    limiter.onInsert("b", 10, neverActive);
    expect(limiter.onInsert("a", 30, neverActive)).toEqual([]);
    expect(limiter.totalApproxChars).toBe(40);
    expect(limiter.onInsert("c", 10, neverActive)).toEqual(["b"]);
  });

  it("默认上限常量存在且为正", () => {
    expect(DEFAULT_TOKENS_CACHE_LIMITS.maxEntries).toBeGreaterThan(0);
    expect(DEFAULT_TOKENS_CACHE_LIMITS.maxTotalChars).toBeGreaterThan(0);
  });
});

describe("getCodeTokensCacheKey", () => {
  it("等长且首尾 100 字符相同、中段不同的代码生成不同 key（旧实现会碰撞）", () => {
    const pad = (ch: string) => ch.repeat(150);
    const first = pad("A");
    const last = pad("Z");
    const codeOne = `${first}middle-one${last}`;
    const codeTwo = `${first}middle-two${last}`;
    expect(codeOne.length).toBe(codeTwo.length);
    expect(codeOne.slice(0, 100)).toBe(codeTwo.slice(0, 100));
    expect(codeOne.slice(-100)).toBe(codeTwo.slice(-100));
    expect(getCodeTokensCacheKey(codeOne, "ts", "github-dark")).not.toBe(
      getCodeTokensCacheKey(codeTwo, "ts", "github-dark"),
    );
  });

  it("同输入 key 稳定；语言或主题不同 key 不同", () => {
    const code = "const x = 1;";
    expect(getCodeTokensCacheKey(code, "ts", "github-dark")).toBe(
      getCodeTokensCacheKey(code, "ts", "github-dark"),
    );
    expect(getCodeTokensCacheKey(code, "ts", "github-dark")).not.toBe(
      getCodeTokensCacheKey(code, "js", "github-dark"),
    );
    expect(getCodeTokensCacheKey(code, "ts", "github-dark")).not.toBe(
      getCodeTokensCacheKey(code, "ts", "github-light"),
    );
  });
});

describe("subscribePerformanceSettings（开关同窗即时生效通道）", () => {
  it("persistPerformanceSetting 落盘后通知订阅者携带最新值；退订后不再通知", () => {
    const listener = vi.fn();
    const off = subscribePerformanceSettings(listener);
    const current: PerformanceSettings = {
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
    persistPerformanceSetting("boundedHighlightCacheEnabled", true, current);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      ...current,
      boundedHighlightCacheEnabled: true,
    });
    off();
    persistPerformanceSetting("boundedHighlightCacheEnabled", false, {
      ...current,
      boundedHighlightCacheEnabled: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
