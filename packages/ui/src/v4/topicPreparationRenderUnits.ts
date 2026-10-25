import type { BotTopicPreparation as Preparation } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function pendingTopicPreparations(
  items: readonly Preparation[],
  rows: readonly ConversationRow[],
) {
  const acceptedIds = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.botGroupSource) continue;
    acceptedIds.add(row.botGroupSource.messageId);
    for (const message of row.botGroupSource.messages ?? []) acceptedIds.add(message.messageId);
  }
  // 失败材料不再投影为临时消息，连同来源一起移除，避免残留空白轮次或错误块。
  return items.filter((item) => item.status !== "failed" && !acceptedIds.has(item.messageId));
}

/**
 * withTopicPreparationMessages 的单槽 memo（stableRenderUnitsEnabled 开关）：
 * pending 非空时每次包装都会 {...last} 新建 unit 与新数组，会抵消
 * TurnRenderUnitCache 的数组引用复用（下游 useMemo 每秒重算、TurnGroup memo
 * 失效）。相同 units 引用 + 相同 pending 条目引用时直接复用上次结果。
 */
export interface TopicPreparationMemoSlot {
  units?: ConversationTurnRenderUnit[];
  pending?: readonly Preparation[];
  result?: ConversationTurnRenderUnit[];
}

function samePendingReferences(
  left: readonly Preparation[] | undefined,
  right: readonly Preparation[],
): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

/** 准备消息进入现有轮次的消息流及测高/滚动链路；不伪造 CLI accepted row。 */
export function withTopicPreparationMessages(
  units: ConversationTurnRenderUnit[],
  rows: readonly ConversationRow[],
  items: readonly Preparation[],
  memoSlot?: TopicPreparationMemoSlot,
): ConversationTurnRenderUnit[] {
  const pending = pendingTopicPreparations(items, rows);
  if (!pending.length) {
    // 空态也缓存：空↔非空切换同样保持引用语义。
    if (memoSlot) {
      memoSlot.units = units;
      memoSlot.pending = pending;
      memoSlot.result = units;
    }
    return units;
  }
  if (
    memoSlot &&
    memoSlot.result !== undefined &&
    memoSlot.units === units &&
    samePendingReferences(memoSlot.pending, pending)
  ) {
    return memoSlot.result;
  }
  const last = units.at(-1);
  const wrapped = last
    ? [...units.slice(0, -1), { ...last, topicPreparations: pending }]
    : [
        // 尚无 CLI 消息时只创建本地展示单元，不产生任务、轮次或可编辑的假消息。
        {
          key: "topic-preparation",
          turnId: "topic-preparation",
          topicPreparations: pending,
          visibleUserInputs: [],
          assistantWorkRows: [],
          assistantHistoryRows: [],
          assistantFollowingRows: [],
          assistantTailRows: [],
          browserTurnEndRows: [],
          hookInvocations: [],
          assistantTextRows: [],
          leadingBoundaryRows: [],
          flowItems: [],
          renderRows: [],
          isLastTurn: true,
          isRunning: false,
          assistantHistoryDefaultOpen: false,
          timelineOnly: true,
        },
      ];
  if (memoSlot) {
    memoSlot.units = units;
    memoSlot.pending = pending;
    memoSlot.result = wrapped;
  }
  return wrapped;
}
