// 计划批准换模 follow-up 的自动消费豁免（端到端，复用 v4-auto-drain-race 的
// server + fake app 基建）：
//
// 用户在计划批准窗指定执行模型后，core 把换模交接输入以 `plan_exit_approved_`
// 前缀 sourceCommandId 塞进队列车道并停掉规划回合。若该会话此前发生过回合
// 报错/手动停止，队列处于暂停态（autoDrain=false）或 goal 未收口，旧 auto-drain
// 闸门会把这条系统交接输入永久扣下——用户看到「批准后系统提示词一直卡在排队框」，
// 只能手动点「立即发送」解锁。
//
// 修复后：v4-bridge 的 auto-drain 对队首为 plan_exit_approved_ 前缀的项豁免
// held/targetStatus 授权闸门（Core 空闲仍由 idle-only promotion lease 原子保证），
// 自动以该输入启动新回合并应用所选模型。
// 触发器用真实事件路径：TargetChanged(complete) 经 gateway ingest →
// onTargetCompleted → autoDrainV4QueueIfReady（与 goal verifier 收口后的重评同源）。
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createTraceId,
  createTurnId,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../src/app/types.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import {
  PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX,
  isPlanExitApprovedFollowUpSourceCommandId,
} from "@zcode/contracts";

const workspace = {
  workspacePath: "/workspace/plan-exit-handoff-drain",
  workspaceKey: "/workspace/plan-exit-handoff-drain",
};

async function requestResult(
  server: ZCodeProtocolAgentServer,
  message: ZCodeProtocolMessage,
): Promise<unknown> {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

/** 建一个真实 server 会话，返回事件注入器与提升路径 spies。 */
async function createHarness() {
  let sessionEventSink: ((event: SessionEvent) => void) | undefined;
  let sequenceNumber = 0;
  let emitEvent!: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent;
  const acquireForegroundPromotionLease = vi
    .fn()
    .mockImplementation(({ leaseId }) => ({ kind: "acquired" as const, leaseId }));
  const reserveQueueItem = vi.fn().mockResolvedValue(true);
  const markQueueItemPromoting = vi.fn().mockResolvedValue(true);
  const removeQueueItem = vi.fn().mockResolvedValue(true);
  const releaseQueueItemReservation = vi.fn().mockResolvedValue(true);
  const setQueueAutoDrain = vi.fn().mockResolvedValue(undefined);
  const readTarget = vi.fn().mockResolvedValue(null);
  const sendInput = vi.fn().mockResolvedValue({});

  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: (appOptions: ZCodeAppOptions) => {
      const app = createFakeApp(appOptions);
      return {
        ...app,
        markQueueItemPromoting,
        readTarget,
        releaseQueueItemReservation,
        removeQueueItem,
        reserveQueueItem,
        sendInput,
        setQueueAutoDrain,
        runtime: {
          ...app.runtime,
          acquireForegroundPromotionLease,
          getActiveForegroundExecutionId: () => undefined,
          subscribeEvents: (sink) => {
            sessionEventSink = sink.onSessionEvent;
            return () => {};
          },
        },
      } as ZCodeApp;
    },
    cwd: workspace.workspacePath,
    version: "test-version",
  });
  const created = (await requestResult(server, {
    id: "create-handoff",
    method: zcodeProtocolMethods.sessionCreate,
    params: { workspace },
  })) as { session: { sessionId: string } };
  const sessionId = created.session.sessionId as SessionId;
  const traceId = createTraceId("trace-handoff");
  emitEvent = (type, payload, turnId) => {
    sequenceNumber += 1;
    const event = {
      id: `event-handoff-${sequenceNumber}`,
      payload,
      sequenceNumber,
      sessionId,
      timestamp: new Date(1_700_000_000_000 + sequenceNumber),
      traceId,
      type,
      ...(turnId ? { turnId: createTurnId(turnId) } : {}),
    } as SessionEvent;
    sessionEventSink?.(event);
    return event;
  };
  emitEvent(SessionEventType.SessionCreated, { contextWindow: 128_000, mode: "build" });
  return {
    acquireForegroundPromotionLease,
    emitEvent,
    markQueueItemPromoting,
    readTarget,
    releaseQueueItemReservation,
    removeQueueItem,
    reserveQueueItem,
    sendInput,
    server,
    sessionId,
    setQueueAutoDrain,
  };
}

