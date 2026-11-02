// 输入预测纯函数（JSON 容错解析 / 续写收敛 / 去重 / 决策门槛）。
// 2026-11-02 重构：候选由独立辅助请求生成，不再向主轮对话注入指令，
// 因此注入/流过滤/尾块解析相关用例已随实现一起删除。
import { describe, expect, it } from "vitest";
import { v4ConversationInputPredictionResultSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  decideInputPrediction,
  isDirectiveEchoText,
  normalizeInputPredictionDraft,
  parseInputPredictionResponse,
  toInputPredictionSuffix,
} from "../src/runtime/methods/input-prediction-sidecar.js";

const turns: { userText: string; assistantText: string | null }[] = [
  { userText: "帮我看下 lint 报错", assistantText: "已修复 3 处" },
  { userText: "再跑一遍单测", assistantText: "全部通过" },
];

describe("parseInputPredictionResponse", () => {
  it("解析纯 JSON", () => {
    expect(
      parseInputPredictionResponse('{"candidates":[{"text":"提交吧","confidence":0.9}]}'),
    ).toEqual([{ text: "提交吧", confidence: 0.9 }]);
  });

  it("容忍 think 段、code fence、尾逗号与前后说明", () => {
    const raw =
      '<think>想一想</think>\n```json\n{"candidates":[{"text":"提交吧","confidence":0.9},]}\n```';
    expect(parseInputPredictionResponse(raw)).toEqual([{ text: "提交吧", confidence: 0.9 }]);
    expect(
      parseInputPredictionResponse('结果如下：{"candidates":[{"text":"好","confidence":0.5}]} 完'),
    ).toEqual([{ text: "好", confidence: 0.5 }]);
  });

  it("结构不对或没有有效候选时返回 null", () => {
    expect(parseInputPredictionResponse("不是 JSON")).toBeNull();
    expect(parseInputPredictionResponse('{"candidates":[]}')).toBeNull();
    expect(parseInputPredictionResponse('{"candidates":[{"text":1,"confidence":0.9}]}')).toBeNull();
    expect(parseInputPredictionResponse("[]")).toBeNull();
  });
});

describe("toInputPredictionSuffix", () => {
  it("无草稿时单行化并两端 trim", () => {
    expect(toInputPredictionSuffix("  提交\n代码  ", "")).toBe("提交 代码");
  });

  it("有草稿时剥掉模型重复的草稿前缀，保留续写开头的空格", () => {
    expect(toInputPredictionSuffix("run the tests", "run the")).toBe(" tests");
    expect(toInputPredictionSuffix(" tests  ", "run the")).toBe(" tests");
  });

  it("草稿以空白结尾时续写不再以空白开头", () => {
    expect(toInputPredictionSuffix("run the tests", "run the ")).toBe("tests");
    expect(toInputPredictionSuffix("  tests", "run the ")).toBe("tests");
  });

  it("按 UTF-16 长度截断到 40，不劈开代理对", () => {
    const long = "好".repeat(50);
    expect(toInputPredictionSuffix(long, "")).toHaveLength(40);
    const emoji = "😀".repeat(30);
    const bounded = toInputPredictionSuffix(emoji, "");
    expect(bounded.length).toBeLessThanOrEqual(40);
    expect(bounded).toBe("😀".repeat(20));
  });
});

describe("decideInputPrediction", () => {
  it("去掉与最近用户输入重复的、候选间重复的，按置信度降序取前 3", () => {
    const outcome = decideInputPrediction({
      rawCandidates: [
        { text: "再跑一遍 单测", confidence: 0.99 },
        { text: "提交代码", confidence: 0.7 },
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
        { text: "合并", confidence: 0.4 },
        { text: "   ", confidence: 0.95 },
      ],
      draft: "",
      recentUserInputs: turns.map((turn) => turn.userText),
      turnCount: 2,
    });
    expect(outcome).toEqual({
      decision: "show",
      candidates: [
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
      ],
      topConfidence: 0.85,
    });
    expect(
      v4ConversationInputPredictionResultSchema.safeParse({ ...outcome, requestId: "r" }).success,
    ).toBe(true);
  });

  it("top 置信度不到门槛时 suppress_below_threshold；置信度被夹到 0..1", () => {
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 0.59 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).decision,
    ).toBe("suppress_below_threshold");
    // 0.7 这种诚实校准分（GLM 日常水平）应能展示，不再被 0.8 旧门槛全压掉。
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 0.7 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).decision,
    ).toBe("show");
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 3 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }),
    ).toMatchObject({ decision: "show", topConfidence: 1 });
  });

  it("丢弃指令回显型候选（模型把提示词原样复述成「用户会说的话」）", () => {
    const echo = [
      "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
      '<next_input>{"candidates":[{"text":"...","confidence":0.9}]}</next_input>',
    ].join("\n");
    expect(isDirectiveEchoText(echo)).toBe(true);
    expect(isDirectiveEchoText("<next_input>{}</next_input>")).toBe(true);
    expect(isDirectiveEchoText("<system-reminder>环境</system-reminder>")).toBe(true);
    expect(isDirectiveEchoText("帮我跑一下单测")).toBe(false);

    expect(
      decideInputPrediction({
        rawCandidates: [
          { text: echo, confidence: 0.99 },
          { text: "帮我跑一下单测", confidence: 0.7 },
        ],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).candidates,
    ).toEqual([{ text: "帮我跑一下单测", confidence: 0.7 }]);
  });

  it("草稿模式按「草稿 + 续写」与最近输入去重", () => {
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "单测", confidence: 0.9 }],
        draft: "再跑一遍",
        recentUserInputs: ["再跑一遍单测"],
        turnCount: 1,
      }).candidates,
    ).toEqual([]);
  });
});

describe("normalizeInputPredictionDraft", () => {
  it("纯空白草稿视为无草稿", () => {
    expect(normalizeInputPredictionDraft("   ")).toBe("");
    expect(normalizeInputPredictionDraft(undefined)).toBe("");
    expect(normalizeInputPredictionDraft("帮我")).toBe("帮我");
  });
});
