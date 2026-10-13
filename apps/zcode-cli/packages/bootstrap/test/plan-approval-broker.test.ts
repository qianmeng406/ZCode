import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import {
  planApprovalResponseToBrokerResult,
  v4AnswerToPlanApprovalResponse,
} from "../src/zcode-protocol/interaction-broker.js";

function brokerRequest(input: unknown): PermissionBrokerRequest {
  return {
    requestId: "perm_1",
    sessionId: "sess-1",
    traceId: "trace-1",
    toolCallId: "call-1",
    toolName: "ExitPlanMode",
    input,
    mode: "plan",
    ruleId: "rule.plan.exit",
    reason: "Review this implementation plan.",
    riskLevel: "low",
    requestedAt: new Date(0),
  };
}

function approveResponse(content?: Record<string, unknown>) {
  return {
    action: "accept" as const,
    ...(content ? { content } : {}),
  };
}

test("批准不带执行模型：allow 决策（现行行为不变）", () => {
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({ answer: "approve" }),
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.modifiedInput, undefined);
});

test("批准附带执行模型：modify 决策把选择合并进工具输入（含推理档）", () => {
  const selection = {
    providerId: "custom-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    options: { reasoningLevel: "high" },
  };
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step", allowedPrompts: [] }),
    approveResponse({ answer: "approve", executionModelSelection: selection }),
  );
  assert.equal(result.decision, "modify");
  assert.deepEqual(result.modifiedInput, {
    plan: "- step",
    allowedPrompts: [],
    executionModelSelection: selection,
  });
});

test("非法模型选择形状不进 modify 分支（回落 allow）", () => {
  const result = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({
      answer: "approve",
      executionModelSelection: { providerId: 1, modelId: "m" },
    }),
  );
  assert.equal(result.decision, "allow");
});

test("反馈文本仍走 plan_approval_feedback deny；拒绝走普通 deny", () => {
  const feedback = planApprovalResponseToBrokerResult(
    brokerRequest({ plan: "- step" }),
    approveResponse({ answer: "请把步骤 2 拆细" }),
  );
  assert.equal(feedback.decision, "deny");
  assert.equal(feedback.reasonSource, "plan_approval_feedback");

  const decline = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), {
    action: "decline",
  });
  assert.equal(decline.decision, "deny");
  assert.equal(decline.reasonSource, undefined);
});

/**
 * 端到端上半程：从真实 UI 应答形状出发，覆盖「UI answer.modelSelection → broker 内容」
 * 这一此前未被任何测试触及的搬运环节（v4AnswerToPlanApprovalResponse）。它正是
 * 「用户选了执行模型却没切换」最可能静默失效的位置——一旦搬运丢失，后续
 * planApprovalResponseToBrokerResult 会安静回落 allow（跟随会话模型），没有任何报错。
 * 复刻 desktop ElicitationDialog → V4PlanElicitationDialog 的 action 路径应答形状。
 */
function uiApprovalAnswer(options: {
  executionModel?: { providerId: string; modelId: string; reasoningLevel?: string };
  action?: "accept" | "decline" | "cancel";
}) {
  const { executionModel } = options;
  return {
    action: options.action ?? ("accept" as const),
    ...(options.action === "decline" || options.action === "cancel"
      ? {}
      : { content: { answer: "approve" } }),
    ...(executionModel
      ? {
          modelSelection: {
            providerId: executionModel.providerId,
            modelId: executionModel.modelId,
            ...(executionModel.reasoningLevel
              ? { options: { reasoningLevel: executionModel.reasoningLevel } }
              : {}),
          },
        }
      : {}),
  };
}

test("UI 应答（action 路径）指定执行模型：全程产出 modify 输入并携带选择（含推理档）", () => {
  const response = v4AnswerToPlanApprovalResponse(
    uiApprovalAnswer({
      executionModel: {
        providerId: "custom-provider",
        modelId: "deepseek/deepseek-v4.1-flash",
        reasoningLevel: "high",
      },
    }),
  );
  const result = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), response);

  assert.equal(result.decision, "modify");
  assert.deepEqual(result.modifiedInput, {
    plan: "- step",
    executionModelSelection: {
      providerId: "custom-provider",
      modelId: "deepseek/deepseek-v4.1-flash",
      options: { reasoningLevel: "high" },
    },
  });
});

test("UI 应答（action 路径）不指定模型：仍走 allow，不触发换模", () => {
  const response = v4AnswerToPlanApprovalResponse(uiApprovalAnswer({}));
  const result = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), response);

  assert.equal(result.decision, "allow");
  assert.equal(result.modifiedInput, undefined);
});

test("UI 应答（action 路径）拒绝：deny，不回显 reasonSource", () => {
  const response = v4AnswerToPlanApprovalResponse(uiApprovalAnswer({ action: "decline" }));
  const result = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), response);

  assert.equal(result.decision, "deny");
  assert.equal(result.reasonSource, undefined);
});

test("旧 optionId 批准路径不携带模型选择：批准成立但不换模（锁定现状边界）", () => {
  const response = v4AnswerToPlanApprovalResponse({ optionId: "allowOnce" });
  assert.equal(response.action, "accept");

  const result = planApprovalResponseToBrokerResult(brokerRequest({ plan: "- step" }), response);
  assert.equal(result.decision, "allow");
  assert.equal(result.modifiedInput, undefined);
});