/** 投影里入队一条 plan-exit 换模 follow-up（与 core 生成形状一致）。 */
function queuePlanExitHandoff(
  emitEvent: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent,
) {
  emitEvent(
    SessionEventType.TurnSteerQueued,
    {
      pendingInputId: "plan_exit_approved_call-1",
      inputId: "plan_exit_approved_call-1",
      input:
        "The plan was approved. The user selected custom-provider/deepseek/deepseek-v4.1-flash (reasoning: high) for implementation.",
      inputPreview: "The plan was approved.",
      inputSize: 120,
      delivery: "queue",
      targetTurnId: "turn-plan",
      queueLength: 1,
      intent: {
        sourceCommandId: `${PLAN_EXIT_APPROVED_FOLLOW_UP_SOURCE_COMMAND_ID_PREFIX}call-1`,
        queueItemId: "plan_exit_approved_call-1",
        clientId: "plan_exit_approved_call-1",
        kind: "sendText",
        modelSelection: {
          providerId: "custom-provider",
          modelId: "deepseek/deepseek-v4.1-flash",
          options: { reasoningLevel: "high" },
        },
        admissionSeq: 1,
        admittedAt: 1_700_000_000_002,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
      },
    },
    "turn-plan",
  );
}

function queueOrdinaryText(
  emitEvent: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent,
) {
  emitEvent(
    SessionEventType.TurnSteerQueued,
    {
      pendingInputId: "queue-plain",
      inputId: "source-plain",
      input: "普通排队输入",
      inputPreview: "普通排队输入",
      inputSize: 18,
      delivery: "queue",
      targetTurnId: "turn-plan",
      queueLength: 1,
      intent: {
        sourceCommandId: "source-plain",
        queueItemId: "queue-plain",
        clientId: "desktop",
        kind: "sendText",
        admissionSeq: 2,
        admittedAt: 1_700_000_000_003,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
      },
    },
    "turn-plan",
  );
}

/** TargetChanged(complete)：目标收口事件，gateway ingest 后触发自动消费重评。 */
function completeTarget(
  emitEvent: (type: SessionEvent["type"], payload: unknown, turnId?: string) => SessionEvent,
) {
  emitEvent(SessionEventType.TargetChanged, {
    target: { targetID: "g1", objective: "done", status: "complete" },
  });
}

describe("plan-exit model-switch handoff auto-drain", () => {
  it("暂停队列（autoDrain=false）不扣下换模 follow-up：自动提升并以所选模型启动新回合", async () => {
    const harness = await createHarness();
    queuePlanExitHandoff(harness.emitEvent);
    // 暂停队列事实：与 core turn 错误收口/手动停止时的 QueueAutoDrainChanged(false) 同形。
    harness.emitEvent(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });

    completeTarget(harness.emitEvent);
    await vi.waitFor(
      () => {
        expect(harness.sendInput).toHaveBeenCalledOnce();
      },
      { timeout: 2_000 },
    );
    expect(harness.reserveQueueItem).toHaveBeenCalledWith(
      "plan_exit_approved_call-1",
      expect.any(String),
      expect.anything(),
    );
    expect(harness.markQueueItemPromoting).toHaveBeenCalledOnce();
    expect(harness.removeQueueItem).toHaveBeenCalledOnce();
    // 豁免路径不翻暂停位：队列保持原样，不因系统交接项被 setQueueAutoDrain(false)。
    expect(harness.setQueueAutoDrain).not.toHaveBeenCalled();
  });

  it("普通排队输入在暂停队列（autoDrain=false）下维持不自动消费", async () => {
    const harness = await createHarness();
    queueOrdinaryText(harness.emitEvent);
    harness.emitEvent(SessionEventType.QueueAutoDrainChanged, { autoDrain: false });

    completeTarget(harness.emitEvent);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.reserveQueueItem).not.toHaveBeenCalled();
    expect(harness.sendInput).not.toHaveBeenCalled();
    expect(harness.setQueueAutoDrain).not.toHaveBeenCalled();
  });

  it("目标 goal 未收口（target=active）不扣下换模 follow-up", async () => {
    const harness = await createHarness();
    queuePlanExitHandoff(harness.emitEvent);
    // 无 QueueAutoDrainChanged：autoDrain 保持默认 true；target=active 只会挡普通队列。
    harness.readTarget.mockResolvedValue({ targetID: "g1", objective: "x", status: "active" });

    completeTarget(harness.emitEvent);
    await vi.waitFor(
      () => {
        expect(harness.sendInput).toHaveBeenCalledOnce();
      },
      { timeout: 2_000 },
    );
  });
});

describe("plan-exit handoff source id marker", () => {
  it("core 生成的 sourceCommandId 命中豁免谓词；普通输入不命中", () => {
    expect(isPlanExitApprovedFollowUpSourceCommandId("plan_exit_approved_call-1")).toBe(true);
    expect(isPlanExitApprovedFollowUpSourceCommandId("source-plain")).toBe(false);
    expect(isPlanExitApprovedFollowUpSourceCommandId("plan_exit_approved_other")).toBe(true);
    expect(isPlanExitApprovedFollowUpSourceCommandId("")).toBe(false);
  });
});
