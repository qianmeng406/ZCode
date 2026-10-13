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
  identity: "plan" | "research" | "zcodeUpdate" = "zcodeUpdate",
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

test("zcodeUpdate mode emits its own staging SOP on the first reminder", () => {
  const body = buildRuntimeModeReminderBody([], "zcodeUpdate");
  assert.ok(body);
  assert.ok(body!.includes("# ZCode 更新模式"));
  assert.ok(body!.includes("zcode-update/更新台账.md"));
  assert.ok(body!.includes("zcode-update v1 stage"));
  // S1 连通性门禁：拿不到 diff 必须停下并如实报「代理未就绪」，不许凭印象编造官方改动。
  assert.ok(body!.includes("git ls-remote"));
  assert.ok(body!.includes("代理未就绪"));
  assert.ok(body!.includes("编造"));
  // 不 merge 官方分支、不 push 是这套流程的核心边界。
  assert.ok(body!.includes("不 cherry-pick、不 merge"));
  assert.ok(body!.includes("不 push"));
  // 权限语义：等同完全访问，破坏性操作仍先说明。
  assert.ok(body!.includes("权限等同「完全访问」"));
});

test("zcodeUpdate mode throttles and then goes sparse", () => {
  assert.equal(
    buildRuntimeModeReminderBody([modeReminder(), humanTurn(), humanTurn()], "zcodeUpdate"),
    null,
  );
  const sparse = buildRuntimeModeReminderBody(
    [modeReminder(), humanTurn(), humanTurn(), humanTurn(), humanTurn(), humanTurn()],
    "zcodeUpdate",
  );
  assert.ok(sparse);
  assert.ok(!sparse!.includes("# ZCode 更新模式"));
  assert.ok(sparse!.includes("ZCode 更新模式仍处于激活状态"));
});

test("plan+zcodeUpdate combo yields the plan reminder, not the full-access SOP", () => {
  const body = buildRuntimeModeReminderBody([], "zcodeUpdate", true);
  assert.ok(body);
  assert.ok(body!.includes("Plan mode is active"));
  assert.ok(!body!.includes("权限等同「完全访问」"));
});

test("minimal mode deliberately emits no reminder of its own", () => {
  // 极简模式的定义就是不发注入；给它加模式 reminder 会自相矛盾，这条断言把该决定钉住。
  assert.equal(buildRuntimeModeReminderBody([], "minimal"), null);
  // 但 plan 组合是例外且必须保留：勾了计划就有只读约束，不给指引会让模型按默认档位
  // 行事、每条写操作被拒。这里断言它拿到的是 plan 指引而不是任何自定义 SOP。
  const withPlan = buildRuntimeModeReminderBody([], "minimal", true);
  assert.ok(withPlan);
  assert.ok(withPlan!.includes("Plan mode is active"));
  assert.ok(!withPlan!.includes("# ZCode 更新模式"));
});

test("cross-mode switch emits the update SOP instead of inheriting the old throttle", () => {
  // 实测缺陷：research 提醒后切更新模式，旧节流把进入全文压掉、甚至直接给引用
  // 「全文见前文」的简版——而前文根本没有更新 SOP。
  const body = buildRuntimeModeReminderBody([modeReminder("research"), humanTurn()], "zcodeUpdate");
  assert.ok(body);
  assert.ok(body!.includes("# ZCode 更新模式"));
  assert.ok(body!.includes("zcode-update/更新台账.md"));
});

test("re-entry always gets the full SOP (pendingFull bypasses same-activation throttle)", () => {
  const entries = [modeReminder("zcodeUpdate", "sparse"), humanTurn(), humanTurn()];
  assert.equal(buildRuntimeModeReminderBody(entries, "zcodeUpdate"), null);
  const full = buildRuntimeModeReminder(entries, "zcodeUpdate", false, { pendingFull: true });
  assert.ok(full);
  assert.equal(full!.kind, "full");
  assert.ok(full!.body.includes("# ZCode 更新模式"));
});

test("untagged legacy reminders do not throttle a fresh activation", () => {
  // 旧条目无身份标记：按未知身份处理，不能压掉本次进入的全文。
  const legacy = {
    kind: "attachment",
    message: { role: "user", content: "…" },
    metadata: { source: "runtime_mode" },
  } as unknown as RuntimeMessageEntry;
  const body = buildRuntimeModeReminderBody([legacy], "zcodeUpdate");
  assert.ok(body);
  assert.ok(body!.includes("# ZCode 更新模式"));
});

test("plan wins over research and update identities", () => {
  for (const mode of ["research", "zcodeUpdate"] as const) {
    const body = buildRuntimeModeReminderBody([], mode, true);
    assert.ok(body!.includes("Plan mode is active"), `${mode}+plan 必须给 plan 指引`);
    assert.ok(!body!.includes("# ZCode 更新模式"));
    assert.ok(!body!.includes("# 资料查询模式"));
  }
});

test("structured identity and kind are exposed for attachment tagging", () => {
  const reminder = buildRuntimeModeReminder([], "zcodeUpdate");
  assert.deepEqual(
    { identity: reminder!.identity, kind: reminder!.kind },
    { identity: "zcodeUpdate", kind: "full" },
  );
});
