/**
 * main-turn 指标卡片的事实派生（纯函数，ConversationComposer 消费）。
 *
 * 规则：从 rows.window 尾部向前找最近一个**带指标事实**的 turnHeader。
 * 新主轮刚开轮时 header 已建但 ModelComplete 未到（全部缺席）——必须跳过，
 * 回落到上一完成轮，避免上一轮真实值被冲成全 `--`；运行中 header 一旦有
 * 部分指标则优先显示（live 值）。composer 只读 snapshot，不维护第二份状态。
 */
import type { ComposerTurnMetricsFact } from "@/v4/composer/ComposerTurnMetricsCapsule.js";

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

export function deriveComposerTurnMetricsFact(
  rows: readonly TurnHeaderLike[] | undefined,
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
    };
  }
  return null;
}
