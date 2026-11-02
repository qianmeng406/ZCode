// 只读主控锁（externalAgentReadOnly）在执行状态唯一写入口的兜底。
//
// 这一层存在的理由：切模式有三条互不相同的写路径——命令面 switchCollaborationMode、
// plan 工具路径、以及 turn-model.ts 直接 apply 提交意图里的 mode/planEnabled。
// 只在命令 handler 拦截等于没拦：UI 草稿层的模式切换随下一次发送就能绕过。
import { describe, expect, it, vi } from "vitest";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const TRACE = { traceId: "t1", sessionId: "s1" };

/** 只铺 applyRuntimeExecutionState 实际读到的字段。 */
function makeRuntime(options: { readOnly: boolean; mode?: string; planEnabled?: boolean }) {
  const runtime = {
    externalAgentReadOnly: options.readOnly,
    config: { mode: options.mode ?? "build", planEnabled: options.planEnabled ?? false },
    sessionPersisted: false,
    rootTraceContext: TRACE,
    permissionFullAccessPending: false,
    appendEvent: vi.fn(async () => {}),
    createEvent: vi.fn(() => ({})),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
  return runtime as unknown as AgentRuntimeInternal & typeof runtime;
}

describe("只读主控锁", () => {
  it("锁在时拒绝任何把会话放出只读的写入", async () => {
    const runtime = makeRuntime({ readOnly: true, mode: "plan", planEnabled: true });
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "yolo", planEnabled: false }, { source: "command" }),
    ).rejects.toThrow(/read-only/i);
    // 状态未被改动：失败是 fail-closed 的。
    expect(runtime.config.mode).toBe("plan");
    expect(runtime.config.planEnabled).toBe(true);
    expect(runtime.appendEvent).not.toHaveBeenCalled();
  });

  it("锁在时提交意图携带的 mode（turn-model 路径）同样被拒", async () => {
    const runtime = makeRuntime({ readOnly: true, mode: "plan", planEnabled: true });
    // 这是 turn-model.ts:172 用同一入口 apply 的形状——不经过任何命令 handler。
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "build", planEnabled: false }, { source: "command" }),
    ).rejects.toThrow(/read-only/i);
  });

  it("锁在时保持只读的写入照常成功（绑定自己那次进入 plan）", async () => {
    const runtime = makeRuntime({ readOnly: true, mode: "build", planEnabled: false });
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "plan", planEnabled: true }, { source: "command" }),
    ).resolves.toMatchObject({ planEnabled: true });
    expect(runtime.config.planEnabled).toBe(true);
    expect(runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("未上锁时正常放行（解绑后的恢复依赖这一点）", async () => {
    const runtime = makeRuntime({ readOnly: false, mode: "plan", planEnabled: true });
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "yolo", planEnabled: false }, { source: "command" }),
    ).resolves.toMatchObject({ mode: "yolo", planEnabled: false });
  });
});
