// firstModelTokenAt 口径测试：首 token 事实覆盖 text/reasoning/tool_input 三种流。
// 纯工具调用步（只有 tool_input_*）此前被当成"没有首 token"，指标胶囊整体缺失该
// 项（2026-11-01 用户报告的第 93 轮第 6 步）；tool_input_start/delta 也必须算首 token。
import { describe, expect, it } from "vitest";
import { createSessionId, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { firstModelTokenAt } from "../src/runtime/methods/usage-observability.js";

function streamingEvent(kind: string, delta: string, atMs: number): SessionEvent {
  return {
    id: `evt_${atMs}`,
    sessionId: createSessionId("first-token-at"),
    type: SessionEventType.ModelStreaming,
    timestamp: new Date(atMs),
    traceId: "trace_test",
    sequenceNumber: atMs,
    payload: { delta, done: false, kind },
  } as SessionEvent;
}

describe("firstModelTokenAt", () => {
  it("纯工具调用步：tool_input_start 即首 token", () => {
    const events = [
      streamingEvent("start", "", 1_000),
      streamingEvent("tool_input_start", "", 1_120),
      streamingEvent("tool_input_delta", '{"command"', 1_180),
    ];
    expect(firstModelTokenAt(events, 0)).toBe(1_120);
  });

  it("文本优先：首个非空 text_delta 计为首 token", () => {
    const events = [
      streamingEvent("start", "", 1_000),
      streamingEvent("tool_input_delta", '{"a":1}', 1_100),
      streamingEvent("text_delta", "你好", 1_200),
    ];
    expect(firstModelTokenAt(events, 0)).toBe(1_100);
  });

  it("只有 reasoning_delta 时也计首 token", () => {
    const events = [
      streamingEvent("reasoning_start", "", 1_000),
      streamingEvent("reasoning_delta", "想一想", 1_050),
      streamingEvent("text_delta", "答案", 1_500),
    ];
    expect(firstModelTokenAt(events, 0)).toBe(1_050);
  });

  it("没有任何流式 delta（非流式）时缺席，不估算", () => {
    expect(firstModelTokenAt([streamingEvent("start", "", 1_000)], 0)).toBeUndefined();
    expect(firstModelTokenAt([], 0)).toBeUndefined();
  });

  it("startIndex 之前的工具流不计入", () => {
    const events = [
      streamingEvent("tool_input_start", "", 1_000),
      streamingEvent("text_delta", "你好", 2_000),
    ];
    expect(firstModelTokenAt(events, 1)).toBe(2_000);
  });
});
