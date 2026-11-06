import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * 外部 agent 活动快照的投影规则。
 *
 * 回归（2026-11-05 实测）：主 agent 用 GetExternalAgentTaskResult 轮询到终态时，
 * `publishExternalAgentTaskStatus` 会回写一份「只有 tail」的瘦快照（发它的工具
 * 上下文拿不到 reporter 攒下的 entries/model，taskId 也不同）。它不能覆盖
 * reporter 已收口的富记录，否则过程面板从结构化渲染跌回 raw tail 按行显示。
 */
function harness() {
  const projection = new ProductProjection("external-agent-activity", "epoch");
  let seq = 0;
  const apply = (activity: ExternalAgentActivity | null) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "external-agent-activity",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type: SessionEventType.ExternalAgentActivityChanged,
      payload: { activity },
    } as SessionEvent);
  const current = () => projection.getSnapshot().externalAgentActivity ?? null;
  return { apply, current };
}

const richSettled: ExternalAgentActivity = {
  taskId: "call-1",
  agentLabel: "CodeBuddy",
  model: "deepseek-v4.1-flash",
  status: "completed",
  startedAt: 1_000,
  elapsedMs: 55_000,
  entries: [
    { kind: "tool", text: "Bash: echo hi" },
    { kind: "text", text: "结论正文" },
  ],
};

const thinSettled: ExternalAgentActivity = {
  taskId: "ext_task-1",
  agentLabel: "CodeBuddy",
  status: "completed",
  startedAt: 900,
  elapsedMs: 55_000,
  tail: "…raw stdout tail",
};

