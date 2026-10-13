import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeOracleReviewRecord } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/**
 * 审查记录「已确认」落盘回归：✕ 关闭 / 按建议处理必须写回**同一条** session entry
 * （entry id 由 sessionId+reviewId 决定），否则重启后会以「未确认」身份被恢复成卡片。
 */
const SESSION_ID = "sess-1";
const REVIEW_ID = "review-1";
const ENTRY_ID = `oracle-review:${SESSION_ID}:${REVIEW_ID}`;

function record(extra: Record<string, unknown> = {}) {
  return {
    reviewId: REVIEW_ID,
    sessionId: SESSION_ID,
    depth: "standard",
    mode: "manual",
    target: { rowId: 3, entityId: "entity-1" },
    verdict: "warn",
    summary: "有注意事项",
    findings: "- 问题 1",
    modelLabel: "new-provider-2/cn:glm-5.3",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_000,
    ...extra,
  };
}

interface FakeStore {
  saved: unknown[];
  entries: { id: string; data: unknown }[];
}

function createContext(store: FakeStore | null, invalidRecord = false) {
  const sessionStore = store
    ? {
        saveSessionEntry: async (entry: unknown) => {
          store.saved.push(entry);
        },
        sessionEntries: async () => store.entries,
      }
    : undefined;
  return {
    deps: { sessionStore },
    logger: { warn: () => undefined },
  } as unknown as ZCodeProtocolAgentServerContext;
}

function params(extra: Record<string, unknown> = {}) {
  return {
    workspace: { workspacePath: "/w", workspaceKey: "/w" },
    sessionId: SESSION_ID,
    reviewId: REVIEW_ID,
    ...extra,
  };
}

test("命中记录：写回同一条 entry 并落下 acknowledgedAt", async () => {
  const store: FakeStore = { saved: [], entries: [{ id: ENTRY_ID, data: record() }] };
  const result = await acknowledgeOracleReviewRecord(createContext(store), params());

  assert.equal(result.acknowledged, true);
  assert.equal(store.saved.length, 1);
  const entry = store.saved[0] as {
    id: string;
    type: string;
    touchSession: boolean;
    data: Record<string, unknown>;
  };
  assert.equal(entry.id, ENTRY_ID, "必须覆盖同一条 entry，不能产生重复记录");
  assert.equal(entry.type, "oracle/conversation_review");
  assert.equal(entry.touchSession, false, "后台确认不得伪装成用户操作会话");
  assert.equal(typeof entry.data.acknowledgedAt, "number");
  // 原记录字段必须保留（覆盖写不能丢内容）。
  assert.equal(entry.data.summary, "有注意事项");
  assert.equal(entry.data.findings, "- 问题 1");
});

test("显式 acknowledgedAt：按传入值落盘（重放/测试口径）", async () => {
  const store: FakeStore = { saved: [], entries: [{ id: ENTRY_ID, data: record() }] };
  await acknowledgeOracleReviewRecord(createContext(store), params({ acknowledgedAt: 42 }));
  assert.equal((store.saved[0] as { data: { acknowledgedAt: number } }).data.acknowledgedAt, 42);
});

test("未命中该 reviewId：返回 false 且不写任何记录", async () => {
  const store: FakeStore = { saved: [], entries: [{ id: "oracle-review:other:review-x", data: record() }] };
  const result = await acknowledgeOracleReviewRecord(createContext(store), params());
  assert.equal(result.acknowledged, false);
  assert.equal(store.saved.length, 0);
});

test("记录内容非法：返回 false 且不写（不覆盖成半成品）", async () => {
  const store: FakeStore = { saved: [], entries: [{ id: ENTRY_ID, data: { reviewId: "broken" } }] };
  const result = await acknowledgeOracleReviewRecord(createContext(store), params());
  assert.equal(result.acknowledged, false);
  assert.equal(store.saved.length, 0);
});

test("存储面缺席（旧宿主）：返回 false 而不是抛错", async () => {
  const result = await acknowledgeOracleReviewRecord(createContext(null), params());
  assert.equal(result.acknowledged, false);
});
