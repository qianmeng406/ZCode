import assert from "node:assert/strict";
import test from "node:test";
import type { UsageQuotaLimit } from "@zcode/shared";
import {
  CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT,
  resolveCodingPlanQuotaResetPromptModel,
} from "../src/lib/codingPlanQuotaResetPrompt.js";

function fiveHourLimit(overrides: Partial<UsageQuotaLimit> = {}): UsageQuotaLimit {
  // percentage 是「已用占比」（quota 接口口径），剩余 = 100 - percentage。
  return {
    type: "TOKENS_LIMIT",
    usage: 14,
    remaining: 0,
    number: 14,
    unit: 1,
    percentage: 100,
    nextResetTime: 1_790_000_000_000,
    usageDetails: [],
    ...overrides,
  };
}

const ENTRY_AVAILABLE = {
  opportunityCount: 2,
  opportunityExpiresAt: 1_780_000_000_000,
  processing: false,
  done: false,
};

test("at exactly the threshold (10% remaining = 90% used) the prompt shows", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: 90, remaining: 1.4 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.remainingPercent, 10);
  assert.equal(model.canUseResetCard, true);
  assert.equal(model.windowKey, "1790000000000");
});

test("above the threshold stays silent", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: 89, remaining: 1.54 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "quota-above-threshold");
});

test("an untouched window (100% remaining) never prompts", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: 0, remaining: 14 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, false);
});

test("fully exhausted (0% remaining) still prompts — the card is still usable", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: 100, remaining: 0 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.remainingPercent, 0);
});

test("a dismissed window stays dismissed until the window rolls", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit(),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: ["1790000000000"],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "window-dismissed");

  const nextWindow = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ nextResetTime: 1_790_086_400_000 }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: ["1790000000000"],
  });
  assert.equal(nextWindow.visible, true);
  assert.equal(nextWindow.windowKey, "1790086400000");
});

test("an already-effective reset hides the prompt even with an undismissed window", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit(),
    entry: { ...ENTRY_AVAILABLE, done: true },
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "already-reset");
});

test("low quota without any reset card still prompts, without the action", () => {
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: 95 }),
    entry: { ...ENTRY_AVAILABLE, opportunityCount: 0 },
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, true);
  assert.equal(model.canUseResetCard, false);
});

test("an unknown remaining percentage stays silent instead of pretending", () => {
  // percentage 缺失时提示文案承诺的「不足 10%」无从成立：沉默优于编造。
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit: fiveHourLimit({ percentage: undefined }),
    entry: ENTRY_AVAILABLE,
    dismissedWindowKeys: [],
  });
  assert.equal(model.visible, false);
  assert.equal(model.dismissReason, "quota-unknown");
});

test("threshold constant stays at 10 so the UI copy and the gate cannot drift", () => {
  assert.equal(CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT, 10);
});
