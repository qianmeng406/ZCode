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
