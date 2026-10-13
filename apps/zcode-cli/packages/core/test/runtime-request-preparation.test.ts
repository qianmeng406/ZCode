import assert from "node:assert/strict";
import test from "node:test";
import type { EnvInfo, Model } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/builder.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { installRuntimeExecutionState } from "../src/runtime/execution-state.js";
import {
  prepareTurnRequestProjection,
  rebuildContextPrefix,
} from "../src/runtime/methods/context-refresh.js";
import { drainInlineGuideForNextRequest } from "../src/runtime/methods/turn-guide-drain.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 请求准备边界契约：mode/plan/档位或模型变化后，turn-local 请求条目必须重投影为
 * 新档位的 context prefix（并保留 conversation 后缀）。这是「Submission 先构建上下文
 * 后应用模式」与「guide 仅换模型才重建」两个实测缺陷的回归。
 */

const ENV_INFO: EnvInfo = {
  cwd: "C:/tmp/ws",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26100",
  nodeVersion: "24.11.0",
  isGitRepository: true,
};

function fakeModel(modelId = "m1"): Model {
  return {
    providerId: "fake",
    modelId,
    displayName: "Fake",
    properties: {},
    optionSpecs: { reasoningLevel: { values: [] } },
    options: {},
  } as unknown as Model;
}

interface Harness {
  runtime: AgentRuntimeInternal;
  makeState: () => {
    activeTurn?: unknown;
    events: unknown[];
    turnTraceContext: { traceId: string; sessionId: string };
    turnRequestState: { entries: readonly unknown[]; outputTokenContinuationCount: number };
    appliedProjectionRevision: number;
    appliedProjectionModelKey?: string;
    model: Model;
    currentUserMessageId?: string;
    repeatedToolCallSignature?: string;
    repeatedToolCallStreakCount: number;
    modelSelectionScope?: "execution";
    drainedSteerForNextRequest?: unknown;
  };
  state: ReturnType<Harness["makeState"]>;
}

function makeHarness(mode: "build" | "minimal" = "build"): Harness {
  const messageHistory = new MessageHistoryImpl();
  const runtime: Record<string, unknown> = {
    sessionId: "sess_prep",
    config: { mode, planEnabled: false, currentDate: "2026-10-10" },
    sessionPersisted: false,
    needsPlanModeExitReminder: false,
    contextProjectionRevision: 0,
    contextPrefixRevision: -1,
    contextInitialized: true,
    invalidateToolCache() {},
    messageHistory,
    contextSourceSnapshot: {
      workingDirectory: "C:/tmp/ws",
      envInfo: ENV_INFO,
      currentDate: "2026-10-10",
    },
    // 与真实 createContextBuilderFromSnapshot 同一条映射：promptProfile 跟随 mode。
    createContextBuilderFromSnapshot(
      _snapshot: unknown,
      _memoryRoot: string | undefined,
      options: { model?: Model } = {},
    ) {
      return createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        currentDate: "2026-10-10",
        model: options.model,
        promptProfile: (runtime.config as { mode: string }).mode === "minimal" ? "minimal" : undefined,
      });
    },
    rootTraceContext: { traceId: "trace", sessionId: "sess_prep" },
    createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
    appendEvent: async () => {},
    readSessionTargetForContext: async () => null,
    getSessionModelSelection: () => undefined,
    setSessionModelSelection: () => {},
    emitModelSelected: async () => {},
    hasInlineGuidePendingInput: () => true,
    drainPendingInput: async () => ({
      pendingInputIds: ["guide-1"],
      intent: { mode: "minimal" },
      runtimeEntries: [],
    }),
  };
  const r = runtime as unknown as AgentRuntimeInternal;
  // 首个 prefix 与真实 ensureContextInitialized 一样安装一次；builder 先就位，
  // rebuildContextPrefix 才会走真实的重投影分支。
  runtime.contextBuilder = (
    runtime.createContextBuilderFromSnapshot as (
      snapshot: unknown,
      memoryRoot?: string,
      options?: { model?: Model },
    ) => unknown
  )(runtime.contextSourceSnapshot, undefined, { model: fakeModel() });
  rebuildContextPrefix(r, { model: fakeModel() });
  const makeState = () => ({
    activeTurn: {},
    events: [],
    turnTraceContext: { traceId: "trace", sessionId: "sess_prep" },
    turnRequestState: {
      entries: messageHistory.borrowReadOnlyRuntimeEntries(),
      outputTokenContinuationCount: 0,
    },
    appliedProjectionRevision: runtime.contextProjectionRevision as number,
    appliedProjectionModelKey: "fake/m1/",
    model: fakeModel(),
    repeatedToolCallStreakCount: 0,
  });
  return { runtime: r, makeState, state: makeState() };
}

function sectionSources(runtime: AgentRuntimeInternal): string[] {
  return (runtime.latestContextBuildResult?.sections ?? []).map((section) => section.source);
}

test("mode change reprojects the turn-local prefix to the new profile", () => {
  const harness = makeHarness("build");
  const { runtime, state } = harness;
  assert.ok(sectionSources(runtime).includes("identity"));

  // conversation 后缀：切换后必须原样保留。
  (state.turnRequestState.entries as unknown[]).push({
    kind: "message",
    message: { role: "user", content: "SUFFIX_MARKER" },
  });

  installRuntimeExecutionState(runtime, { mode: "minimal", planEnabled: false });
  prepareTurnRequestProjection(runtime, state as never, state.model);

  assert.deepEqual(sectionSources(runtime), [
    "cli_prefix",
    "env_info",
    "minimal_guardrails",
  ]);
  const entries = state.turnRequestState.entries as { message?: { content?: string } }[];
  assert.ok(
    entries.some((entry) => entry.message?.content === "SUFFIX_MARKER"),
    "conversation 后缀不能被 prefix 重建吞掉",
  );
});

test("unchanged projection is a no-op on the entries array", () => {
  const { runtime, state } = makeHarness("build");
  const before = state.turnRequestState.entries;
  prepareTurnRequestProjection(runtime, state as never, state.model);
  assert.equal(state.turnRequestState.entries, before, "无变化不重建");
  assert.equal(runtime.contextPrefixRevision, runtime.contextProjectionRevision);
});

test("model identity change triggers a reprojection", () => {
  const { runtime, state } = makeHarness("build");
  const before = state.turnRequestState.entries;
  const nextModel = fakeModel("m2");
  prepareTurnRequestProjection(runtime, state as never, nextModel);
  assert.notEqual(state.turnRequestState.entries, before);
  assert.equal(state.appliedProjectionModelKey, "fake/m2/");
});

test("mode-only guide updates the next request projection", async () => {
  const { runtime, state } = makeHarness("build");
  const ok = await drainInlineGuideForNextRequest(runtime, state as never);
  assert.equal(ok, true);
  assert.equal(runtime.config.mode, "minimal");
  assert.deepEqual(sectionSources(runtime), [
    "cli_prefix",
    "env_info",
    "minimal_guardrails",
  ]);
  assert.equal(state.model.modelId, "m1", "仅切档位不换模型");
  assert.equal(state.appliedProjectionRevision, runtime.contextProjectionRevision);
});
