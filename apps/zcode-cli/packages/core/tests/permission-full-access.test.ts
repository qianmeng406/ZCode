import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";
import { grantPermissionFullAccess } from "../src/runtime/permission-full-access.js";

function fixture(config: Record<string, unknown> = {}) {
  const inputs = [
    {
      pendingInputId: "a",
      intent: { mode: "build", planEnabled: true, modelSelection: { modelId: "one" } },
    },
    { pendingInputId: "b", intent: { mode: "edit", planEnabled: false } },
  ];
  let receipt: unknown;
  const executions: unknown[] = [];
  const runtime = {
    sessionId: "session",
    config: { mode: "edit", planEnabled: true, ...config },
    rootTraceContext: {},
    pendingInputReservations: new Map(),
    activeTurn: {
      pendingInputs: inputs.map((item) => ({ id: item.pendingInputId, intent: item.intent })),
    },
    rebuildProjection: vi.fn(async () => ({ pendingSteerInputs: inputs })),
    // installRuntimeExecutionState 依赖 invalidateToolCache 推进派生版本；fixture 需与
    // runtime 方法面一致，否则授权安装路径报 not a function 掩盖真实断言。
    invalidateToolCache: vi.fn(() => {}),
    contextProjectionRevision: 0,
    sessionStore: {
      sessionEntries: vi.fn(async () =>
        receipt ? [{ id: "session:permission-full-access:permission-1", data: receipt }] : [],
      ),
      commitPermissionFullAccess: vi.fn(async (input) => {
        receipt = input.receipt.data;
        executions.push(input.execution);
      }),
    },
    createEvent: vi.fn((type, payload) => ({
      id: "grant-event",
      type,
      payload,
      sessionId: "session",
      traceId: "trace",
      timestamp: new Date(),
      sequenceNumber: 0,
    })),
    appendEvent: vi.fn(async () => {}),
    eventStore: { getEvents: vi.fn(async () => []) },
    notifyEventSinks: vi.fn(async () => {}),
  };
  return {
    runtime,
    executions,
    grant: () =>
      grantPermissionFullAccess.call(runtime as unknown as AgentRuntimeInternal, "permission-1"),
  };
}

describe("审批框完全访问", () => {
  it("保留 Runtime 和每项 Plan，只更新本次目标队列权限", async () => {
    const { runtime, grant } = fixture();
    await grant();
    // 安装路径把解析后的完整状态（含缺省补齐的 standard 档位）写入 config。
    expect(runtime.config).toEqual({
      mode: "yolo",
      planEnabled: true,
      contextProfile: "standard",
    });
    expect(runtime.activeTurn.pendingInputs.map((item) => item.intent)).toEqual([
      { mode: "yolo", planEnabled: true, modelSelection: { modelId: "one" } },
      { mode: "yolo", planEnabled: false },
    ]);
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
    expect(runtime.appendEvent).toHaveBeenCalledOnce();
  });
  it("Beta 会话授予全权时事件、持久化与内存一致保留 Beta", async () => {
    const { runtime, grant, executions } = fixture({ mode: "beta", planEnabled: false });
    await grant();
    expect(runtime.config).toEqual({
      mode: "beta",
      planEnabled: false,
      contextProfile: "standard",
    });
    expect(runtime.activeTurn.pendingInputs.map((item) => item.intent)).toEqual([
      { mode: "beta", planEnabled: true, modelSelection: { modelId: "one" } },
      { mode: "beta", planEnabled: false },
    ]);
    expect(executions).toHaveLength(1);
    expect((executions[0] as { data: unknown }).data).toEqual({
      mode: "beta",
      planEnabled: false,
      contextProfile: "standard",
    });
    const published = runtime.appendEvent.mock.calls[0]?.[0] as {
      payload: { mode: string };
    };
    expect(published.payload.mode).toBe("beta");
  });
  it("授权重试仍严格拒绝损坏 receipt，不重新抓取队列或提交权限", async () => {
    const { runtime, grant } = fixture();
    runtime.sessionStore.sessionEntries.mockResolvedValueOnce([
      {
        id: "session:permission-full-access:permission-1",
        data: { interactionId: "permission-1", event: null },
      },
    ]);
    await expect(grant()).rejects.toThrow();
    expect(runtime.sessionStore.commitPermissionFullAccess).not.toHaveBeenCalled();
    expect(runtime.rebuildProjection).not.toHaveBeenCalled();
    expect(runtime.appendEvent).not.toHaveBeenCalled();
    expect(runtime.config.mode).toBe("edit");
  });
  it("事务失败不改内存，不发布成功", async () => {
    const { runtime, grant } = fixture();
    runtime.sessionStore.commitPermissionFullAccess.mockRejectedValueOnce(new Error("disk full"));
    await expect(grant()).rejects.toThrow("disk full");
    expect(runtime.config.mode).toBe("edit");
    expect(runtime.activeTurn.pendingInputs[0]?.intent.mode).toBe("build");
    expect(runtime.appendEvent).not.toHaveBeenCalled();
  });
  it("提交后事件失败可重试，固定目标不覆盖后来入队消息", async () => {
    const { runtime, grant } = fixture();
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant()).rejects.toThrow("event failed");
    runtime.activeTurn.pendingInputs.push({
      id: "later",
      intent: { mode: "edit", planEnabled: false },
    });
    await grant();
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
    expect(runtime.activeTurn.pendingInputs.at(-1)?.intent.mode).toBe("edit");
  });
  it("Guide 正在消费或队列已 reserve 时拒绝提权，稍后可重试", async () => {
    const { runtime, grant } = fixture();
    Object.assign(runtime, { pendingInputDrains: 1 });
    await expect(grant()).rejects.toThrow("busy");
    Object.assign(runtime, { pendingInputDrains: 0 });
    runtime.pendingInputReservations.set("a", "reservation");
    await expect(grant()).rejects.toThrow("busy");
    runtime.pendingInputReservations.clear();
    await grant();
    expect(runtime.sessionStore.commitPermissionFullAccess).toHaveBeenCalledOnce();
  });
  it("发布失败后改权限，先补旧事件；迟到审批重试不覆盖较新的选择", async () => {
    const { runtime, grant } = fixture();
    const published: unknown[] = [];
    runtime.appendEvent.mockRejectedValueOnce(new Error("event failed"));
    await expect(grant()).rejects.toThrow("event failed");
    runtime.appendEvent.mockImplementation(async (event) => {
      published.push(event);
    });
    runtime.eventStore.getEvents.mockImplementation(async () => published);
    await applyRuntimeExecutionState(
      runtime as unknown as AgentRuntimeInternal,
      { mode: "build", planEnabled: false },
      { source: "command" },
    );
    expect(published.map((event: any) => event.payload.mode)).toEqual(["yolo", "build"]);
    await grant();
    expect(runtime.config).toEqual({
      mode: "build",
      planEnabled: false,
      contextProfile: "standard",
    });
    expect(published).toHaveLength(2);
  });
});
