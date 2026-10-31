import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 合并 3.17.1 事故的源码级护栏：上游删掉了 `text` state，但 fork 的提示词优化器
// 仍逐字比较草稿。合并后两者同时存在却没人写 `text`，导致 hasText 恒为 false，
// 纯文本草稿的发送键永远 disabled（只有附件等其它草稿内容能绕过）。
const source = readFileSync(resolve("packages/ui/src/v4/ConversationComposer.tsx"), "utf8");

describe("ConversationComposer send gate", () => {
  it("derives hasText from editor presence instead of a stale local state", () => {
    expect(source).toContain("const hasText = textPresence.trimmed;");
    expect(source).not.toContain("const hasText = text.trim().length > 0;");
  });

  it("keeps the draft state in sync on every editor change", () => {
    expect(source).toMatch(/textRef\.current = next;[\s\S]{0,400}?setText\(next\);/);
  });
});
