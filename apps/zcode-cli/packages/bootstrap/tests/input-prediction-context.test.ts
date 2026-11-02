// input-prediction-context：最近 N 轮材料抽取。
// 输入预测改为独立辅助请求后，材料由本模块从会话转录裁剪，必须保证
// 轮次划分正确、单条与总量截断可控、且不把落单的助手消息算成一整轮。
import { describe, expect, it } from "vitest";
import {
  buildRecentTurnsTranscript,
  INPUT_PREDICTION_MATERIAL_MESSAGE_CHARS,
  INPUT_PREDICTION_MATERIAL_TURNS,
} from "../src/zcode-protocol/input-prediction-context.js";
import type { SessionTranscriptMessage } from "../src/session-transcript.js";

const user = (content: string): SessionTranscriptMessage => ({ role: "user", content });
const agent = (content: string): SessionTranscriptMessage => ({ role: "agent", content });

describe("buildRecentTurnsTranscript", () => {
  it("按 user 消息切轮并只保留最近 3 轮", () => {
    const transcript = [
      user("第一轮请求"),
      agent("第一轮回复"),
      user("第二轮请求"),
      agent("第二轮回复"),
      user("第三轮请求"),
      agent("第三轮回复"),
      user("第四轮请求"),
      agent("第四轮回复"),
    ];
    const result = buildRecentTurnsTranscript(transcript);
    expect(result.turnCount).toBe(INPUT_PREDICTION_MATERIAL_TURNS);
    // 第一轮被窗口裁掉。
    expect(result.text).not.toContain("第一轮请求");
    expect(result.text).toContain("第二轮请求");
    expect(result.text).toContain("第四轮回复");
    expect(result.text).toContain("### 用户");
    expect(result.text).toContain("### 助手");
  });

  it("丢弃落单的助手消息（会话开头没有 user 的回复不构成一轮）", () => {
    const result = buildRecentTurnsTranscript([
      agent("孤立回复"),
      user("真实请求"),
      agent("真实回复"),
    ]);
    expect(result.text).not.toContain("孤立回复");
    expect(result.turnCount).toBe(1);
  });

  it("单条消息按上限截断", () => {
    const long = "甲".repeat(INPUT_PREDICTION_MATERIAL_MESSAGE_CHARS + 500);
    const result = buildRecentTurnsTranscript([user(long), agent("好")]);
    expect(result.text).toContain("…");
    expect(result.text.length).toBeLessThan(long.length);
  });

  it("总量超限时保留最近的轮次并写明省略", () => {
    const block = "乙".repeat(2_500);
    const result = buildRecentTurnsTranscript(
      [user(block), agent(block), user(block), agent(block)],
      { maxTotalChars: 3_000 },
    );
    expect(result.text).toContain("更早内容已省略");
    // 最新一轮一定保留。
    expect(result.turnCount).toBeGreaterThanOrEqual(1);
  });

  it("空转录返回空材料且轮数为 0", () => {
    expect(buildRecentTurnsTranscript([])).toEqual({ text: "", turnCount: 0 });
    expect(buildRecentTurnsTranscript([user("   ")])).toEqual({ text: "", turnCount: 0 });
  });
});
