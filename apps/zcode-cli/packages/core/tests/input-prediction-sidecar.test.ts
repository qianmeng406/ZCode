// 输入预测纯函数（注入指令 / 流过滤器 / 尾块解析 / 收敛决策）。
// 2026-11-01 重构：候选由主轮输出附带，sidecar 不再编排独立模型请求。
import { describe, expect, it } from "vitest";
import { v4ConversationInputPredictionResultSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  appendInputPredictionDirective,
  createNextInputStreamFilter,
  decideInputPrediction,
  isDirectiveEchoText,
  normalizeInputPredictionDraft,
  parseInputPredictionResponse,
  parseNextInputPredictionBlock,
  stripInjectedPredictionDirective,
  toInputPredictionSuffix,
  type InputPredictionModelMessage,
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

  it("丢弃指令回显型候选（线上事故：胶囊回显注入指令，接受后整段被当输入发出）", () => {
    const directive = [
      "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
      '<next_input>{"candidates":[{"text":"...","confidence":0.9}]}</next_input>',
      "- 每条 text 单行、不超过 40 字。",
    ].join("\n");
    expect(isDirectiveEchoText(directive)).toBe(true);
    expect(isDirectiveEchoText("<next_input>{}</next_input>")).toBe(true);
    expect(isDirectiveEchoText("<system-reminder>环境</system-reminder>")).toBe(true);
    expect(isDirectiveEchoText("帮我跑一下单测")).toBe(false);

    // decide 与 parse 两条入口都必须把它丢掉。
    expect(
      decideInputPrediction({
        rawCandidates: [
          { text: directive, confidence: 0.99 },
          { text: "帮我跑一下单测", confidence: 0.7 },
        ],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).candidates,
    ).toEqual([{ text: "帮我跑一下单测", confidence: 0.7 }]);
    expect(
      parseNextInputPredictionBlock(
        `正文<next_input>{"candidates":[{"text":"【输入预测】回复正文全部结束后","confidence":1}]}</next_input>`,
      ),
    ).toBeNull();
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

describe("appendInputPredictionDirective", () => {
  it("追加到最后一条 user message 的文本尾部", () => {
    const messages: InputPredictionModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "第一问" },
      { role: "assistant", content: "回答" },
      { role: "user", content: "第二问" },
    ];
    appendInputPredictionDirective(messages);
    expect(messages[3]!.content).toContain("第二问");
    expect(messages[3]!.content).toContain("<next_input>");
    // system 与 assistant 不受影响。
    expect(messages[0]!.content).toBe("system");
    expect(messages[2]!.content).toBe("回答");
  });

  it("没有 user message 时不做任何事", () => {
    const messages: InputPredictionModelMessage[] = [{ role: "system", content: "system" }];
    appendInputPredictionDirective(messages);
    expect(messages[0]!.content).toBe("system");
  });

  it("块数组 content（带图片附件）：指令进最后一个 text 块，图片块原样保留", () => {
    const imageBlock = { type: "image" as const, mediaType: "image/png", dataUrl: "data:png" };
    const messages: InputPredictionModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "看得到图片吗" }, imageBlock] },
    ];
    appendInputPredictionDirective(messages);
    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as { type: string; text?: string }[];
    // 不能被强转成 "[object Object]" 字符串。
    expect(typeof content).not.toBe("string");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe(imageBlock);
    expect(blocks[0]!.text).toContain("看得到图片吗");
    expect(blocks[0]!.text).toContain("<next_input>");
  });

  it("正文里已带指令副本时先剥掉再注入，只留末尾一份", () => {
    // 线上事故：指令原文本被当成用户输入发出（胶囊回显被接受 / 粘贴）。
    // 出站前必须清洗，否则指令会一轮轮堆进对话正文。
    const leaked = [
      "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
      '<next_input>{"candidates":[{"text":"...","confidence":0.9}]}</next_input>',
      "- 没有把握就少写几条，不要编造；预测块必须放在回复的最末尾，除此之外不要输出任何解释。",
    ].join("\n");
    const messages: InputPredictionModelMessage[] = [
      { role: "user", content: `帮我看看这个\n\n${leaked}\n\n${leaked}` },
    ];
    appendInputPredictionDirective(messages);
    const content = messages[0]!.content as string;
    expect(content).toContain("帮我看看这个");
    // 只保留一份指令（末尾注入的那份）。
    expect(content.split("【输入预测】").length - 1).toBe(1);
    expect(content).toContain("<next_input>");
  });

  it("清洗整个请求：历史消息里的指令副本也要剥掉", () => {
    // 线上：指令被当成用户消息发出后会留在历史里，继续一轮轮回放给模型。
    const leaked = [
      "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
      '<next_input>{"candidates":[]}</next_input>',
      "- 除此之外不要输出任何解释。",
    ].join("\n");
    const messages: InputPredictionModelMessage[] = [
      { role: "user", content: "第一条真实输入" },
      { role: "assistant", content: "回复" },
      { role: "user", content: leaked },
      { role: "user", content: "最新一条输入" },
    ];
    appendInputPredictionDirective(messages);
    // 历史里那条纯指令消息被清空，不再是 "指令文本"。
    expect(messages[2]!.content as string).not.toContain("【输入预测】");
    expect((messages[2]!.content as string).trim()).toBe("");
    // assistant 不受影响；真实用户正文保留。
    expect(messages[1]!.content).toBe("回复");
    expect(messages[0]!.content).toBe("第一条真实输入");
    // 最新一条仍带且只带一份规范指令。
    expect(messages[3]!.content).toContain("最新一条输入");
    expect((messages[3]!.content as string).split("【输入预测】").length - 1).toBe(1);
  });

  it("跳过尾部系统提醒，注入落到真实用户输入上", () => {
    // 线上统计 14/14 次都注到 <system-reminder> 环境提醒上（模型对着提醒做预测）。
    const messages: InputPredictionModelMessage[] = [
      { role: "user", content: "帮我修一下这个 bug" },
      {
        role: "user",
        content: "<system-reminder>\n# Environment update\ncwd 变了\n</system-reminder>",
      },
      { role: "user", content: "<system-reminder>\nTodoWrite reminder\n</system-reminder>" },
    ];
    appendInputPredictionDirective(messages);
    // 真实输入带上指令。
    expect(messages[0]!.content).toContain("帮我修一下这个 bug");
    expect((messages[0]!.content as string).split("【输入预测】").length - 1).toBe(1);
    // 提醒消息保持原样，不带指令。
    expect(messages[1]!.content).not.toContain("【输入预测】");
    expect(messages[2]!.content).not.toContain("【输入预测】");
  });

  it("纯指令消息被清洗后不再注入（避免造出无正文的预测请求）", () => {
    const leaked = [
      "【输入预测】回复正文全部结束后，另起一行输出一个预测块：",
      '<next_input>{"candidates":[]}</next_input>',
      "- 除此之外不要输出任何解释。",
    ].join("\n");
    const messages: InputPredictionModelMessage[] = [{ role: "user", content: leaked }];
    appendInputPredictionDirective(messages);
    expect((messages[0]!.content as string).trim()).toBe("");
  });

  it("stripInjectedPredictionDirective 只删标记段，不吞其它正文", () => {
    const withDirective =
      "前文\n\n【输入预测】回复正文全部结束后，另起一行输出一个预测块：\n<next_input>{}</next_input>\n- 除此之外不要输出任何解释。\n\n后文";
    const stripped = stripInjectedPredictionDirective(withDirective);
    expect(stripped).toBe("前文\n后文");
    // 没有标记的文本原样返回。
    expect(stripInjectedPredictionDirective("普通消息")).toBe("普通消息");
    // 只有起点没有终点：不猜边界，原样返回。
    expect(stripInjectedPredictionDirective("【输入预测】回复正文全部结束后……无终点")).toBe(
      "【输入预测】回复正文全部结束后……无终点",
    );
  });

  it("块数组没有 text 块时追加一个 text 块而不是拼接", () => {
    const imageBlock = { type: "image" as const, mediaType: "image/png", dataUrl: "data:png" };
    const messages: InputPredictionModelMessage[] = [{ role: "user", content: [imageBlock] }];
    appendInputPredictionDirective(messages);
    const blocks = messages[0]!.content as { type: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(imageBlock);
    expect(blocks[1]!.type).toBe("text");
    expect((blocks[1] as { text: string }).text).toContain("<next_input>");
  });
});

