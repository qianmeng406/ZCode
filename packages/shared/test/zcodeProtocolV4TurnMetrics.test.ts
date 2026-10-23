// Composer main-turn metrics 轮指标字段（additive schema 面黄金测试）：
// turnHeaderRowSchema 的新 optional 字段必须向后兼容旧快照（缺席可 parse），
// 且拒绝负数，保证 CLI↔UI 的 wire 契约闭集演进。
import { describe, expect, it } from "vitest";
import { turnHeaderRowSchema } from "../src/zcode-protocol-v4/rows.js";

const baseRow = {
  rowId: 1,
  kind: "turnHeader",
  turnId: "turn-1",
  entityId: "entity-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 1,
  origin: "userInput",
  state: "completedSuccess",
  startedAt: 1_700_000_000_000,
} as const;

describe("zcode protocol v4 turnHeader turn metrics", () => {
  it("old snapshot without metric fields still parses (optional additive face)", () => {
    const parsed = turnHeaderRowSchema.parse(baseRow);
    expect(parsed).toMatchObject({ kind: "turnHeader" });
    expect(parsed.timeToFirstTokenMs).toBeUndefined();
    expect(parsed.generationDurationMs).toBeUndefined();
    expect(parsed.outputTokens).toBeUndefined();
  });

  it("accepts non-negative metric facts and rejects negative or fractional values", () => {
    expect(
      turnHeaderRowSchema.safeParse({
        ...baseRow,
        outputTokens: 42,
        timeToFirstTokenMs: 320,
        generationDurationMs: 2_000,
      }).success,
    ).toBe(true);
    expect(turnHeaderRowSchema.safeParse({ ...baseRow, timeToFirstTokenMs: -1 }).success).toBe(
      false,
    );
    expect(turnHeaderRowSchema.safeParse({ ...baseRow, outputTokens: -5 }).success).toBe(false);
  });

  it("accepts an optional positive turnOrdinal and rejects zero or fractional values", () => {
    const parsed = turnHeaderRowSchema.parse({ ...baseRow, turnOrdinal: 12 });
    expect(parsed.turnOrdinal).toBe(12);
    expect(turnHeaderRowSchema.parse(baseRow).turnOrdinal).toBeUndefined();
    expect(turnHeaderRowSchema.safeParse({ ...baseRow, turnOrdinal: 0 }).success).toBe(false);
    expect(turnHeaderRowSchema.safeParse({ ...baseRow, turnOrdinal: 1.5 }).success).toBe(false);
  });
});
