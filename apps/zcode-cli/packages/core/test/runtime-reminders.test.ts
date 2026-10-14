import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  buildRuntimeModeReminder,
  buildRuntimeModeReminderBody,
} from "../src/runtime/helpers/runtime-reminders.js";

/**
 * 最小历史条目构造。buildRuntimeModeReminderBody 只读 message.role 与
 * metadata.source（real_user 计人类轮、runtime_mode 计 reminder），这里只填这两面，
 * 其余字段用 as unknown as 收窄——比在测试里铺满整个 RuntimeMessageEntry 联合诚实。
 */
function humanTurn(): RuntimeMessageEntry {
  return {
    message: { role: "user", content: "继续" },
    metadata: { source: "real_user" },
  } as unknown as RuntimeMessageEntry;
}

function modeReminder(
  identity: "plan" | "research" = "research",
  kind: "full" | "sparse" = "full",
): RuntimeMessageEntry {
  return {
    kind: "attachment",
    message: { role: "user", content: "<system-reminder>…</system-reminder>" },
    metadata: { source: "runtime_mode", runtimeMode: { identity, kind } },
  } as unknown as RuntimeMessageEntry;
}

test("research and plan modes each emit their own reminder", () => {
  const research = buildRuntimeModeReminderBody([], "research");
  assert.ok(research!.includes("# 资料查询模式"));
  const plan = buildRuntimeModeReminderBody([], "plan", true);
  assert.ok(plan!.includes("Plan mode is active"));
  assert.equal(buildRuntimeModeReminderBody([], "build"), null);
});

test("research mode throttles and then goes sparse", () => {
  assert.equal(
    buildRuntimeModeReminderBody([modeReminder(), humanTurn(), humanTurn()], "research"),
    null,
  );
  const sparse = buildRuntimeModeReminderBody(
    [modeReminder(), humanTurn(), humanTurn(), humanTurn(), humanTurn(), humanTurn()],
    "research",
  );
  assert.ok(sparse);
  assert.ok(!sparse!.includes("# 资料查询模式"));
  assert.ok(sparse!.includes("资料查询模式仍处于激活状态"));
});

test("plan+research combo yields the plan reminder, not the research SOP", () => {
  const body = buildRuntimeModeReminderBody([], "research", true);
  assert.ok(body);
  assert.ok(body!.includes("Plan mode is active"));
  assert.ok(!body!.includes("# 资料查询模式"));
});

test("minimal mode deliberately emits no reminder of its own", () => {
  // 极简模式的定义就是不发注入；给它加模式 reminder 会自相矛盾，这条断言把该决定钉住。
  assert.equal(buildRuntimeModeReminderBody([], "minimal"), null);
  // 但 plan 组合是例外且必须保留：勾了计划就有只读约束，不给指引会让模型按默认档位
  // 行事、每条写操作被拒。这里断言它拿到的是 plan 指引而不是任何自定义 SOP。
  const withPlan = buildRuntimeModeReminderBody([], "minimal", true);
  assert.ok(withPlan);
  assert.ok(withPlan!.includes("Plan mode is active"));
  assert.ok(!withPlan!.includes("# 资料查询模式"));
});

test("cross-mode switch emits the target SOP instead of inheriting the old throttle", () => {
  // 实测缺陷：plan 提醒后切资料查询，旧节流把进入全文压掉、甚至直接给引用
  // 「全文见前文」的简版——而前文根本没有目标 SOP。
  const body = buildRuntimeModeReminderBody([modeReminder("plan"), humanTurn()], "research");
  assert.ok(body);
  assert.ok(body!.includes("# 资料查询模式"));
});

test("re-entry always gets the full SOP (pendingFull bypasses same-activation throttle)", () => {
  const entries = [modeReminder("research", "sparse"), humanTurn(), humanTurn()];
  assert.equal(buildRuntimeModeReminderBody(entries, "research"), null);
  const full = buildRuntimeModeReminder(entries, "research", false, { pendingFull: true });
  assert.ok(full);
  assert.equal(full!.kind, "full");
  assert.ok(full!.body.includes("# 资料查询模式"));
});

test("untagged legacy reminders do not throttle a fresh activation", () => {
  // 旧条目无身份标记：按未知身份处理，不能压掉本次进入的全文。
  const legacy = {
    kind: "attachment",
    message: { role: "user", content: "…" },
    metadata: { source: "runtime_mode" },
  } as unknown as RuntimeMessageEntry;
  const body = buildRuntimeModeReminderBody([legacy], "research");
  assert.ok(body);
  assert.ok(body!.includes("# 资料查询模式"));
});

test("plan wins over research identity", () => {
  const body = buildRuntimeModeReminderBody([], "research", true);
  assert.ok(body!.includes("Plan mode is active"), "research+plan 必须给 plan 指引");
  assert.ok(!body!.includes("# 资料查询模式"));
});

test("structured identity and kind are exposed for attachment tagging", () => {
  const reminder = buildRuntimeModeReminder([], "research");
  assert.deepEqual(
    { identity: reminder!.identity, kind: reminder!.kind },
    { identity: "research", kind: "full" },
  );
});
