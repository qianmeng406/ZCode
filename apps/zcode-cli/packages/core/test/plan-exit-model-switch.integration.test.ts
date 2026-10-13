import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationMode, SessionModePort } from "@zcode/contracts";
import { exitPlanModeToolEntry } from "../src/tool/handlers/plan-mode.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../src/tool/types.js";
import { withPlanExitApprovedTurnStop } from "../src/tool/executor/turn-control.js";

/**
 * 集成测试：从「build + planEnabled 进入计划」→ 于批准窗指定执行模型 →
 * 真实 ExitPlanMode handler 退出计划 → 下一回合实际使用该模型。
 *
 * 与 plan-exit-model-switch.test.ts 的单测区别：那里直接把手工构造的 input 喂给
 * wrapper，绕过了「handler 会清除 planEnabled」这一事实。本测试用真实 handler，
 * 并严格复刻 call-runner 的时序（handler **之前**捕获 planEnabledBeforeHandler），
 * 证明整条交接链在真实状态变更下自洽——这正是此前 P1（换模被跳过）的回归防线。
 */

/** 复刻真实 session-mode-port：state = { mode, planEnabled }，exitPlanMode 清除标志。 */
function createFakeSessionModePort(initial: {
  mode: CollaborationMode;
  planEnabled: boolean;
}) {
  let state = { ...initial };
  const port: SessionModePort = {
    getMode: () => state.mode,
    getPrePlanMode: () => undefined,
    isPlanEnabled: () => state.planEnabled,
    async enterPlanMode() {
      const previous = state;
      state = { ...state, planEnabled: true };
      return {
        mode: state.mode,
        previousMode: previous.mode,
        planEnabled: state.planEnabled,
        previousPlanEnabled: previous.planEnabled,
      };
    },
    async exitPlanMode() {
      if (!state.planEnabled) {
        throw new Error("not in plan mode");
      }
      const previous = state;
      state = { ...state, planEnabled: false };
      return {
        mode: previous.mode,
        previousMode: previous.mode,
        planEnabled: state.planEnabled,
        previousPlanEnabled: true,
      };
    },
  };
  return port;
}

function handlerContext(sessionModePort: SessionModePort): ToolExecutionContext {
  return {
    toolCallId: "call-exit-plan",
    traceId: "trace-1",
    spanId: "span-1",
    abortSignal: new AbortController().signal,
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    // 只注入本测试触碰的端口；fileSystemPort 缺席让 handler 跳过计划落盘。
    sessionModePort,
    sessionId: "sess-1",
    turnId: "turn-1",
  } as unknown as ToolExecutionContext;
}

async function runExitPlanMode(
  sessionModePort: SessionModePort,
  mode: CollaborationMode,
  input: unknown,
): Promise<ToolExecutionResult> {
  // 与 call-runner 一致：在 handler 之前捕获计划状态。
  const planEnabledBeforeHandler =
    sessionModePort.isPlanEnabled?.() ?? sessionModePort.getMode() === "plan";

  const output = await exitPlanModeToolEntry.handler(input, handlerContext(sessionModePort));

  return withPlanExitApprovedTurnStop(
    {
      toolCallId: "call-exit-plan",
      toolName: "ExitPlanMode",
      success: true,
      output,
      durationMs: 1,
      startedAt: new Date(0),
      completedAt: new Date(0),
    },
    {
      mode,
      planEnabled: planEnabledBeforeHandler,
      toolName: "ExitPlanMode",
    },
  );
}

test("build + planEnabled 进入计划，指定模型批准：真实 handler 退出后仍触发换模交接", async () => {
  const port = createFakeSessionModePort({ mode: "build", planEnabled: true });
  const selection = {
    providerId: "custom-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  };

  const result = await runExitPlanMode(port, "build", {
    plan: "- step 1\n- step 2",
    executionModelSelection: selection,
  });

  // 真实 handler 已把计划状态清成 false（P1 的触发条件）。
  assert.equal(port.isPlanEnabled?.(), false);
  assert.equal(port.getMode(), "build");

  // 交接链仍然通过：停回合 + 用所选模型开启下一回合。
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
  assert.equal(result.turnControl?.stopTurnAfterResult, true);
  assert.deepEqual(result.followUpUserInput?.modelSelection, selection);
  assert.match(result.followUpUserInput?.input ?? "", /plan was approved/i);
  assert.match(result.followUpUserInput?.input ?? "", /deepseek\/deepseek-v4\.1-flash/);
});

test("yolo + planEnabled 进入计划，指定模型批准：同样触发换模交接", async () => {
  const port = createFakeSessionModePort({ mode: "yolo", planEnabled: true });
  const selection = { providerId: "p", modelId: "m" };

  const result = await runExitPlanMode(port, "yolo", {
    plan: "- step",
    executionModelSelection: selection,
  });

  assert.equal(port.isPlanEnabled?.(), false);
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
  assert.deepEqual(result.followUpUserInput?.modelSelection, selection);
});

test("批准不带执行模型：真实 handler 退出后不触发换模（同回合继续）", async () => {
  const port = createFakeSessionModePort({ mode: "build", planEnabled: true });

  const result = await runExitPlanMode(port, "build", { plan: "- step" });

  assert.equal(port.isPlanEnabled?.(), false);
  assert.equal(result.turnControl, undefined);
  assert.equal(result.followUpUserInput, undefined);
});

test("broker modify 产出的完整输入形状贯穿真实 handler 与换模交接", async () => {
  const port = createFakeSessionModePort({ mode: "build", planEnabled: true });
  const selection = {
    providerId: "custom-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  };
  // 与 interaction-broker.planApprovalResponseToBrokerResult 的 modify 输出同形：
  // 原始工具输入（plan + allowedPrompts）+ executionModelSelection。这里是上下半程的接缝——
  // bootstrap 侧测试断言「UI 应答 → 该形状」，本测试断言「该形状 → 真实换模交接」。
  const brokerModifiedInput = {
    plan: "- step 1",
    allowedPrompts: [],
    executionModelSelection: selection,
  };

  const result = await runExitPlanMode(port, "build", brokerModifiedInput);

  assert.equal(port.isPlanEnabled?.(), false);
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
  assert.equal(result.turnControl?.stopTurnAfterResult, true);
  assert.equal(result.followUpUserInput?.reasonSource, "plan_approval_feedback");
  assert.deepEqual(result.followUpUserInput?.modelSelection, selection);
  // 交接提示带上推理档，用户能核对「批准时选的档位」确实被执行回合采用。
  assert.match(
    result.followUpUserInput?.input ?? "",
    /custom-provider\/deepseek\/deepseek-v4\.1-flash \(reasoning: high\)/,
  );
});
