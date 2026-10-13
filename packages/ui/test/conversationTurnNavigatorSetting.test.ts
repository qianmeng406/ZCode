// 会话回合导航开关的纯逻辑回归：
// 1) 全历史加载的需求协调（consumer/AbortSignal owner 模型）与提交裁决；
// 2) 目录 hydration 的宽度/在途资格（含 864px 边界）。
// store 偏好字段、Timeline 门控与 SessionPane 双 owner 属组件/宿主行为，
// 由 GUI 验收覆盖（见 packages/ui/specs/conversation-turn-navigator.md）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFullHistoryCommit,
  hasActiveFullHistoryOwner,
  hasShareFullHistoryOwner,
  type ConversationFullHistoryOwner,
} from "../src/v4/conversationFullHistoryJob.js";
import { shouldHydrateConversationTurnNavigatorDirectory } from "../src/v4/conversationTurnNavigatorHelpers.js";

function owner(
  consumer: "navigator" | "share",
  signal: AbortSignal,
): ConversationFullHistoryOwner {
  return { consumer, signal };
}

test("hasActiveFullHistoryOwner：任一未 abort 即活跃，全部 abort 视为无需求", () => {
  const a = new AbortController();
  const b = new AbortController();
  assert.equal(hasActiveFullHistoryOwner([owner("navigator", a.signal)]), true);
  assert.equal(
    hasActiveFullHistoryOwner([owner("navigator", a.signal), owner("share", b.signal)]),
    true,
  );
  b.abort();
  assert.equal(
    hasActiveFullHistoryOwner([owner("navigator", a.signal), owner("share", b.signal)]),
    true,
  );
  a.abort();
  assert.equal(
    hasActiveFullHistoryOwner([owner("navigator", a.signal), owner("share", b.signal)]),
    false,
  );
  assert.equal(hasActiveFullHistoryOwner([]), false);
});

test("hasShareFullHistoryOwner：仅 share consumer 命中", () => {
  const a = new AbortController();
  assert.equal(hasShareFullHistoryOwner([owner("navigator", a.signal)]), false);
  assert.equal(
    hasShareFullHistoryOwner([owner("navigator", a.signal), owner("navigator", a.signal)]),
    false,
  );
  assert.equal(
    hasShareFullHistoryOwner([owner("navigator", a.signal), owner("share", a.signal)]),
    true,
  );
});

test("decideFullHistoryCommit：≥2 条 query 提交全部并返回 hydrated", () => {
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 2,
      preserveIncompleteLeadingTurn: false,
      hasShareOwner: false,
    }),
    { commit: true, outcome: "hydrated" },
  );
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 50,
      preserveIncompleteLeadingTurn: true,
      hasShareOwner: false,
    }),
    { commit: true, outcome: "hydrated" },
  );
});

test("decideFullHistoryCommit：share owner 在途时即使 <2 条 query 也必须完整提交", () => {
  // 分享需要完整可选数据，不能被导航「不足两条不提交」的优化吞掉。
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 1,
      preserveIncompleteLeadingTurn: false,
      hasShareOwner: true,
    }),
    { commit: true, outcome: "hydrated" },
  );
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 0,
      preserveIncompleteLeadingTurn: false,
      hasShareOwner: true,
    }),
    { commit: true, outcome: "hydrated" },
  );
});

test("decideFullHistoryCommit：单 query 导航-only 按 preserve 语义裁决", () => {
  // 需要补齐首轮 rows 时：提交（导航要在隐藏 rail 前拿到权威 rows），终态 not-enough-queries。
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 1,
      preserveIncompleteLeadingTurn: true,
      hasShareOwner: false,
    }),
    { commit: true, outcome: "not-enough-queries" },
  );
  // 无需保留首轮：不提交暂存页，避免为不会显示的 rail 常驻全历史。
  assert.deepEqual(
    decideFullHistoryCommit({
      realUserQueryCount: 1,
      preserveIncompleteLeadingTurn: false,
      hasShareOwner: false,
    }),
    { commit: false, outcome: "not-enough-queries" },
  );
});

test("目录 hydration 资格：宽度 864px 边界、在途与 handler 缺失互斥", () => {
  const base = {
    canLoadOlder: true,
    containerWidthPx: 864,
    hasLoadHandler: true,
    loadingOlder: false,
  };
  assert.equal(shouldHydrateConversationTurnNavigatorDirectory(base), true);
  // 863px：窄分屏/手机 Web 不得触发导航全历史补拉。
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, containerWidthPx: 863 }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, loadingOlder: true }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, canLoadOlder: false }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({ ...base, hasLoadHandler: false }),
    false,
  );
});
