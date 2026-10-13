import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRuntimeExecutionState,
  installRuntimeExecutionState,
} from "../src/runtime/execution-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 执行状态安装的派生失效契约：
 * mode/plan 变化必须失效工具缓存并推进 contextProjectionRevision，否则切换档位后
 * 请求仍带旧档位的工具表与 system 段（极简 ↔ 标准切换实测问题的回归）。
 */

interface FakeRuntime {
  runtime: AgentRuntimeInternal;
  saved: unknown[];
  events: { type: unknown; payload: unknown }[];
  cacheInvalidations: () => number;
}

function makeRuntime(mode: "build" | "minimal" = "build"): FakeRuntime {
  const saved: unknown[] = [];
  const events: { type: unknown; payload: unknown }[] = [];
  let cacheInvalidations = 0;
  const runtime = {
    sessionId: "sess_state",
    config: { mode, planEnabled: false },
    sessionPersisted: true,
    sessionStore: {
      saveSessionEntry: async (entry: unknown) => {
        saved.push(entry);
        return entry;
      },
    },
    needsPlanModeExitReminder: false,
    contextProjectionRevision: 0,
    invalidateToolCache() {
      cacheInvalidations += 1;
    },
    rootTraceContext: { traceId: "trace", sessionId: "sess_state" },
    createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
    appendEvent: async (event: { type: unknown; payload: unknown }) => {
      events.push(event);
    },
    readSessionTargetForContext: async () => null,
  };
  return {
    runtime: runtime as unknown as AgentRuntimeInternal,
    saved,
    events,
    cacheInvalidations: () => cacheInvalidations,
  };
}

test("installRuntimeExecutionState invalidates tool cache and advances projection revision", () => {
  const { runtime, cacheInvalidations } = makeRuntime("build");
  installRuntimeExecutionState(runtime, { mode: "minimal", planEnabled: false });
  assert.equal(runtime.config.mode, "minimal");
  assert.equal(cacheInvalidations(), 1, "mode 变化必须失效工具缓存");
  assert.equal(runtime.contextProjectionRevision, 1);
});

test("installRuntimeExecutionState is a no-op for identical state", () => {
  const { runtime, cacheInvalidations } = makeRuntime("build");
  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: false });
  assert.equal(cacheInvalidations(), 0);
  assert.equal(runtime.contextProjectionRevision, 0);
  assert.equal(runtime.needsPlanModeExitReminder, false);
});

test("plan toggle sets the exit reminder and invalidates derived state", () => {
  const { runtime, cacheInvalidations } = makeRuntime("build");
  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: true });
  assert.equal(runtime.needsPlanModeExitReminder, false, "进入 Plan 不发退出提醒");
  assert.equal(cacheInvalidations(), 1);
  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: false });
  assert.equal(runtime.needsPlanModeExitReminder, true, "退出 Plan 需要退出提醒");
});

test("applyRuntimeExecutionState persists before installing and publishes the event", async () => {
  const { runtime, saved, events, cacheInvalidations } = makeRuntime("build");
  const next = await applyRuntimeExecutionState(
    runtime,
    { mode: "minimal" },
    { source: "command" },
  );
  assert.equal(next.mode, "minimal");
  assert.equal(saved.length, 1, "先持久化");
  assert.equal(cacheInvalidations(), 1, "再安装派生状态");
  assert.equal(events.length, 1, "最后发布事件");
  assert.equal(runtime.contextProjectionRevision, 1);
});

test("applyRuntimeExecutionState leaves memory untouched when persistence fails", async () => {
  const { runtime, events } = makeRuntime("build");
  (runtime as unknown as { sessionStore: { saveSessionEntry: () => Promise<never> } }).sessionStore =
    {
      saveSessionEntry: async () => {
        throw new Error("disk full");
      },
    };
  await assert.rejects(
    applyRuntimeExecutionState(runtime, { mode: "minimal" }, { source: "command" }),
    /disk full/,
  );
  assert.equal(runtime.config.mode, "build", "保存失败不改内存");
  assert.equal(runtime.contextProjectionRevision, 0, "保存失败不推进派生版本");
  assert.equal(events.length, 0, "保存失败不发布成功事件");
});

test("full-access style install keeps minimal -> yolo projection coherent", () => {
  const { runtime, cacheInvalidations } = makeRuntime("minimal");
  installRuntimeExecutionState(runtime, { mode: "yolo", planEnabled: false });
  assert.equal(runtime.config.mode, "yolo");
  assert.equal(cacheInvalidations(), 1);
  assert.equal(runtime.contextProjectionRevision, 1);
});
