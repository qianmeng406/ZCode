import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { externalAgentActivitySchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * 活动帧的**冻结夹具**测试（借 herdr 的「冻结 fixture 不得为过测试而改」纪律）。
 *
 * 增量帧的 baseRevision / entriesFrom / trimmedEntries / sourceTruncated 是线上契约：
 * 收发两端在不同版本里跑着，字段语义不能靠"源码链路断言"兜住。这里用一份 JSON
 * 夹具同时钉两件事：
 * 1. 每一帧都能被 zod 契约解析（字段形状没被改掉）；
 * 2. 顺序喂给真实 ProductProjection 后，条目合并结果与夹具声明的期望一致
 *    （合并语义没被改掉）。
 *
 * 协议要演进时：新增帧，不要改旧帧——旧帧继续通过才说明向后兼容。
 */
interface ActivityFrame {
  name: string;
  activity: unknown;
  expect: {
    entries: string[];
    status: string;
    revision: number;
    trimmedEntries?: number;
    sourceTruncated?: boolean;
  };
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/external-agent-activity-frames.json", import.meta.url)),
    "utf8",
  ),
) as { frames: ActivityFrame[] };

function harness() {
  const projection = new ProductProjection("external-agent-activity-fixture", "epoch");
  let seq = 0;
  const apply = (activity: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "external-agent-activity-fixture",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq * 1_000),
      sequenceNumber: seq,
      type: SessionEventType.ExternalAgentActivityChanged,
      payload: { activity },
    } as SessionEvent);
  return { apply, current: () => projection.getSnapshot().externalAgentActivity ?? null };
}

describe("external agent activity frames (frozen fixture)", () => {
  it("每一帧都符合 zod 契约", () => {
    expect(fixture.frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of fixture.frames) {
      const parsed = externalAgentActivitySchema.safeParse(frame.activity);
      expect(parsed.success, `${frame.name}: ${parsed.success ? "" : parsed.error.message}`).toBe(
        true,
      );
    }
  });

  it("按顺序应用后条目/状态/裁剪标记与夹具声明一致", () => {
    const h = harness();
    for (const frame of fixture.frames) {
      h.apply(frame.activity);
      const current = h.current();
      expect(current, frame.name).not.toBeNull();
      expect(
        current?.entries?.map((entry) => entry.text),
        `${frame.name} entries`,
      ).toEqual(frame.expect.entries);
      expect(current?.status, `${frame.name} status`).toBe(frame.expect.status);
      expect(current?.revision, `${frame.name} revision`).toBe(frame.expect.revision);
      expect(current?.trimmedEntries, `${frame.name} trimmedEntries`).toBe(
        frame.expect.trimmedEntries,
      );
      if (frame.expect.sourceTruncated) {
        expect(current?.sourceTruncated, `${frame.name} sourceTruncated`).toBe(true);
      }
    }
  });
});
