/**
 * 会话指标卡片的事实派生（纯函数，ConversationComposer 消费）。
 *
 * 两条事实源，各自有独立的"何时可用"判定：
 * - 会话级：`snapshot.usage.cumulative`（CLI 在权威 ModelComplete 处累计，仅 main_turn）；
 * - 单请求：rows.window 尾部最近一个**带 `lastRequest`** 的 turnHeader。新主轮刚开轮时
 *   header 已建但 ModelComplete 未到（无 lastRequest）——必须跳过，回落到上一轮的
 *   最后一个请求，避免"上次请求"被冲成空。
 * composer 只读 snapshot，不维护第二份状态。
 */
import type {
  ComposerSessionUsage,
  ComposerTurnMetricsFact,
} from "@/v4/composer/ComposerTurnMetricsCapsule.js";

interface TurnHeaderLike {
  kind: string;
  /** 可见产品轮序号（CLI 投影分配）；旧快照缺席。 */
  turnOrdinal?: number;
  /** 该轮已完成的 main 请求数 = 最近一次请求所在的"步"。 */
  requestCount?: number;
  lastRequest?: {
    outputTokens?: number;
    timeToFirstTokenMs?: number;
    generationDurationMs?: number;
    inputTokens?: number;
    cacheReadTokens?: number;
  };
}

interface SessionUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  requestCount?: number;
}

function pickSessionUsage(usage: SessionUsageLike | undefined): ComposerSessionUsage | undefined {
  if (!usage) return undefined;
  const session: ComposerSessionUsage = {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.requestCount !== undefined ? { requestCount: usage.requestCount } : {}),
  };
  return Object.keys(session).length > 0 ? session : undefined;
}

export function deriveComposerTurnMetricsFact(
  rows: readonly TurnHeaderLike[] | undefined,
  usage?: SessionUsageLike | undefined,
): ComposerTurnMetricsFact | null {
  const session = pickSessionUsage(usage);
  let lastRequest: ComposerTurnMetricsFact["lastRequest"];
  let lastRequestTurn: ComposerTurnMetricsFact["lastRequestTurn"];
  if (rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind !== "turnHeader") continue;
      if (!row.lastRequest) continue;
      lastRequest = row.lastRequest;
      // 位置与单请求事实必须来自同一个 turnHeader：只剩一侧事实时位置留空，
      // 不拿别的轮去拼一个看似合理的"第 N 轮"。
      const step = row.requestCount;
      if (row.turnOrdinal !== undefined && step !== undefined && step > 0) {
        lastRequestTurn = { ordinal: row.turnOrdinal, step };
      }
      break;
    }
  }
  if (!session && !lastRequest) return null;
  return {
    ...(session ? { session } : {}),
    ...(lastRequest ? { lastRequest } : {}),
    ...(lastRequestTurn ? { lastRequestTurn } : {}),
  };
}
