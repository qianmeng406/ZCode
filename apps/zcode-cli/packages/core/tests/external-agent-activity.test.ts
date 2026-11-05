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

  it("收口时用 result 全文补完最后一块流式正文（不追加重复）", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
    reporter.started({ label: "CodeBuddy" });

    // 流式正文被工具调用打断，最后一块停在半截 markdown。
    reporter.progress({ entries: [{ kind: "text", text: "正常运行，并且当前命中，说明从未" }] });
    reporter.settled({
      isError: false,
      durationMs: 1_000,
      text: "正常运行，并且当前命中，说明从未:3001 指向项目目录。\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    });

    const event = emitEvent.mock.calls.at(-1)?.[0] as unknown as {
      payload: { activity: { entries: Array<{ kind: string; text: string }>; status: string } };
    };
    const textEntries = event.payload.activity.entries.filter((entry) => entry.kind === "text");
    expect(textEntries).toHaveLength(1);
    expect(textEntries[0]?.text).toContain("| a | b |");
    expect(textEntries[0]?.text.startsWith("正常运行")).toBe(true);
  });

  it("result 解析失败退回 raw stdout（JSONL）时不拿它替换正文", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
    reporter.started({ label: "CodeBuddy" });

    const streamed = "已完成的结论正文";
    reporter.progress({ entries: [{ kind: "text", text: streamed }] });
    reporter.settled({
      isError: false,
      durationMs: 1_000,
      text: '{"type":"stream_event","event":{}}\n{"type":"result"}',
    });

    const event = emitEvent.mock.calls.at(-1)?.[0] as unknown as {
      payload: { activity: { entries: Array<{ kind: string; text: string }> } };
    };
    expect(event.payload.activity.entries.filter((entry) => entry.kind === "text")).toHaveLength(1);
    const textEntry = event.payload.activity.entries.find((entry) => entry.kind === "text");
    expect(textEntry?.text).toBe(streamed);
  });

  it("超出条目上限时记录 trimmedEntries，快照带上裁剪计数", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
    reporter.started({ label: "CodeBuddy" });

    const big = "x".repeat(120_000);
    reporter.progress({ entries: [{ kind: "text", text: big }] });
    reporter.progress({ entries: [{ kind: "tool", text: "Bash: ls" }] });
    reporter.progress({ entries: [{ kind: "text", text: big }] });
    // settled 是强制 emit：绕开 300ms 节流，读到的就是最终快照。
    reporter.settled({ isError: false, durationMs: 1 });

    const event = emitEvent.mock.calls.at(-1)?.[0] as unknown as {
      payload: { activity: { entries: unknown[]; trimmedEntries?: number } };
    };
    // 120k + 8 + 120k > 200k：第一条被裁，剩下工具行 + 第二段。
    expect(event.payload.activity.trimmedEntries).toBe(1);
    expect(event.payload.activity.entries).toHaveLength(2);
  });

  it("replaceEntries 整体替换执行中条目并清零裁剪计数", () => {
    const { context, emitEvent } = makeContext();
    const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
    reporter.started({ label: "CodeBuddy" });

    const big = "x".repeat(30_000);
    reporter.progress({ entries: [{ kind: "text", text: big }] });
    reporter.progress({ entries: [{ kind: "text", text: big }] });

    // 收口权威重建：全量 stdout 重解析出的条目整体替换，裁剪计数清零。
    // （replace 是强制 emit，绕开 300ms 节流，直接读它。）
    reporter.progress({
      replaceEntries: [
        { kind: "text", text: "第一段" },
        { kind: "tool", text: "Bash: ls src" },
        { kind: "text", text: "完整结论" },
      ],
    });

    const event = emitEvent.mock.calls.at(-1)?.[0] as unknown as {
      payload: {
        activity: {
          entries: Array<{ kind: string; text: string }>;
          trimmedEntries?: number;
          status: string;
          baseRevision?: number;
        };
      };
    };
    expect(event.payload.activity.trimmedEntries).toBeUndefined();
    expect(event.payload.activity.status).toBe("running");
    // 权威重建必须全量：增量帧没法表达"全部换掉"。
    expect(event.payload.activity.baseRevision).toBeUndefined();
    expect(event.payload.activity.entries.map((entry) => entry.text)).toEqual([
      "第一段",
      "Bash: ls src",
      "完整结论",
    ]);
  });

  it("执行中发增量帧：baseRevision + entriesFrom，合并改写的最后一条会被重发", () => {
    vi.useFakeTimers();
    try {
      const { context, emitEvent } = makeContext();
      const reporter = createExternalAgentActivityReporter(context, { agentLabel: "外部 agent" });
      type Frame = {
        revision?: number;
        baseRevision?: number;
        entriesFrom?: number;
        entries?: Array<{ kind: string; text: string }>;
        status: string;
      };
      const frame = (index: number) =>
        (emitEvent.mock.calls[index]?.[0] as unknown as { payload: { activity: Frame } }).payload
          .activity;

      reporter.started({ label: "CodeBuddy" });
      vi.advanceTimersByTime(350);
      reporter.progress({ entries: [{ kind: "text", text: "A" }] });
      vi.advanceTimersByTime(350);
      // 相邻同类正文合并进上一条 → 必须从第 0 条重发，否则接收方停在 "A"。
      reporter.progress({ entries: [{ kind: "text", text: "B" }] });
      vi.advanceTimersByTime(350);
      reporter.progress({ entries: [{ kind: "tool", text: "Bash: ls" }] });

      expect(frame(0)).toMatchObject({ status: "running", revision: 1 });
      expect(frame(0).baseRevision).toBeUndefined();
      expect(frame(1)).toMatchObject({
        revision: 2,
        baseRevision: 1,
        entriesFrom: 0,
        entries: [{ kind: "text", text: "A" }],
      });
      expect(frame(2)).toMatchObject({
        revision: 3,
        baseRevision: 2,
        entriesFrom: 0,
        entries: [{ kind: "text", text: "AB" }],
      });
      // 新工具行是追加：entriesFrom = 已发条目数，只带新增那一条。
      expect(frame(3)).toMatchObject({
        revision: 4,
        baseRevision: 3,
        entriesFrom: 1,
        entries: [{ kind: "tool", text: "Bash: ls" }],
      });

      // 收口一定发全量帧：丢过增量也能一次收敛。
      reporter.settled({ isError: false, durationMs: 1_000 });
      const final = frame(4);
      expect(final.status).toBe("completed");
      expect(final.baseRevision).toBeUndefined();
      expect(final.entries?.map((entry) => entry.text)).toEqual(["AB", "Bash: ls"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
