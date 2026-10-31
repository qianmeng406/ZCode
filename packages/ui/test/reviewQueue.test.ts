import { describe, expect, it } from "vitest";
import type { ZCodeOracleReviewRecord } from "@zcode/shared";
import {
  buildQueueAskPrompt,
  buildQueueFixPrompt,
  buildReviewQueue,
  openReviewQueueItems,
} from "@/v4/oracleReview/reviewQueue.js";
import {
  addReviewedQueueKeys,
  clearReviewedQueueKeys,
  readReviewedQueueKeys,
  reviewedQueueStorageKey,
} from "@/v4/oracleReview/oracleReviewQueueState.js";

function record(overrides: Partial<ZCodeOracleReviewRecord> = {}): ZCodeOracleReviewRecord {
  return {
    reviewId: "review-1",
    sessionId: "session-1",
    depth: "standard",
    mode: "manual",
    target: { rowId: 1, entityId: "turn-1" },
    verdict: "warn",
    summary: "审查通过但有两处提醒",
    findings: "- [中] src/a.ts:12 — 缺少校验\n- [低] 命名不一致",
    modelLabel: "zai/glm-4.6",
    createdAt: 1,
    completedAt: 100,
    ...overrides,
  };
}

describe("review queue", () => {
  it("parses findings into severity-sorted open items", () => {
    const items = buildReviewQueue([
      record({
        findings: "- [低] b.ts:3 — 命名\n- [高] a.ts:9 — 空指针\n- [中] c.ts:1 — 校验",
      }),
    ]);
    expect(items.map((item) => item.severity)).toEqual(["error", "warning", "note"]);
    expect(items[0]).toMatchObject({ file: "a.ts", line: 9, reviewId: "review-1" });
    expect(items[0]?.key).toBe("loc|a.ts|9");
  });

  it("skips pass records and synthesizes an item when findings are empty", () => {
    const items = buildReviewQueue([
      record({ reviewId: "pass-1", verdict: "pass", findings: "" }),
      record({ reviewId: "fail-1", verdict: "fail", findings: "", summary: "构建会失败" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      reviewId: "fail-1",
      severity: "error",
      message: "构建会失败",
      synthesized: true,
    });
  });

  it("dedupes the same finding across re-reviews and keeps the newest", () => {
    const items = buildReviewQueue([
      record({ reviewId: "review-1", completedAt: 100 }),
      record({ reviewId: "review-2", completedAt: 200 }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.completedAt)).toEqual([200, 200]);
  });

  it("orders located findings before unlocated ones at the same severity", () => {
    const items = buildReviewQueue([
      record({ reviewId: "r1", findings: "- [中] 没有位置" }),
      record({ reviewId: "r2", findings: "- [中] a.ts:1 — 有位置" }),
    ]);
    expect(items.map((item) => item.reviewId)).toEqual(["r2", "r1"]);
  });

  it("filters locally reviewed keys", () => {
    const items = buildReviewQueue([record()]);
    expect(openReviewQueueItems(items, new Set(items.map((item) => item.key)))).toHaveLength(0);
  });

  it("builds prompts that keep the location and ask for verification", () => {
    const [item] = buildReviewQueue([record()]);
    expect(buildQueueFixPrompt(item!)).toContain("src/a.ts:12");
    expect(buildQueueFixPrompt(item!)).toContain("核实");
    expect(buildQueueAskPrompt(item!)).toContain("src/a.ts:12");
  });
});

describe("review queue reviewed state", () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  it("persists reviewed keys per workspace/session and clears them", () => {
    const storage = memoryStorage();
    expect(readReviewedQueueKeys("ws", "s1", storage).size).toBe(0);
    addReviewedQueueKeys("ws", "s1", ["a", "b"], storage);
    expect([...readReviewedQueueKeys("ws", "s1", storage)]).toEqual(["a", "b"]);
    expect(readReviewedQueueKeys("ws", "s2", storage).size).toBe(0);
    expect(storage.getItem(reviewedQueueStorageKey("ws", "s1"))).toContain("schemaVersion");
    clearReviewedQueueKeys("ws", "s1", storage);
    expect(readReviewedQueueKeys("ws", "s1", storage).size).toBe(0);
  });

  it("ignores malformed payloads", () => {
    const storage = memoryStorage();
    storage.setItem(reviewedQueueStorageKey("ws", "s1"), "{not json");
    expect(readReviewedQueueKeys("ws", "s1", storage).size).toBe(0);
  });
});
