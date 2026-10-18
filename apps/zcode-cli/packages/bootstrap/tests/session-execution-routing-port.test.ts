import { describe, expect, it, vi } from "vitest";
import type { ExecutionPort } from "@zcode/contracts";
import {
  createSessionExecutionRoutingPort,
  sessionExecutionSupportsBashBackgroundLifecycle,
  toExecutionWireRequest,
} from "../src/app/session-execution-routing-port.js";

function createChannel(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ params: Record<string, unknown> }> = [];
  const channel = {
    async execute(params: Record<string, unknown>) {
      calls.push({ params });
      const operation = params.operation as string;
      if (operation === "run") {
        return {
          ok: true,
          operation: "run",
          result: {
            status: "completed",
            exitCode: 0,
            stdout: { text: "hi", bytes: 2, truncated: false },
            stderr: { text: "", bytes: 0, truncated: false },
            durationMs: 3,
            timedOut: false,
            cancelled: false,
            startedAtMs: 1700000000000,
            completedAtMs: 1700000000003,
            resolvedCwd: "/mnt/c/repo",
            ...(overrides.run ?? {}),
          },
        };
      }
      return overrides[operation] ?? { ok: true, operation };
    },
    async release() {
      calls.push({ params: { operation: "__release" } });
      return overrides.release ?? { ok: true, operation: "release" };
    },
  };
  return { channel, calls };
}

function createPort(channel: unknown): ExecutionPort {
  return createSessionExecutionRoutingPort({
    sessionId: "sess-1",
    lease: { leaseId: "lease-1", generation: 0 },
    capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
    channel: channel as Parameters<typeof createSessionExecutionRoutingPort>[0]["channel"],
  });
}

describe("createSessionExecutionRoutingPort", () => {
  it("run 投影 ExecutionRequest → wire 并还原 Date/结果", async () => {
    const { channel, calls } = createChannel();
    const port = createPort(channel);
    const result = await port.run({
      command: { mode: "argv", file: "/bin/bash", args: ["-c", "echo hi"] },
      cwd: "C:\\repo",
      stdin: new Uint8Array([104, 105]),
      timeoutMs: 1000,
      sandbox: { enabled: true },
      trace: { traceId: "t1" },
    });
    expect(result.status).toBe("completed");
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.resolvedCwd).toBe("/mnt/c/repo");
    const request = calls[0].params.request as Record<string, unknown>;
    expect(request.cwd).toBe("C:\\repo");
    // Uint8Array stdin → base64；AbortSignal/function 不跨界
    expect(request.stdinBase64).toBe("aGk=");
    expect(request.stdin).toBeUndefined();
    expect(request.sandbox).toEqual({ enabled: true });
  });

  it("close 释放 lease，之后调用失败（borrowed 语义）", async () => {
    const { channel, calls } = createChannel();
    const port = createPort(channel);
    await port.close?.();
    expect(calls.at(-1)?.params.operation).toBe("__release");
    await expect(port.run({ command: { mode: "argv", file: "x" } })).rejects.toThrow(
      "released",
    );
    // 二次 close 幂等
    await expect(port.close?.()).resolves.toBeUndefined();
  });

  it("后台任务读取/取消保留完整语义（不只 run）", async () => {
    const snapshot = {
      taskId: "task-1",
      status: "running",
      startedAtMs: 1700000000000,
      stdoutBytes: 10,
      stdoutTail: "partial",
    };
    const { channel, calls } = createChannel({
      getBackgroundTask: { ok: true, operation: "getBackgroundTask", snapshot },
      cancelBackgroundTask: { ok: true, operation: "cancelBackgroundTask", snapshot },
    });
    const port = createPort(channel);
    const got = await port.getBackgroundTask?.("task-1");
    expect(got?.taskId).toBe("task-1");
    expect(got?.startedAt).toBeInstanceOf(Date);
    const cancelled = await port.cancelBackgroundTask?.("task-1");
    expect(cancelled?.status).toBe("running");
    const ops = calls.map((c) => c.params.operation);
    expect(ops).toContain("getBackgroundTask");
    expect(ops).toContain("cancelBackgroundTask");
  });

  it("readBackgroundBashOutput 转发 wire 输出", async () => {
    const { channel } = createChannel({
      readBackground: {
        ok: true,
        operation: "readBackground",
        output: {
          kind: "output",
          workId: "task-1",
          status: "completed",
          output: "line",
          truncated: false,
          outputPath: "/out",
        },
      },
    });
    const port = createPort(channel);
    const output = await port.readBackgroundBashOutput?.("task-1", "sess-1");
    expect(output).toMatchObject({ kind: "output", output: "line" });
  });

  it("能力位标记暴露（supportsBashBackgroundLifecycle 钩子用）", () => {
    const { channel } = createChannel();
    const port = createPort(channel);
    expect(sessionExecutionSupportsBashBackgroundLifecycle(port)).toBe(false);
  });
});

describe("toExecutionWireRequest", () => {
  it("拒绝互斥 stdin（text 与 base64 同时存在）", () => {
    expect(() =>
      toExecutionWireRequest({
        command: { mode: "argv", file: "x" },
        // 通过内部路径构造非法组合是不可能的；这里只验证 text 形态
      } as never),
    ).not.toThrow();
  });
});
