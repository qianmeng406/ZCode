import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExecutionResult } from "../src/tool/types.js";
import { withPlanExitApprovedTurnStop } from "../src/tool/executor/turn-control.js";

function approvedResult(output: unknown): ToolExecutionResult {
  return {
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    success: true,
    output,
    durationMs: 1,
    startedAt: new Date(0),
    completedAt: new Date(0),
  };
}

function baseInput() {
  // 运行时真实状态：wrapper 在 handler 之后运行，但 planEnabled 由 call-runner 在
  // handler **之前**捕获，因此批准路径仍读到 true（exitPlanMode 的清除尚未反映）。
  return { mode: "build" as const, planEnabled: true, toolName: "ExitPlanMode" };
}

test("批准带执行模型：停回合并经 follow-up 携带模型选择", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({
      approved: true,
      mode: "build",
      plan: "- step",
      executionModelSelection: {
        providerId: "custom-provider",
        modelId: "deepseek/deepseek-v4.1-flash",
        options: { reasoningLevel: "high" },
      },
    }),
    baseInput(),
  );
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
  assert.equal(result.turnControl?.stopTurnAfterResult, true);
  assert.equal(result.followUpUserInput?.reasonSource, "plan_approval_feedback");
  assert.deepEqual(result.followUpUserInput?.modelSelection, {
    providerId: "custom-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  });
  assert.match(result.followUpUserInput?.input ?? "", /plan was approved/);
});

test("批准不带执行模型：结果原样返回（同回合继续，现行行为）", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({ approved: true, mode: "build", plan: "- step" }),
    baseInput(),
  );
  assert.equal(result.turnControl, undefined);
  assert.equal(result.followUpUserInput, undefined);
});

test("真实运行时状态：handler 前捕获的 planEnabled=true 且 mode 为 build 时照常触发", () => {
  // 回归：exitPlanMode 执行后标志被清为 false，wrapper 若在 handler 之后读取
  // sessionModePort 会误判为非计划模式，换模与停回合都不触发。call-runner 已在
  // handler 前固定 planEnabledBeforeHandler，因此这里代表真实批准路径。
  const result = withPlanExitApprovedTurnStop(
    approvedResult({
      approved: true,
      mode: "build",
      planEnabled: false,
      previousPlanEnabled: true,
      executionModelSelection: { providerId: "p", modelId: "m" },
    }),
    baseInput(),
  );
  assert.equal(result.turnControl?.reason, "plan_exit_approved_model_switch");
});

test("handler 之后已清除且未捕获退出前状态：不进换模分支（防回归守卫）", () => {
  // 若调用方错误地在 handler 之后读取 planEnabled，会得到 false 且 mode 非 plan；
  // 该组合必须被拒绝，用例锁定"读取时点"这一前提，避免重新引入 P1。
  const output = {
    approved: true,
    previousPlanEnabled: true,
    executionModelSelection: { providerId: "p", modelId: "m" },
  };
  const result = withPlanExitApprovedTurnStop(approvedResult(output), {
    mode: "build",
    planEnabled: false,
    toolName: "ExitPlanMode",
  });
  assert.equal(result.turnControl, undefined);
  assert.equal(result.followUpUserInput, undefined);
});

test("非计划模式 / 非本工具 / 失败结果不进换模分支", () => {
  const output = {
    approved: true,
    executionModelSelection: { providerId: "p", modelId: "m" },
  };
  const original = approvedResult(output);
  assert.equal(
    withPlanExitApprovedTurnStop(original, {
      mode: "build",
      planEnabled: false,
      toolName: "ExitPlanMode",
    }),
    original,
  );
  assert.equal(
    withPlanExitApprovedTurnStop(
      approvedResult({
        ...output,
        previousPlanEnabled: true,
        plan: "- step",
      }),
      {
        mode: "plan",
        planEnabled: true,
        toolName: "Bash",
      },
    ).turnControl,
    undefined,
  );
  const failed: ToolExecutionResult = {
    ...approvedResult(output),
    success: false,
    error: { type: "PermissionDenied", message: "denied" },
  };
  assert.equal(withPlanExitApprovedTurnStop(failed, baseInput()).turnControl, undefined);
});

test("畸形模型选择（缺 providerId/modelId）不触发换模", () => {
  const result = withPlanExitApprovedTurnStop(
    approvedResult({ approved: true, executionModelSelection: { modelId: "m" } }),
    baseInput(),
  );
  assert.equal(result.turnControl, undefined);
});
