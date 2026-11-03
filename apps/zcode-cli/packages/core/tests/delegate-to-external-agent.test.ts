// DelegateToExternalAgent 的权限形状与处理行为。
// 这个工具是"只读主控"唯一的出手通道——如果它在 plan 模式下被拦，
// 整个功能就不可用；如果它没被正确标成 session 作用域，只读契约就会被绕过。
import { describe, expect, it, vi } from "vitest";
import {
  DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  delegateToExternalAgentToolEntry,
} from "../src/tool/handlers/delegate-to-external-agent.js";

describe("DelegateToExternalAgent 元数据", () => {
  const metadata = delegateToExternalAgentToolEntry.metadata;

  it("在 plan（只读）模式下必须可用", () => {
    // checkPlanMode 的放行条件是：
    // allowedInPlanMode && sideEffectScope === "session" && !destructive && !needsApproval
    expect(metadata.allowedInPlanMode).toBe(true);
    expect(metadata.sideEffectScope).toBe("session");
    expect(metadata.destructive).toBe(false);
    expect(metadata.needsApproval).toBe(false);
  });

  it("自身被标记为只读（它不写工作区，写的是外部进程）", () => {
    expect(metadata.readOnly).toBe(true);
  });

  it("名字稳定（协议与 UI 都按它引用）", () => {
    expect(metadata.name).toBe(DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME);
    expect(DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME).toBe("DelegateToExternalAgent");
  });
});

describe("DelegateToExternalAgent handler", () => {
  const handler = delegateToExternalAgentToolEntry.handler;

  function makeContext(port: unknown) {
    return {
      toolCallId: "call-1",
      sessionId: "sess-1",
      traceId: "trace-1",
      abortSignal: new AbortController().signal,
      workingDirectory: "/tmp/ws",
      workspaceRoot: "/tmp/ws",
      externalAgentPort: port,
      emitEvent: vi.fn(async () => undefined),
    } as never;
  }

  it("端口缺席时报能力缺席，不静默成功", async () => {
    await expect(handler({ task: "做点事" }, makeContext(undefined))).rejects.toThrow(
      /not configured/i,
    );
  });

  it("未绑定外部 agent 时报可恢复错误并给出可操作提示", async () => {
    const port = { delegate: async () => ({ kind: "unbound" as const }) };
    await expect(handler({ task: "做点事" }, makeContext(port))).rejects.toThrow(
      /没有绑定外部 agent/,
    );
  });

  it("委派成功时把结果整理成结构化输出", async () => {
    const port = {
      delegate: async () => ({
        kind: "delegated" as const,
        label: "codebuddy",
        text: "已修好 3 处",
        exitCode: 0,
        isError: false,
        durationMs: 1234,
      }),
    };
    await expect(handler({ task: "修 lint" }, makeContext(port))).resolves.toEqual({
      agent: "codebuddy",
      success: true,
      exitCode: 0,
      durationMs: 1234,
      result: "已修好 3 处",
    });
  });

  it("外部 agent 失败时 success=false 但结果仍然回传（证据不能丢）", async () => {
    const port = {
      delegate: async () => ({
        kind: "delegated" as const,
        label: "codebuddy",
        text: "权限不足，无法写入",
        exitCode: 1,
        isError: true,
        durationMs: 800,
      }),
    };
    await expect(handler({ task: "改文件" }, makeContext(port))).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      result: "权限不足，无法写入",
    });
  });

  it("把 context 一并传给端口（外部 agent 看不到本会话历史）", async () => {
    const delegate = vi.fn(async () => ({
      kind: "delegated" as const,
      label: "cb",
      text: "ok",
      exitCode: 0,
      isError: false,
      durationMs: 1,
    }));
    await handler({ task: "计划", context: "验收标准：全部单测通过" }, makeContext({ delegate }));
    expect(delegate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        task: "计划",
        context: "验收标准：全部单测通过",
        cwd: "/tmp/ws",
      }),
    );
  });

  it("模型可见内容带执行摘要，便于主会话据此继续", () => {
    const format = delegateToExternalAgentToolEntry.formatModelContent!;
    expect(
      format({ agent: "codebuddy", success: true, exitCode: 0, durationMs: 1200, result: "完成" }),
    ).toContain("已完成");
    expect(
      format({ agent: "cb", success: false, exitCode: 1, durationMs: 50, result: "失败原因" }),
    ).toContain("执行失败");
  });
});

describe("DelegateToExternalAgent 有界等待", () => {
  const handler = delegateToExternalAgentToolEntry.handler;

  function makeContext(port: unknown) {
    return {
      toolCallId: "call-1",
      sessionId: "sess-1",
      traceId: "trace-1",
      abortSignal: new AbortController().signal,
      workingDirectory: "/tmp/ws",
      workspaceRoot: "/tmp/ws",
      externalAgentPort: port,
      emitEvent: vi.fn(async () => undefined),
    } as never;
  }

  const completed = {
    kind: "delegated" as const,
    label: "codebuddy",
    text: "已改完",
    exitCode: 0,
    isError: false,
    durationMs: 800,
    continued: true,
  };

  it("start + poll 等到的结果与同步 delegate 同形", async () => {
    const delegate = vi.fn();
    const port = {
      delegate,
      start: async () => ({ taskId: "task-9" }),
      poll: async () => ({
        taskId: "task-9",
        sessionId: "sess-1",
        status: "completed" as const,
        durationMs: 800,
        outcome: completed,
      }),
    };
    const output = (await handler({ task: "计划" }, makeContext(port))) as Record<string, unknown>;
    expect(output).toMatchObject({ agent: "codebuddy", success: true, result: "已改完" });
    // 走了后台路径就不再重复跑一次同步委派。
    expect(delegate).not.toHaveBeenCalled();
  });

  it("等待超时返回 running + taskId，不把 turn 卡死", async () => {
    const port = {
      delegate: vi.fn(),
      start: async () => ({ taskId: "task-10" }),
      poll: async () => ({
        taskId: "task-10",
        sessionId: "sess-1",
        status: "running" as const,
        durationMs: 0,
      }),
    };
    const output = (await handler(
      { task: "计划", waitMinutes: 0 },
      makeContext(port),
    )) as Record<string, unknown>;
    expect(output).toMatchObject({ running: true, taskId: "task-10" });
    expect(
      delegateToExternalAgentToolEntry.runtimeOutputSchema.safeParse(output).success,
    ).toBe(true);
  });

  it("running 形态的模型可见内容明确告诉模型去轮询而不是重试", () => {
    const format = delegateToExternalAgentToolEntry.formatModelContent!;
    const text = format({ agent: "codebuddy", running: true, taskId: "task-10", durationMs: 5000 });
    expect(text).toContain("GetExternalAgentTaskResult");
    expect(text).toContain("task-10");
  });
});
