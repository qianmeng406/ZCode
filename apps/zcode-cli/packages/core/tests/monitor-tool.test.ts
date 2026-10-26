import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, registerBuiltInTools } from "../src/tool/index.js";
import { monitorToolEntry } from "../src/tool/handlers/monitor.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function createContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "tool-monitor",
    traceId: "trace-monitor" as never,
    abortSignal: new AbortController().signal,
    model: createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "" }),
      providerId: "zai-api",
      modelId: "GLM-5",
    }),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: "sess-monitor" as never,
    ...overrides,
  } as ToolExecutionContext;
}

async function run(input: unknown, context: ToolExecutionContext) {
  return (await monitorToolEntry.handler!(input, context)) as Record<string, unknown>;
}

describe("Monitor tool", () => {
  it("默认不注册，只有显式打开 fork 开关才进入工具面", () => {
    const off = createToolRegistry();
    registerBuiltInTools(off);
    expect(off.has("Monitor")).toBe(false);

    const on = createToolRegistry();
    registerBuiltInTools(on, { includeMonitor: true });
    expect(on.has("Monitor")).toBe(true);
  });

  it("等待文件出现目标文本后立即返回并给出片段", async () => {
    const readTextFile = vi.fn(
      async () =>
        ({
          path: "/workspace/out.log",
          content: "boot\nready on port 5173\ndone",
          encoding: "utf8",
          bytesRead: 31,
          sizeBytes: 31,
          truncated: false,
          lineEndings: { eol: "\n" },
        }) as never,
    );
    const context = createContext({
      fileSystemPort: {
        stat: vi.fn(async () => ({ path: "/workspace/out.log", kind: "file" })),
        readTextFile,
      } as never,
    });

    const result = await run(
      {
        target_kind: "file",
        expect_kind: "file_contains",
        file_path: "/workspace/out.log",
        text: "ready on port",
        timeout_ms: 2_000,
        poll_interval_ms: 50,
      },
      context,
    );

    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe("matched");
    expect(String(result.snippet)).toContain("ready on port 5173");
  });

  it("轮询直到后台任务输出出现正则命中", async () => {
    let polls = 0;
    const context = createContext({
      runtimeTaskRegistry: {
        get: () => ({ taskId: "task-1", status: "running" }),
      } as never,
      executionPort: {
        readBackgroundBashOutput: vi.fn(async () => {
          polls += 1;
          return {
            kind: "output",
            workId: "task-1",
            status: "running",
            output: polls >= 2 ? "compiled\nlistening on :3000\n" : "compiling...\n",
            truncated: false,
            outputPath: "/tmp/task-1.out",
          };
        }),
      } as never,
    });

    const result = await run(
      {
        target_kind: "task",
        expect_kind: "output_matches",
        task_id: "task-1",
        pattern: "listening on :\\d+",
        timeout_ms: 3_000,
        poll_interval_ms: 50,
      },
      context,
    );

    expect(result.satisfied).toBe(true);
    expect(result.reason).toBe("matched");
    expect(String(result.snippet)).toContain("listening on :3000");
  });

  it("任务结束仍未命中时返回 target_terminal 而不是空转到超时", async () => {
    const context = createContext({
      runtimeTaskRegistry: {
        get: () => ({ taskId: "task-2", status: "failed" }),
      } as never,
      executionPort: {
        readBackgroundBashOutput: vi.fn(async () => ({
          kind: "output",
          workId: "task-2",
          status: "failed",
          output: "Error: port already in use",
          truncated: false,
          outputPath: "/tmp/task-2.out",
        })),
      } as never,
    });

    const result = await run(
      {
        target_kind: "task",
        expect_kind: "output_matches",
        task_id: "task-2",
        pattern: "ready on port",
        timeout_ms: 5_000,
        poll_interval_ms: 50,
      },
      context,
    );

    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("target_terminal");
    expect(String(result.last_observed)).toContain("port already in use");
  });

  it("任务不存在时立即返回 target_missing", async () => {
    const context = createContext({
      runtimeTaskRegistry: { get: () => undefined } as never,
    });

    const result = await run(
      {
        target_kind: "task",
        expect_kind: "output_matches",
        task_id: "missing",
        pattern: "x",
        timeout_ms: 5_000,
        poll_interval_ms: 50,
      },
      context,
    );

    expect(result.reason).toBe("target_missing");
  });

  it("等待端口可连接", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const result = await run(
        {
          target_kind: "port",
          expect_kind: "reachable",
          port,
          timeout_ms: 2_000,
          poll_interval_ms: 50,
        },
        createContext(),
      );
      expect(result.satisfied).toBe(true);
      expect(String(result.snippet)).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("target_kind 与 expect_kind 不匹配时在输入校验阶段拒绝", () => {
    const result = monitorToolEntry.validateInput!(
      { target_kind: "file", expect_kind: "reachable", file_path: "/tmp/a" },
      {} as never,
    );
    expect(result.result).toBe(false);
    expect(String((result as { message?: string }).message)).toContain("file_contains");
  });

  it("拒绝非法正则", async () => {
    const result = await run(
      {
        target_kind: "task",
        expect_kind: "output_matches",
        task_id: "task-1",
        pattern: "([",
        timeout_ms: 1_000,
        poll_interval_ms: 50,
      },
      createContext({ runtimeTaskRegistry: { get: () => undefined } as never }),
    );
    expect(result.result).toBe(false);
  });
});
