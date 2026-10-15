// Composer main-turn metrics（Feature 3）core 事实源测试：
// main_turn 的 ModelComplete 必须携带与 usage-observability 同口径的 timings
// （startedAt / firstTokenAt / generationDurationMs）；非流式无首 token 事实时
// firstTokenAt 缺席，绝不估算；子代理 querySource 不携带 timings。
import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId, SessionEventType } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import type { ModelEvent, ModelResult } from "@zcode/contracts";

function streamTextWithFirstDelta(): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start" } as ModelEvent;
      // 真实 text_delta 事件由 runtime 持久化；firstTokenAt 从其时间戳读取。
      yield { type: "text_delta", text: "hello" } as ModelEvent;
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3 },
      } as ModelEvent;
    },
  };
}

describe("turn model step timings", () => {
  it("streaming main turn emits ModelComplete.timings with real first-token facts", async () => {
    const sessionId = createSessionId("turn-timings");
    const eventStore = createTestSessionEventStore();
    let streamStartedAt = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "on" },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          streamText() {
            streamStartedAt = Date.now();
            return streamTextWithFirstDelta();
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");
    const events = await eventStore.getEvents(sessionId);
    const modelComplete = events.find(
      (event) => event.type === SessionEventType.ModelComplete,
    );
    const payload = modelComplete?.payload as
      | { timings?: { startedAt?: number; firstTokenAt?: number; generationDurationMs?: number } }
      | undefined;
    expect(payload?.timings).toBeDefined();
    // startedAt 在 runModelTextRequest 之前捕获；流开始不早于它。
    expect(payload?.timings?.startedAt).toBeLessThanOrEqual(streamStartedAt + 5);
    expect(payload?.timings?.firstTokenAt).toBeGreaterThanOrEqual(
      payload?.timings?.startedAt ?? Number.POSITIVE_INFINITY,
    );
    expect(payload?.timings?.generationDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("non-streaming main turn omits firstTokenAt instead of estimating", async () => {
    const sessionId = createSessionId("turn-timings-nonstream");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation): Promise<ModelResult> {
            return {
              finishReason: "stop",
              model: observation.model,
              providerMetadata: undefined,
              text: "model response",
              usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");
    const events = await eventStore.getEvents(sessionId);
    const modelComplete = events.find(
      (event) => event.type === SessionEventType.ModelComplete,
    );
    const payload = modelComplete?.payload as
      | { timings?: { firstTokenAt?: number; generationDurationMs?: number } }
      | undefined;
    expect(payload?.timings).toBeDefined();
    // 非流式没有首 token 事实：字段缺席，UI 显示不可用而不是猜测。
    expect(payload?.timings?.firstTokenAt).toBeUndefined();
    expect(payload?.timings?.generationDurationMs).toBeGreaterThanOrEqual(0);
  });
});
