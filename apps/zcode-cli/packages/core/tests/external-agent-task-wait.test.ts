// GetExternalAgentTaskResult 的等待语义。
//
// 背景（2026-11-07 实测）：主 agent 没有"等外部任务结束"的工具，只能
// `Get → 还是 running → Bash sleep 60 → Get`，任务第 5 秒结束也要睡满一轮。
// 现在这个工具自己会等：任务收口立即返回，到点仍在跑就返回 running 快照。
// 这里钉住四件事：默认等多久、waitSeconds=0 只看一眼、预算覆盖等待时长、旧端口有轮询兜底。
import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentTaskSnapshot } from "@zcode/contracts";
import {
  DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS,
  GET_EXTERNAL_AGENT_TASK_TOOL_NAME,
  MAX_EXTERNAL_AGENT_WAIT_SECONDS,
  getExternalAgentTaskResultToolEntry,
  startExternalAgentTaskToolEntry,
} from "../src/tool/handlers/external-agent-tasks.js";

const entry = getExternalAgentTaskResultToolEntry;
const handler = entry.handler;

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

function snapshot(status: ExternalAgentTaskSnapshot["status"]): ExternalAgentTaskSnapshot {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    status,
    durationMs: 1_234,
    ...(status === "completed"
      ? {
          outcome: {
            kind: "delegated" as const,
            label: "codebuddy",
            text: "改完了",
            exitCode: 0,
            isError: false,
            durationMs: 1_234,
            continued: false,
          },
        }
      : {}),
  };
}

describe("GetExternalAgentTaskResult 元数据", () => {
  it("只读主控下可用，且名字稳定", () => {
    expect(entry.metadata.allowedInPlanMode).toBe(true);
    expect(entry.metadata.readOnly).toBe(true);
    expect(entry.metadata.name).toBe(GET_EXTERNAL_AGENT_TASK_TOOL_NAME);
  });

  it("工具说明明确要求不要用 sleep 等", () => {
    const instructions = (entry.metadata.modelInstructions ?? []).join("\n");
    expect(instructions).toMatch(/never sleep/i);
    expect(instructions).toMatch(/waitSeconds/);
  });

  it("超时预算覆盖 waitSeconds：否则等待会被自己的超时打断", () => {
    const budget = (input: unknown) => entry.resolveTimeoutBudgetMs?.(input);

    // 缺省等 60s：预算必须大于 60s。
    expect(budget({ taskId: "task-1" })).toBeGreaterThan(
      DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS * 1_000,
    );
    // 上限也要覆盖。
    expect(
      budget({ taskId: "task-1", waitSeconds: MAX_EXTERNAL_AGENT_WAIT_SECONDS }),
    ).toBeGreaterThan(MAX_EXTERNAL_AGENT_WAIT_SECONDS * 1_000);
    // 列表形态不等待，不看任务。
    expect(budget({})).toBeUndefined();
  });
});

describe("GetExternalAgentTaskResult handler", () => {
  it("缺省阻塞等待：用端口的事件驱动 wait，而不是自己 sleep", async () => {
    const wait = vi.fn(async () => snapshot("completed"));
    const poll = vi.fn(async () => snapshot("running"));
    const result = (await handler({ taskId: "task-1" }, makeContext({ wait, poll }))) as {
      status: string;
      waitedMs?: number;
      outcome?: { text?: string };
    };

    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: DEFAULT_EXTERNAL_AGENT_WAIT_SECONDS * 1_000,
    });
    expect(poll).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.outcome?.text).toBe("改完了");
    expect(typeof result.waitedMs).toBe("number");
  });

  it("waitSeconds=0 只看一眼：走 poll，不阻塞", async () => {
    const wait = vi.fn(async () => snapshot("completed"));
    const poll = vi.fn(async () => snapshot("running"));
    const result = (await handler(
      { taskId: "task-1", waitSeconds: 0 },
      makeContext({ wait, poll }),
    )) as { status: string };

    expect(poll).toHaveBeenCalledWith("task-1");
    expect(wait).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
  });

  it("waitSeconds 透传成 timeoutMs", async () => {
    const wait = vi.fn(async () => snapshot("running"));
    await handler({ taskId: "task-1", waitSeconds: 30 }, makeContext({ wait, poll: vi.fn() }));
    expect(wait.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 30_000 });
  });

  it("旧执行端没有 wait 时退回轮询，直到收口", async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(snapshot("running"))
      .mockResolvedValueOnce(snapshot("completed"));
    const result = (await handler({ taskId: "task-1", waitSeconds: 5 }, makeContext({ poll }))) as {
      status: string;
    };
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("completed");
  });

  it("未知 taskId 报可恢复错误", async () => {
    const wait = vi.fn(async () => undefined);
    await expect(handler({ taskId: "nope" }, makeContext({ wait }))).rejects.toThrow(
      /未知的外部 agent 任务/,
    );
  });

  it("缺 taskId 时列任务，不等待", async () => {
    const list = vi.fn(async () => [snapshot("running")]);
    const wait = vi.fn();
    const result = (await handler({}, makeContext({ list, wait }))) as {
      tasks: Array<{ taskId: string }>;
    };
    expect(wait).not.toHaveBeenCalled();
    expect(result.tasks.map((task) => task.taskId)).toEqual(["task-1"]);
  });

  it("等过一轮仍在跑时，返回文案要说明「已经等过了」", () => {
    const text = entry.formatModelContent?.({
      taskId: "task-1",
      status: "running",
      durationMs: 61_000,
      waitedMs: 60_000,
    });
    expect(text).toContain("已等待 60s");
  });
});

describe("StartExternalAgentTask 的结果指引", () => {
  // 工具都是 shouldDefer（按需加载 schema），modelInstructions 在模型发起委派时
  // 不一定进过上下文——实测它仍然去 Bash sleep 45。下一步指令必须写在结果文本里。
  const format = startExternalAgentTaskToolEntry.formatModelContent;

  it("结果文本带下一步等待指令（工具名 + taskId + 不要 sleep）", () => {
    const text = format?.({ taskId: "ext_1", status: "running" });
    expect(text).toContain("GetExternalAgentTaskResult");
    expect(text).toContain("ext_1");
    expect(text).toMatch(/不要用 Bash sleep/);
  });

  it("handler 启动后台任务并返回 taskId", async () => {
    const start = vi.fn(async () => ({ taskId: "ext_9" }));
    const result = (await startExternalAgentTaskToolEntry.handler(
      { task: "做点事" },
      makeContext({ start }),
    )) as { taskId?: string; status?: string };
    expect(result).toEqual({ taskId: "ext_9", status: "running" });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
