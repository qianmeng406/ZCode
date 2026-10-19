/**
 * main-turn 指标胶囊的事实派生（纯函数，ConversationComposer 消费）。
 *
 * 规则：从 rows.window 尾部向前找最近一个**带指标事实**的 turnHeader。
 * 新主轮刚开轮时 header 已建但 ModelComplete 未到（三项全缺席）——必须跳过，
 * 回落到上一完成轮，避免上一轮真实值被冲成全 `--`；运行中 header 一旦有
 * 部分指标则优先显示（live 值）。composer 只读 snapshot，不维护第二份状态。
 */
import type {
  ComposerSessionMetrics,
  ComposerTurnMetricsFact,
} from "@/v4/composer/ComposerTurnMetricsCapsule.js";

interface TurnHeaderLike {
  kind: string;
  outputTokens?: number;
  timeToFirstTokenMs?: number;
  generationDurationMs?: number;
  inputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestCount?: number;
  lastRequest?: {
    outputTokens?: number;
    timeToFirstTokenMs?: number;
    generationDurationMs?: number;
  };
}

interface SessionUsageLike {
  cumulative: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    generationDurationMs?: number;
    requestCount?: number;
  };
}

function pickSessionMetrics(
  usage: SessionUsageLike | undefined,
): ComposerSessionMetrics | undefined {
  if (!usage) return undefined;
  const cumulative = usage.cumulative;
  return {
    inputTokens: cumulative.inputTokens,
    outputTokens: cumulative.outputTokens,
    cacheReadTokens: cumulative.cacheReadTokens,
    cacheWriteTokens: cumulative.cacheWriteTokens,
    ...(cumulative.generationDurationMs !== undefined
      ? { generationDurationMs: cumulative.generationDurationMs }
      : {}),
    ...(cumulative.requestCount !== undefined ? { requestCount: cumulative.requestCount } : {}),
  };
}

export function deriveComposerTurnMetricsFact(
  rows: readonly TurnHeaderLike[] | undefined,
  usage?: SessionUsageLike,
): ComposerTurnMetricsFact | null {
  if (!rows) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "turnHeader") continue;
    if (
      row.outputTokens === undefined &&
      row.timeToFirstTokenMs === undefined &&
      row.generationDurationMs === undefined &&
      row.requestCount === undefined
    ) {
      continue;
    }
    const session = pickSessionMetrics(usage);
    return {
      ...(row.outputTokens !== undefined ? { outputTokens: row.outputTokens } : {}),
      ...(row.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: row.timeToFirstTokenMs }
        : {}),
      ...(row.generationDurationMs !== undefined
        ? { generationDurationMs: row.generationDurationMs }
        : {}),
      ...(row.inputTokens !== undefined ? { inputTokens: row.inputTokens } : {}),
      ...(row.reasoningTokens !== undefined ? { reasoningTokens: row.reasoningTokens } : {}),
      ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {}),
      ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
      ...(row.requestCount !== undefined ? { requestCount: row.requestCount } : {}),
      ...(row.lastRequest ? { lastRequest: row.lastRequest } : {}),
      ...(session ? { session } : {}),
    };
  }
  return null;
}
