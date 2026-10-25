// idleTickScanReductionEnabled 的两个快路径与原全量扫描的 parity 契约：
// 1. highspeed 到期候选：候选推进结果与逐行扫描在任意 nowMs 下一致；
// 2. find 空查询计数：countConversationFindTargets 与 buildConversationFindIndex
//    的 loadedRowCount 逐字节相等（代码注释投影只改写文本不减行数）。
import { describe, expect, it } from "vitest";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import {
  collectHighspeedExpiryCandidates,
  resolveNextHighspeedExpiryFromCandidates,
} from "../src/highspeed/highspeedExpiryCandidates.js";
import { resolveNextHighspeedExpiryMs } from "../src/highspeed/highspeedConversationRows.js";
import {
  buildConversationFindIndex,
  countConversationFindTargets,
} from "../src/v4/conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "../src/v4/conversationTurnRenderUnits.js";

const highspeedRow = (rowId: number, expiresAt: number): UserInputRow =>
  ({
    kind: "userInput",
    rowId,
    createdAtSeq: rowId,
    text: `input-${rowId}`,
    highspeed: { expiresAt },
  }) as unknown as UserInputRow;

const plainRow = (rowId: number): UserInputRow =>
  ({
    kind: "userInput",
    rowId,
    createdAtSeq: rowId,
    text: `x-${rowId}`,
  }) as unknown as UserInputRow;

const otherRow = (rowId: number): ConversationRow =>
  ({
    kind: "assistantText",
    rowId,
    createdAtSeq: rowId,
    text: `a-${rowId}`,
  }) as unknown as ConversationRow;

describe("highspeed 到期候选（idleTickScanReduction）", () => {
  it("候选推进与逐行扫描在任意 nowMs 下结果一致", () => {
    const rows: ConversationRow[] = [
      plainRow(1),
      highspeedRow(2, 5_000),
      otherRow(3),
      highspeedRow(4, 1_000),
      highspeedRow(5, 9_000),
      highspeedRow(6, 5_000),
    ];
    const candidates = collectHighspeedExpiryCandidates(rows);
    expect(candidates).toEqual([1_000, 5_000, 5_000, 9_000]);
    for (const nowMs of [0, 999, 1_000, 1_001, 5_000, 5_001, 8_999, 9_000, 9_001, 100_000]) {
      expect(resolveNextHighspeedExpiryFromCandidates(candidates, nowMs)).toBe(
        resolveNextHighspeedExpiryMs(rows, nowMs),
      );
    }
  });

  it("无 highspeed 卡时候选为空、推进返回 undefined", () => {
    const rows: ConversationRow[] = [plainRow(1), otherRow(2)];
    const candidates = collectHighspeedExpiryCandidates(rows);
    expect(candidates).toEqual([]);
    expect(resolveNextHighspeedExpiryFromCandidates(candidates, 0)).toBeUndefined();
    expect(resolveNextHighspeedExpiryMs(rows, 0)).toBeUndefined();
  });
});

describe("find 空查询计数（idleTickScanReduction）", () => {
  const unit = (visibleUserInputs: number, assistantTextRows: number): ConversationTurnRenderUnit =>
    ({
      visibleUserInputs: Array.from({ length: visibleUserInputs }, (_, i) => plainRow(i + 1)),
      assistantTextRows: Array.from({ length: assistantTextRows }, (_, i) => otherRow(i + 100)),
    }) as unknown as ConversationTurnRenderUnit;

  it("计数与 buildConversationFindIndex 的 loadedRowCount 相等（投影开关两态）", () => {
    const units = [unit(2, 3), unit(0, 1), unit(5, 0), unit(1, 1)];
    for (const projectAssistantCodeComments of [false, true]) {
      expect(countConversationFindTargets(units)).toBe(
        buildConversationFindIndex(units, "", { projectAssistantCodeComments }).loadedRowCount,
      );
    }
  });

  it("空 units 计数为 0", () => {
    expect(countConversationFindTargets([])).toBe(0);
    expect(buildConversationFindIndex([], "").loadedRowCount).toBe(0);
  });
});
