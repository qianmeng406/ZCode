import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildDeterministicHandoffMarkdown,
  buildSessionHandoffPrompt,
  buildSessionHandoffTranscript,
} from "@zcode/shared/session-handoff";

let nextRowId = 1;

function base(kind: string) {
  return {
    rowId: nextRowId++,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind,
  };
}

function user(text: string): ConversationRow {
  return { ...base("userInput"), kind: "userInput", text, origin: "realUser" } as ConversationRow;
}

function assistant(text: string): ConversationRow {
  return {
    ...base("assistantText"),
    kind: "assistantText",
    text,
    state: "complete",
  } as ConversationRow;
}

function reasoning(text: string): ConversationRow {
  return { ...base("reasoning"), kind: "reasoning", text, state: "complete" } as ConversationRow;
}

function tool(name: string, inputText: string, outputPreview?: string): ConversationRow {
  return {
    ...base("toolCall"),
    kind: "toolCall",
    toolCallId: `call-${nextRowId}`,
    toolName: name,
    status: "success",
    inputText,
    ...(outputPreview ? { outputPreview: { text: outputPreview } } : {}),
  } as ConversationRow;
}

describe("session handoff transcript", () => {
  it("projects user, assistant and tool rows without reasoning", () => {
    const text = buildSessionHandoffTranscript([
      user("修复登录"),
      reasoning("内部推理不应出现"),
      assistant("已经定位到 auth.ts"),
      tool("Bash", '{"command":"pnpm test auth"}', "2 passed"),
    ]);
    expect(text).toContain("用户");
    expect(text).toContain("修复登录");
    expect(text).toContain("助手");
    expect(text).toContain("auth.ts");
    expect(text).toContain("pnpm test auth");
    expect(text).toContain("2 passed");
    expect(text).not.toContain("内部推理");
  });

  it("clips oversized user/assistant entries so one paste cannot own the budget", () => {
    const huge = "很长的日志".repeat(2000); // 10000 chars
    const text = buildSessionHandoffTranscript([user(huge), user("最近的请求")]);
    expect(text).toContain("很长的日志");
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain("最近的请求");
  });

  it("keeps tool entries compact: locate target only, no raw parameter JSON", () => {
    const text = buildSessionHandoffTranscript([
      tool(
        "Edit",
        '{"file_path":"src/a.ts","old_string":"const a = 1;","new_string":"const a = 2;"}',
      ),
    ]);
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain('"old_string"');
    expect(text).not.toContain('"new_string"');
  });

  it("drops earlier entries first when over budget", () => {
    const text = buildSessionHandoffTranscript(
      [user("很早的请求"), assistant("很早的回答"), user("最近的请求")],
      { maxChars: 25 },
    );
    expect(text).toContain("最近的请求");
    expect(text).toContain("更早的会话内容已省略");
    expect(text).not.toContain("很早的请求");
  });
});

describe("session handoff prompt and fallback", () => {
  it("asks for the fixed handoff sections", () => {
    const prompt = buildSessionHandoffPrompt("材料正文", "登录修复");
    expect(prompt).toContain("## 当前目标");
    expect(prompt).toContain("## 下一步");
    expect(prompt).toContain("登录修复");
    expect(prompt).toContain("材料正文");
  });

  it("builds a deterministic markdown with objective, tools and note", () => {
    const markdown = buildDeterministicHandoffMarkdown(
      [
        user("修复登录"),
        tool("Bash", '{"command":"pnpm test auth"}'),
        assistant("已修复"),
        user("再补一个回归测试"),
      ],
      "登录修复",
    );
    expect(markdown).toContain("# 会话交接：登录修复");
    expect(markdown).toContain("## 当前目标");
    expect(markdown).toContain("修复登录");
    expect(markdown).toContain("pnpm test auth");
    expect(markdown).toContain("## 下一步");
    expect(markdown).toContain("确定性模板");
  });
});
