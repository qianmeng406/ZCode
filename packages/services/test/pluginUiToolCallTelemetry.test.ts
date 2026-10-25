import { describe, expect, it, vi } from "vitest";
import { createPluginUiBridgeService } from "../src/plugin-ui-bridge/pluginUiBridgeService.js";

const baseParams = {
  workspacePath: "/a",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:x",
  instance: {
    runtimeId: "agent",
    generation: 1,
    token: "token",
    appIdentity: "a".repeat(64),
  },
  callId: "c1",
  toolName: "t",
};

function createBridge(overrides: Partial<Parameters<typeof createPluginUiBridgeService>[0]>) {
  const report = vi.fn(() => {});
  const bridge = createPluginUiBridgeService({
    callMcpToolForUi: async () => ({ content: [] }),
    reportTelemetryEvent: report,
    ...overrides,
  });
  return { bridge, report };
}

describe("MCP App panel tool-call telemetry", () => {
  it("reports the first success per plugin and rate-limits the rest", async () => {
    const { bridge, report } = createBridge({});
    for (let index = 0; index < 5; index += 1) {
      await bridge.callTool({ ...baseParams, callId: `c${index}` });
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].eventExtraDetail).toMatchObject({
      action: "ui_tool_call",
      result: "success",
    });
  });

  it("always reports failures and cancellations without consuming the success budget", async () => {
    const { bridge, report } = createBridge({
      callMcpToolForUi: async () => {
        throw new Error("boom");
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await bridge.callTool({ ...baseParams, callId: `f${index}` }).catch(() => undefined);
    }
    expect(report).toHaveBeenCalledTimes(3);
    for (const call of report.mock.calls)
      expect(call[0].eventExtraDetail).toMatchObject({ result: "failure" });

    // 成功预算未被失败消耗：切换回成功实现后第一条成功仍上报。
    const succeeding = createBridge({});
    await succeeding.bridge.callTool({ ...baseParams, callId: "ok1" });
    await succeeding.bridge.callTool({ ...baseParams, callId: "ok2" });
    expect(succeeding.report).toHaveBeenCalledTimes(1);
  });

  it("rate-limits per plugin independently", async () => {
    const { bridge, report } = createBridge({});
    await bridge.callTool({ ...baseParams, pluginId: "a", callId: "a1" });
    await bridge.callTool({ ...baseParams, pluginId: "a", callId: "a2" });
    await bridge.callTool({ ...baseParams, pluginId: "b", callId: "b1" });
    expect(report).toHaveBeenCalledTimes(2);
    const reportedPlugins = report.mock.calls.map((call) => call[0].eventExtraDetail.plugin_id);
    expect(reportedPlugins).toEqual(["a", "b"]);
  });

  it("does not throttle abort cancellations", async () => {
    const { bridge, report } = createBridge({
      callMcpToolForUi: (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });
    const controller = new AbortController();
    const pending = bridge.callTool({ ...baseParams, callId: "x" }, { signal: controller.signal });
    controller.abort();
    await pending.catch(() => undefined);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].eventExtraDetail).toMatchObject({ result: "cancelled" });
  });
});
