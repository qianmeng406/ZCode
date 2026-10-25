// shiki tokensCache 的容量策略（性能开关 boundedHighlightCacheEnabled）。
// 纯逻辑、无缓存 Map 依赖：shikiHighlighter 在写入/命中时回调，拿到应淘汰的 key
// 自行删除。LRU 语义 = Map 迭代序（插入序，onAccess 重插刷新）。

export interface TokensCacheLimits {
  maxEntries: number;
  maxTotalChars: number;
}

export const DEFAULT_TOKENS_CACHE_LIMITS: TokensCacheLimits = {
  maxEntries: 256,
  maxTotalChars: 1_500_000,
};

export interface TokensCacheLimiter {
  /** 写入登记：返回本轮应淘汰的 key（插入序最旧优先；活跃条目跳过，下轮再评估）。 */
  onInsert(
    key: string,
    approxChars: number,
    hasActiveSubscriber: (key: string) => boolean,
  ): string[];
  /** 命中登记：刷新最近使用。 */
  onAccess(key: string): void;
  /** 累计近似字符量（诊断口径）。 */
  readonly totalApproxChars: number;
}

export function createTokensCacheLimiter(
  limits: TokensCacheLimits = DEFAULT_TOKENS_CACHE_LIMITS,
): TokensCacheLimiter {
  const entries = new Map<string, number>();
  let totalApproxChars = 0;
  return {
    onInsert(key, approxChars, hasActiveSubscriber) {
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        totalApproxChars -= previous;
      }
      entries.set(key, approxChars);
      totalApproxChars += approxChars;
      const evicted: string[] = [];
      for (const [candidate, chars] of entries) {
        if (entries.size <= limits.maxEntries && totalApproxChars <= limits.maxTotalChars) break;
        if (candidate === key) break; // 新写入的条目本轮不淘汰自己
        if (hasActiveSubscriber(candidate)) continue; // in-flight：完成后再评估
        entries.delete(candidate);
        totalApproxChars -= chars;
        evicted.push(candidate);
      }
      return evicted;
    },
    onAccess(key) {
      const chars = entries.get(key);
      if (chars === undefined) return;
      entries.delete(key);
      entries.set(key, chars);
    },
    get totalApproxChars() {
      return totalApproxChars;
    },
  };
}
