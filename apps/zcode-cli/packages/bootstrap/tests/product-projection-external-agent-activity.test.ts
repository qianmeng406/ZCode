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
});
