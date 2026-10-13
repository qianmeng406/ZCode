import assert from "node:assert/strict";
import test from "node:test";
import {
  executionPermissionModeSchema,
  resolveContextProfile,
  resolveExecutionState,
} from "../src/execution-state.js";

test("resolveExecutionState accepts a canonical mode and resets planEnabled", () => {
  const state = resolveExecutionState(
    { mode: "minimal" },
    { mode: "research", planEnabled: true },
  );
  assert.deepEqual(state, { mode: "minimal", planEnabled: false, contextProfile: "minimal" });
});

test("resolveExecutionState falls back to current mode on unknown input", () => {
  const state = resolveExecutionState(
    { mode: "pair-programming" },
    { mode: "minimal", planEnabled: false },
  );
  assert.equal(state.mode, "minimal");
});

test("resolveExecutionState still maps legacy plan to planEnabled", () => {
  const state = resolveExecutionState({ mode: "plan" }, { mode: "minimal", planEnabled: false });
  assert.equal(state.mode, "minimal");
  assert.equal(state.planEnabled, true);
});

test("executionPermissionModeSchema accepts minimal and zcodeUpdate", () => {
  assert.equal(executionPermissionModeSchema.safeParse("minimal").success, true);
  assert.equal(executionPermissionModeSchema.safeParse("zcodeUpdate").success, true);
});

test("executionPermissionModeSchema rejects the removed workflow mode", () => {
  // 项目开发模式已移除：遗留的 workflow 值不再合法，由读取边界回退到 build。
  assert.equal(executionPermissionModeSchema.safeParse("workflow").success, false);
});

test("resolveExecutionState falls back to the current mode for the removed workflow value", () => {
  // 默认 current 是 build：遗留 workflow 不得让状态解析抛错或停在 workflow。
  assert.deepEqual(resolveExecutionState({ mode: "workflow" }), {
    mode: "build",
    planEnabled: false,
    contextProfile: "standard",
  });
});

test("resolveExecutionState keeps the two custom modes", () => {
  const minimal = resolveExecutionState({ mode: "minimal" }, { mode: "build", planEnabled: false });
  assert.deepEqual(minimal, { mode: "minimal", planEnabled: false, contextProfile: "minimal" });

  const update = resolveExecutionState(
    { mode: "zcodeUpdate" },
    { mode: "build", planEnabled: false },
  );
  assert.deepEqual(update, { mode: "zcodeUpdate", planEnabled: false, contextProfile: "standard" });
});

test("legacy mode=minimal resolves a minimal context profile", () => {
  // 旧极简是「极简上下文 + 自动权限」组合：读取补出档位，行为与历史一致。
  assert.equal(resolveContextProfile({ mode: "minimal" }), "minimal");
  assert.equal(resolveContextProfile({ mode: "build" }), "standard");
  assert.equal(resolveContextProfile({ mode: "minimal", contextProfile: "standard" }), "standard");
});

test("permission changes preserve the context profile", () => {
  const current = { mode: "build", planEnabled: false, contextProfile: "minimal" as const };
  const toYolo = resolveExecutionState({ mode: "yolo" }, current);
  assert.equal(toYolo.mode, "yolo");
  assert.equal(toYolo.contextProfile, "minimal", "改权限不改上下文档位");

  const planOn = resolveExecutionState({ planEnabled: true }, current);
  assert.equal(planOn.contextProfile, "minimal", "切 Plan 不改上下文档位");
});

test("explicit context profile changes only the profile", () => {
  const current = { mode: "build", planEnabled: false, contextProfile: "standard" as const };
  const next = resolveExecutionState({ contextProfile: "minimal" }, current);
  assert.equal(next.mode, "build", "切档位不改权限");
  assert.equal(next.planEnabled, false);
  assert.equal(next.contextProfile, "minimal");
});