describe("createNextInputStreamFilter", () => {
  it("正常正文原样放行", () => {
    const filter = createNextInputStreamFilter();
    expect(filter.consume("今天")).toBe("今天");
    expect(filter.consume("天气不错")).toBe("天气不错");
    expect(filter.finish()).toBe("");
    expect(filter.fullText).toBe("今天天气不错");
  });

  it("预测块开标签之后的增量全部吞掉；扣住的前缀不闪现", () => {
    const filter = createNextInputStreamFilter();
    expect(filter.consume("回答正文")).toBe("回答正文");
    // 标签分片到达：扣住 `<next_in`，放行前面的正文。
    expect(filter.consume("结尾<next")).toBe("结尾");
    expect(filter.consume('_input>{"cand')).toBe("");
    expect(filter.consume('idates":[{"text":"下一","confidence":0.9}]}')).toBe("");
    expect(filter.finish()).toBe("");
    // 全文保留供解析。
    expect(filter.fullText).toBe(
      '回答正文结尾<next_input>{"candidates":[{"text":"下一","confidence":0.9}]}',
    );
  });

  it("正文恰好以标签前缀字符结尾时在 finish 冲出", () => {
    const filter = createNextInputStreamFilter();
    expect(filter.consume("结果 <n")).toBe("结果 ");
    expect(filter.finish()).toBe("<n");
    expect(filter.fullText).toBe("结果 <n");
  });
});

describe("parseNextInputPredictionBlock", () => {
  it("解析尾块并钳制置信度、去重、截到 3 条", () => {
    const full =
      '回复正文<next_input>{"candidates":[{"text":"提交","confidence":1.5},{"text":"提交","confidence":0.4},{"text":"看下日志","confidence":0.6}]}</next_input>';
    expect(parseNextInputPredictionBlock(full)).toEqual([
      { text: "提交", confidence: 1 },
      { text: "看下日志", confidence: 0.6 },
    ]);
  });

  it("无块或块损坏返回 null", () => {
    expect(parseNextInputPredictionBlock("没有块的回复")).toBeNull();
    expect(parseNextInputPredictionBlock("正文<next_input>不是 JSON</next_input>")).toBeNull();
    expect(
      parseNextInputPredictionBlock('正文<next_input>{"candidates":[]}</next_input>'),
    ).toBeNull();
  });
});

describe("normalizeInputPredictionDraft", () => {
  it("纯空白草稿视为无草稿", () => {
    expect(normalizeInputPredictionDraft("   ")).toBe("");
    expect(normalizeInputPredictionDraft(undefined)).toBe("");
    expect(normalizeInputPredictionDraft("帮我")).toBe("帮我");
  });
});
