import assert from "node:assert/strict";
import test from "node:test";
import { resumeFromStore } from "../src/runtime/methods/resume.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 冷恢复顺序契约：持久化执行状态必须在 context / MCP 初始化之前安装。
 * 以前先按 invocation 默认 build 初始化、再回填持久化档位，恢复成极简的会话会带着
 * build 的上下文与工具缓存，MCP 也已按 build 启动（实测问题的回归）。
 */

function makeRuntime(options: {
  invocationMode: "build" | "minimal";
  savedState?: { mode: "build" | "minimal"; planEnabled: boolean };
}) {
  let modeAtContextInit: string | undefined;
  const runtime: Record<string, unknown> = {
    sessionId: "sess_resume",
    config: { mode: options.invocationMode, planEnabled: false },
    workingDirectory: "C:/tmp/ws",
    workspaceRoot: "C:/tmp/ws",
    branchGeneration: 0,
    runtimeTaskRegistry: { setActiveBranchGeneration: () => {} },
    readFileState: new Map(),
    contextProjectionRevision: 0,
    contextPrefixRevision: -1,
    contextInitialized: false,
    contextBuilder: null,
    needsPlanModeExitReminder: false,
    sessionPersisted: false,
    invalidateToolCache() {},
    rootTraceContext: { traceId: "trace", sessionId: "sess_resume" },
    sessionStore: {
      getSession: async () => ({
        id: "sess_resume",
        directory: "C:/tmp/ws",
        taskType: "main",
        title: "resume",
        time: { created: Date.now(), updated: Date.now() },
      }),
      messages: async () => [],
      sessionEntries: async () => (options.savedState ? [{ data: options.savedState }] : []),
      updateSession: async () => undefined,
      saveSession: async () => undefined,
    },
    eventStore: { getEvents: async () => [] },
    // 记录 context 初始化那一刻看到的 mode：这是本次回归的直接断言点。
    ensureContextInitialized: async () => {
      modeAtContextInit = (runtime.config as { mode: string }).mode;
      runtime.contextInitialized = true;
    },
    recoverInterruptedCompactTimelines: async () => 0,
    discardPersistedPendingSteerInputs: async () => {},
    readSessionTodosForContext: async () => [],
    readSessionTargetForContext: async () => null,
    injectTargetStateIntoMessageHistory: () => {},
    createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
    appendEvent: async () => {},
    runSessionStartHooks: async () => ({ additionalContexts: [] }),
    injectHookAdditionalContextIntoMessageHistory: () => {},
  };
  return {
    runtime: runtime as unknown as AgentRuntimeInternal,
    modeAtContextInit: () => modeAtContextInit,
    finalMode: () => (runtime.config as { mode: string }).mode,
  };
}

test("resume installs the persisted minimal state before context initialization", async () => {
  const harness = makeRuntime({
    invocationMode: "build",
    savedState: { mode: "minimal", planEnabled: false },
  });
  await resumeFromStore.call(harness.runtime);
  assert.equal(harness.modeAtContextInit(), "minimal", "context 初始化必须看到恢复后的档位");
  assert.equal(harness.finalMode(), "minimal");
});

test("resume keeps invocation semantics for a build session restored from minimal startup", async () => {
  const harness = makeRuntime({
    invocationMode: "minimal",
    savedState: { mode: "build", planEnabled: false },
  });
  await resumeFromStore.call(harness.runtime);
  assert.equal(harness.modeAtContextInit(), "build");
  assert.equal(harness.finalMode(), "build");
});

test("explicit mode override wins over the persisted state", async () => {
  const harness = makeRuntime({
    invocationMode: "build",
    savedState: { mode: "minimal", planEnabled: false },
  });
  await resumeFromStore.call(harness.runtime, { modeOverride: "build" });
  assert.equal(harness.modeAtContextInit(), "build");
  assert.equal(harness.finalMode(), "build");
});
