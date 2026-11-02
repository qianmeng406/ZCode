// v4/conversation/inputPrediction 的 CLI 侧处理器。
// 2026-11-02 重构：候选由独立辅助请求生成（不再读主轮输出），
// 因此本测试覆盖：成本门禁、材料构建、模型返回解析、失败降级、缓存。
import { describe, expect, it, vi } from "vitest";
import { ConversationInputPredictionHandler } from "../src/zcode-protocol/input-prediction-handler.js";
import type { SessionTranscriptMessage } from "../src/session-transcript.js";

const user = (content: string): SessionTranscriptMessage => ({ role: "user", content });
const agent = (content: string): SessionTranscriptMessage => ({ role: "agent", content });

/** 两轮完整对话：过门禁的最小材料。 */
const transcript: SessionTranscriptMessage[] = [
  user("帮我修一下 lint 报错"),
  agent("已修复 3 处，需要跑测试吗？"),
  user("跑一下单测"),
  agent("全部通过。"),
];

const selection = {
  providerId: "p",
  modelId: "m",
  options: { reasoningLevel: "low" },
} as never;

function buildGate(overrides: { cacheReadTokens?: number; busy?: boolean; noSelection?: boolean }) {
  return {
    cacheReadTokens: overrides.cacheReadTokens ?? 12_000,
    busy: overrides.busy ?? false,
    ...(overrides.noSelection ? {} : { selection }),
  };
}

/** 默认依赖：门禁全过、模型返回一个候选。 */
function makeHandler(
  overrides: {
    gate?: Parameters<typeof buildGate>[0];
    generate?: () => Promise<{ text: string }>;
    transcript?: SessionTranscriptMessage[];
  } = {},
): { handler: ConversationInputPredictionHandler; generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(
    overrides.generate ??
      (async () => ({
        text: '{"candidates":[{"text":"跑一下全量测试","confidence":0.85}]}',
      })),
  );
  const handler = new ConversationInputPredictionHandler({
    loadTranscript: async () => overrides.transcript ?? transcript,
    readGate: () => buildGate(overrides.gate ?? {}),
    generate,
  });
  return { handler, generate };
}

describe("ConversationInputPredictionHandler（独立辅助请求）", () => {
  it("门禁通过：发一次请求并返回候选，回显 requestId", async () => {
    const { handler, generate } = makeHandler();
    await expect(
      handler.handle({ sessionId: "s", revision: 1, requestId: "req-1" }),
    ).resolves.toEqual({
      decision: "show",
      candidates: [{ text: "跑一下全量测试", confidence: 0.85 }],
      topConfidence: 0.85,
      requestId: "req-1",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0]![0] as {
      system: string;
      prompt: string;
      selection: unknown;
      sessionId: string;
    };
    expect(call.sessionId).toBe("s");
    expect(call.selection).toBe(selection);
    // 材料含最近轮次，系统提示要求 JSON 输出。
    expect(call.prompt).toContain("跑一下单测");
    expect(call.system).toContain("candidates");
  });

  it("缓存冷：不发请求（对齐 Claude Code 的跳过条件）", async () => {
    const { handler, generate } = makeHandler({ gate: { cacheReadTokens: 0 } });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_no_context",
      candidates: [],
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("会话正在执行：不发请求（上下文还在变）", async () => {
    const { handler, generate } = makeHandler({ gate: { busy: true } });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_no_context",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("材料不足两轮：不发请求", async () => {
    const { handler, generate } = makeHandler({
      transcript: [user("只有一轮"), agent("回复")],
    });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_no_context",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("没有可用模型：返回 unavailable 且不发请求", async () => {
    const { handler, generate } = makeHandler({ gate: { noSelection: true } });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "unavailable",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("会话不在内存：返回 unavailable", async () => {
    const handler = new ConversationInputPredictionHandler({
      loadTranscript: async () => [],
      readGate: () => null,
      generate: vi.fn(),
    });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "unavailable",
    });
  });

  it("模型请求失败：静默降级为 unavailable", async () => {
    const { handler } = makeHandler({
      generate: async () => {
        throw new Error("boom");
      },
    });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "unavailable",
    });
  });

  it("模型返回无法解析：suppress_below_threshold", async () => {
    const { handler } = makeHandler({ generate: async () => ({ text: "抱歉我无法预测" }) });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_below_threshold",
      candidates: [],
    });
  });

  it("草稿模式：只保留以草稿开头的候选并剥掉草稿前缀", async () => {
    const { handler } = makeHandler({
      generate: async () => ({
        text: '{"candidates":[{"text":"跑一下全量测试","confidence":0.9},{"text":"提交代码","confidence":0.9}]}',
      }),
    });
    const result = await handler.handle({ sessionId: "s", revision: 1, draft: "跑一下" });
    // 只留以草稿开头的候选，且剥掉草稿前缀（suffix 会 trimEnd，中间空格保留）。
    expect(result.candidates.map((item) => item.text)).toEqual(["全量测试"]);
  });

  it("同一 revision + 草稿命中缓存，不重复请求", async () => {
    const { handler, generate } = makeHandler();
    await handler.handle({ sessionId: "s", revision: 1 });
    await handler.handle({ sessionId: "s", revision: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("门禁跳过的结果不缓存：缓存转暖后能重新预测", async () => {
    let cacheReadTokens = 0;
    const generate = vi.fn(async () => ({
      text: '{"candidates":[{"text":"跑一下全量测试","confidence":0.85}]}',
    }));
    const handler = new ConversationInputPredictionHandler({
      loadTranscript: async () => transcript,
      readGate: () => ({ cacheReadTokens, busy: false, selection }),
      generate,
    });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_no_context",
    });
    cacheReadTokens = 9_000;
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "show",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("指令回显型候选被丢弃", async () => {
    const { handler } = makeHandler({
      generate: async () => ({
        text: '{"candidates":[{"text":"【输入预测】回复正文全部结束后","confidence":1}]}',
      }),
    });
    await expect(handler.handle({ sessionId: "s", revision: 1 })).resolves.toMatchObject({
      decision: "suppress_below_threshold",
      candidates: [],
    });
  });
});
