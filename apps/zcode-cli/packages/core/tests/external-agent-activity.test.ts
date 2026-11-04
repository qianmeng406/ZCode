import { describe, expect, it, vi } from "vitest";
import { createExternalAgentActivityReporter } from "../src/tool/handlers/external-agent-activity.js";

/**
 * 活动快照是过程面板/状态卡的唯一数据源：这里钉住"开始帧带模型"，
 * 面板头部才能显示 CodeBuddy + 模型，而不是只有名字。
 */
function makeContext() {
  const emitEvent = vi.fn(async () => undefined);
  return {
    context: {
      toolCallId: "call-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      traceId: "trace-1",
      abortSignal: new AbortController().signal,
      emitEvent,
    } as never,
    emitEvent,
  };
}

describe("createExternalAgentActivityReporter", () => {
  it("started 带模型时写进活动快照", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });

    reporter.started({ label: "CodeBuddy", model: "glm-4.6" });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const event = emitEvent.mock.calls[0]?.[0] as unknown as {
      payload: { activity: Record<string, unknown> };
    };
    expect(event.payload.activity).toMatchObject({
      agentLabel: "CodeBuddy",
      model: "glm-4.6",
      status: "running",
    });
  });

  it("没有模型时不写空字段（旧快照形状不变）", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });

    reporter.started({ label: "CodeBuddy" });

    const event = emitEvent.mock.calls[0]?.[0] as unknown as {
      payload: { activity: Record<string, unknown> };
    };
    expect(event.payload.activity).not.toHaveProperty("model");
  });
});
