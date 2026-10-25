// Highspeed 到期候选集（性能开关 idleTickScanReductionEnabled）：
// resolveNextHighspeedExpiryMs 每秒对全量 rows 线性扫描；改为「rows 变化时收集
// 升序候选数组，每秒只在候选里推进」，空闲期（rows 不变）每秒成本降为 O(候选数)。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** 收集窗口内全部 highspeed 卡的到期时间戳（升序；含已过期的，由查询侧过滤）。 */
export function collectHighspeedExpiryCandidates(rows: readonly ConversationRow[]): number[] {
  const candidates: number[] = [];
  for (const row of rows) {
    if (row.kind === "userInput" && row.highspeed) candidates.push(row.highspeed.expiresAt);
  }
  candidates.sort((a, b) => a - b);
  return candidates;
}

/** 与 resolveNextHighspeedExpiryMs 同语义：严格大于 nowMs 的最早到期时间。 */
export function resolveNextHighspeedExpiryFromCandidates(
  candidates: readonly number[],
  nowMs: number,
): number | undefined {
  for (const expiresAt of candidates) {
    if (expiresAt > nowMs) return expiresAt;
  }
  return undefined;
}
