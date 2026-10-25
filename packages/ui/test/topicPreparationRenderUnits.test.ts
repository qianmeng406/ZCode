import { describe, expect, it } from "vitest";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import {
  withTopicPreparationMessages,
  type TopicPreparationMemoSlot,
} from "@/v4/topicPreparationRenderUnits.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
const pending = [
  { messageId: "a", senderName: "Alice", text: "hello", status: "preparing" as const },
];
describe("topic messages in conversation flow", () => {
  it("renders before any CLI row without manufacturing accepted input or a running task", () => {
    const units = withTopicPreparationMessages([], [], pending);
    expect(units).toHaveLength(1);
    expect(units[0]?.topicPreparations).toEqual(pending);
    expect(units[0]?.renderRows).toEqual([]);
    expect(units[0]?.visibleUserInputs).toEqual([]);
    expect(units[0]?.isRunning).toBe(false);
  });
  it("keeps the running tail in normal flow when preparation arrives", () => {
    const base = withTopicPreparationMessages([], [], pending)[0]!;
    const running = { ...base, key: "running", isRunning: true, topicPreparations: undefined };
    const units = withTopicPreparationMessages([running], [], pending);
    expect(units).toHaveLength(1);
    expect(units[0]?.key).toBe("running");
    expect(splitConversationTimelineLiveTail(units).liveUnit?.topicPreparations).toEqual(pending);
    expect(running.topicPreparations).toBeUndefined();
  });
  it("formal original ID replaces preparation while preserving canonical units", () => {
    const row = {
      kind: "userInput",
      botGroupSource: { messageId: "b", messages: [{ messageId: "a" }] },
    } as UserInputRow;
    const units = withTopicPreparationMessages([], [], []);
    expect(withTopicPreparationMessages(units, [row], pending)).toBe(units);
  });
  it("does not leave a blank render unit after preparation fails", () => {
    expect(
      withTopicPreparationMessages([], [], [{ ...pending[0]!, status: "failed", error: "failed" }]),
    ).toEqual([]);
  });
});

describe("TopicPreparationMemoSlot（stableRenderUnitsEnabled，默认关闭）", () => {
  const makeUnit = (key: string) =>
    ({
      key,
      turnId: key,
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
      timelineOnly: false,
    }) as Parameters<typeof withTopicPreparationMessages>[0][number];

  it("相同 units 引用 + 相同 pending 条目引用时复用上次结果数组", () => {
    const slot: TopicPreparationMemoSlot = {};
    const units = [makeUnit("t1")];
    const first = withTopicPreparationMessages(units, [], pending, slot);
    expect(first).not.toBe(units);
    expect(first.at(-1)?.topicPreparations).toEqual(pending);
    const second = withTopicPreparationMessages(units, [], pending, slot);
    expect(second).toBe(first);
  });

  it("units 引用变化或 pending 条目变化时重算", () => {
    const slot: TopicPreparationMemoSlot = {};
    const unitsA = [makeUnit("t1")];
    const first = withTopicPreparationMessages(unitsA, [], pending, slot);
    const unitsB = [makeUnit("t1"), makeUnit("t2")];
    expect(withTopicPreparationMessages(unitsB, [], pending, slot)).not.toBe(first);
    const pending2 = [{ ...pending[0]!, messageId: "z" }];
    const againUnitsB = withTopicPreparationMessages(unitsB, [], pending2, slot);
    expect(againUnitsB.at(-1)?.topicPreparations).toEqual(pending2);
    // 相同新输入再次命中。
    expect(withTopicPreparationMessages(unitsB, [], pending2, slot)).toBe(againUnitsB);
  });

  it("空 pending 态缓存为 units 本身，空↔非空切换保持引用语义", () => {
    const slot: TopicPreparationMemoSlot = {};
    const units = [makeUnit("t1")];
    expect(withTopicPreparationMessages(units, [], [], slot)).toBe(units);
    expect(withTopicPreparationMessages(units, [], [], slot)).toBe(units);
    const wrapped = withTopicPreparationMessages(units, [], pending, slot);
    expect(wrapped).not.toBe(units);
    // pending 清空（原消息被接受）后回到 units 引用。
    expect(withTopicPreparationMessages(units, [], [], slot)).toBe(units);
  });

  it("不传 slot 时行为与原实现一致（每次包装新数组）", () => {
    const units = [makeUnit("t1")];
    const first = withTopicPreparationMessages(units, [], pending);
    const second = withTopicPreparationMessages(units, [], pending);
    expect(second).not.toBe(first);
    expect(second.at(-1)?.topicPreparations).toEqual(pending);
  });
});
