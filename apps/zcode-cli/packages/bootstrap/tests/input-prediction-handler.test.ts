// v4/conversation/inputPrediction 的 CLI 侧处理器（手机远控 ghost hint + 桌面候选胶囊）。
// 2026-11-01 重构：候选由主轮输出附带并存入 runtime；本处理器只读存量并按草稿过滤。
import { describe, expect, it, vi } from "vitest";
import {
  ConversationInputPredictionHandler,
  type StoredInputPrediction,
} from "../src/zcode-protocol/input-prediction-handler.js";

const candidates = [
  { text: "提交代码", confidence: 0.9 },
  { text: "跑一下单测", confidence: 0.7 },
  { text: "继续", confidence: 0.4 },
];

function prediction(overrides: Partial<StoredInputPrediction> = {}): StoredInputPrediction {
  return { candidates, completedAt: 1, ...overrides };
}

describe("ConversationInputPredictionHandler（存量读取）", () => {
  it("draft 为空：返回存量候选并回显 requestId", async () => {
    const handler = new ConversationInputPredictionHandler({
      getLastPrediction: () => prediction(),
    });
    await expect(handler.handle({ sessionId: "s", revision: 1, requestId: "a" })).resolves.toEqual({
      decision: "show",
      candidates: [
        { text: "提交代码", confidence: 0.9 },
        { text: "跑一下单测", confidence: 0.7 },
        { text: "继续", confidence: 0.4 },
      ],
      topConfidence: 0.9,
      requestId: "a",
    });
  });

  it("draft 非空：按草稿前缀过滤，只回余下部分；无命中回 suppress", async () => {
    const handler = new ConversationInputPredictionHandler({
      getLastPrediction: () => prediction(),
    });
    await expect(
      handler.handle({ sessionId: "s", revision: 1, draft: "提交" }),
    ).resolves.toMatchObject({
      decision: "show",
      candidates: [{ text: "代码", confidence: 0.9 }],
    });
    // 非前缀候选在续写模式下一律丢弃（不能把整条别的输入接在草稿后面）。
    // 前缀把候选削成空文本：不展示。
    await expect(
      handler.handle({ sessionId: "s", revision: 1, draft: "提交代码" }),
    ).resolves.toMatchObject({ decision: "suppress_below_threshold", candidates: [] });
  });

  it("runtime 缺席 → unavailable；全候选置信度过低 → suppress_below_threshold", async () => {
    const missing = new ConversationInputPredictionHandler({ getLastPrediction: () => null });
    await expect(missing.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "unavailable",
    });
    const weak = new ConversationInputPredictionHandler({
      getLastPrediction: () => prediction({ candidates: [{ text: "继续", confidence: 0.4 }] }),
    });
    await expect(weak.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "suppress_below_threshold",
    });
  });

  it("getLastPrediction 抛错 → unavailable 且不缓存（下次重查）", async () => {
    let fail = true;
    const warn = vi.fn();
    const handler = new ConversationInputPredictionHandler({
      getLastPrediction: () => {
        if (fail) throw new Error("runtime gone");
        return prediction();
      },
      logger: { warn } as unknown as ConstructorParameters<
        typeof ConversationInputPredictionHandler
      >[0]["logger"],
    });
    await expect(handler.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "unavailable",
    });
    fail = false;
    await expect(handler.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "show",
    });
    // unavailable 不写缓存；warn 记录不含草稿/会话内容。
    expect(JSON.stringify(warn.mock.calls)).not.toContain("draft");
  });

  it("LRU 缓存：同 (session, revision, draft) 命中不再回源；跨 draft 不串", async () => {
    const getLastPrediction = vi.fn(() => prediction());
    const handler = new ConversationInputPredictionHandler({ getLastPrediction });
    await handler.handle({ sessionId: "s", revision: 1, requestId: "a" });
    await handler.handle({ sessionId: "s", revision: 1, requestId: "b" });
    expect(getLastPrediction).toHaveBeenCalledTimes(1);
    await handler.handle({ sessionId: "s", revision: 1, draft: "提交" });
    expect(getLastPrediction).toHaveBeenCalledTimes(2);
  });

  it("非法参数直接抛错（strict schema）", async () => {
    const handler = new ConversationInputPredictionHandler({ getLastPrediction: () => null });
    await expect(handler.handle({ sessionId: "s" })).rejects.toThrow();
    await expect(handler.handle({ sessionId: "s", revision: 0, extra: 1 })).rejects.toThrow();
  });

  it("dispose 清空缓存", async () => {
    const getLastPrediction = vi.fn(() => prediction());
    const handler = new ConversationInputPredictionHandler({ getLastPrediction });
    await handler.handle({ sessionId: "s", revision: 1 });
    handler.dispose(new Error("disconnected"));
    await handler.handle({ sessionId: "s", revision: 1 });
    expect(getLastPrediction).toHaveBeenCalledTimes(2);
  });
});
