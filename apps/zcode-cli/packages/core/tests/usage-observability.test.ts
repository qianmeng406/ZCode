import { describe, expect, it, vi } from "vitest";
import { SessionEventType, type SessionEvent, type TraceContext } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { recordToolUsageFromEvent } from "../src/runtime/methods/usage-observability.js";

/**
 * 回归：appendEvent 会对**所有**事件调用 recordToolUsageFromEvent。
 * ExternalAgentBindingChanged(null)（解绑）的载荷是 null，早先这里直接
 * `payload.toolCallId` 会抛 "Cannot read properties of null"，让解绑命令与
 * 冷恢复（补发 binding=null）整体失败。
 */
describe("recordToolUsageFromEvent", () => {
  it("payload 为 null 时直接跳过，不抛错也不写 usage", async () => {
    const upsertToolUsage = vi.fn(async () => {});
    const runtime = {
      registry: { get: () => undefined },
      sessionId: "session-null-payload",
      sessionStore: {
        pruneUsage: vi.fn(),
        recordModelUsage: vi.fn(),
        upsertToolUsage,
        upsertTurnUsage: vi.fn(),
      },
    } as unknown as AgentRuntimeInternal;
    const event = {
      id: "event-1",
      sessionId: "session-null-payload",
      type: SessionEventType.ExternalAgentBindingChanged,
      timestamp: new Date(),
      traceId: "trace-1",
      sequenceNumber: 1,
      payload: null,
    } as unknown as SessionEvent;
    const traceContext = { traceId: "trace-1" } as TraceContext;

    await expect(recordToolUsageFromEvent(runtime, event, traceContext)).resolves.toBeUndefined();
    expect(upsertToolUsage).not.toHaveBeenCalled();
  });
});