describe("external agent activity projection", () => {
  it("瘦的轮询回写不覆盖已收口的富记录", () => {
    const h = harness();
    h.apply(richSettled);
    h.apply(thinSettled);
    expect(h.current()).toEqual(richSettled);
  });

  it("轮询回写带着一条最终正文时仍算瘦快照，不覆盖完整过程", () => {
    const h = harness();
    h.apply(richSettled);
    h.apply({
      ...thinSettled,
      entries: [{ kind: "text", text: "最终正文" }],
    });
    expect(h.current()).toEqual(richSettled);
  });

  it("previous 还在 running 时瘦快照照常写入（reporter 收口丢失的兜底）", () => {
    const h = harness();
    h.apply({ ...richSettled, status: "running", elapsedMs: 10_000 });
    h.apply(thinSettled);
    expect(h.current()).toEqual(thinSettled);
  });

  it("富快照（带 entries）的轮询回写仍然生效", () => {
    const h = harness();
    h.apply({ ...richSettled, status: "running", elapsedMs: 10_000 });
    h.apply(thinSettled);
    const withEntries: ExternalAgentActivity = {
      ...thinSettled,
      entries: [{ kind: "text", text: "收口时补的正文" }],
    };
    h.apply(withEntries);
    expect(h.current()).toEqual(withEntries);
  });

  it("previous 没有 entries/model 时瘦快照照常写入", () => {
    const h = harness();
    h.apply({ ...thinSettled, status: "running", tail: "进度" });
    h.apply(thinSettled);
    expect(h.current()).toEqual(thinSettled);
  });

  it("null 快照与 running 快照不受守卫影响", () => {
    const h = harness();
    h.apply(richSettled);
    h.apply(null);
    expect(h.current()).toBeNull();
    h.apply({ ...richSettled, status: "running", elapsedMs: 0 });
    expect(h.current()?.status).toBe("running");
  });

  it("增量帧按 entriesFrom 拼回条目（合并改写的最后一条也会覆盖）", () => {
    const h = harness();
    h.apply({
      ...richSettled,
      status: "running",
      entries: [{ kind: "text", text: "A" }],
      revision: 1,
    });
    // 追加一条工具行。
    h.apply({
      taskId: "call-1",
      agentLabel: "CodeBuddy",
      status: "running",
      startedAt: richSettled.startedAt,
      elapsedMs: 2_000,
      revision: 2,
      baseRevision: 1,
      entriesFrom: 1,
      entries: [{ kind: "tool", text: "Bash: ls" }],
    });
    expect(h.current()?.entries?.map((entry) => entry.text)).toEqual(["A", "Bash: ls"]);
    // 正文合并进首条：entriesFrom 回退到 0，片段必须带上 entriesFrom 之后的全部条目。
    h.apply({
      taskId: "call-1",
      agentLabel: "CodeBuddy",
      status: "running",
      startedAt: richSettled.startedAt,
      elapsedMs: 3_000,
      revision: 3,
      baseRevision: 2,
      entriesFrom: 0,
      entries: [
        { kind: "text", text: "AB" },
        { kind: "tool", text: "Bash: ls" },
      ],
    });
    expect(h.current()?.entries?.map((entry) => entry.text)).toEqual(["AB", "Bash: ls"]);
    expect(h.current()?.revision).toBe(3);
  });

  it("增量帧不带 prompt 时沿用上一次的任务正文（全量帧才下发它）", () => {
    const h = harness();
    h.apply({
      ...richSettled,
      status: "running",
      prompt: "修 lint",
      entries: [{ kind: "text", text: "A" }],
      revision: 1,
    });
    h.apply({
      taskId: "call-1",
      agentLabel: "CodeBuddy",
      status: "running",
      startedAt: richSettled.startedAt,
      elapsedMs: 2_000,
      revision: 2,
      baseRevision: 1,
      entriesFrom: 1,
      entries: [{ kind: "tool", text: "Bash: ls" }],
    });
    expect(h.current()?.prompt).toBe("修 lint");
    expect(h.current()?.entries?.map((entry) => entry.text)).toEqual(["A", "Bash: ls"]);
  });

  it("baseRevision 对不上时退化成追加，不丢已有过程", () => {
    const h = harness();
    h.apply({
      ...richSettled,
      status: "running",
      entries: [{ kind: "text", text: "A" }],
      revision: 5,
    });
    h.apply({
      taskId: "call-1",
      agentLabel: "CodeBuddy",
      status: "running",
      startedAt: richSettled.startedAt,
      elapsedMs: 2_000,
      revision: 6,
      baseRevision: 4,
      entriesFrom: 0,
      entries: [{ kind: "text", text: "B" }],
    });
    expect(h.current()?.entries?.map((entry) => entry.text)).toEqual(["A", "B"]);
  });

  it("无 baseRevision 的旧格式帧仍然整体替换", () => {
    const h = harness();
    h.apply({ ...richSettled, status: "running", entries: [{ kind: "text", text: "A" }] });
    h.apply({ ...richSettled, status: "running", entries: [{ kind: "text", text: "B" }] });
    expect(h.current()?.entries?.map((entry) => entry.text)).toEqual(["B"]);
  });

  // ── 冷恢复补发的「上次执行」摘要 ──
  const historical: ExternalAgentActivity = {
    taskId: "history_1700000000000",
    agentLabel: "CodeBuddy",
    model: "deepseek-v4.1-flash",
    status: "completed",
    startedAt: 1_699_999_000_000,
    elapsedMs: 61_000,
    historical: true,
    tail: "上次的结论",
    entries: [{ kind: "text", text: "上次的结论" }],
  };

  it("历史摘要不覆盖同一 UI 进程里更完整的已完成记录", () => {
    const h = harness();
    h.apply(richSettled);
    h.apply(historical);
    // 刚看完的过程比"上次执行"的摘要有价值，不能被它顶掉。
    expect(h.current()).toEqual(richSettled);
  });

  it("没有既有记录时历史摘要照常写入（重启后的回显）", () => {
    const h = harness();
    h.apply(historical);
    expect(h.current()).toEqual(historical);
  });

  it("历史摘要可以顶掉卡住的 running（进程已经没了）", () => {
    const h = harness();
    h.apply({ ...richSettled, status: "running", elapsedMs: 10_000 });
    h.apply(historical);
    expect(h.current()?.historical).toBe(true);
    expect(h.current()?.status).toBe("completed");
  });
});
