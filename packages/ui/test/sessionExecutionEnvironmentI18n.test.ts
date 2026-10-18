// 回归：会话执行环境弹窗引用的 message id 必须两个 locale 都存在。
// 现场缺陷：校验返回 sessionExecutionEnvironment.error.userRequired，但 zh/en 词表都没有该键，
// 弹窗把 key 原样红字显示（useIntl 缺键回退 id），比“必填”本身更难懂。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { validateSessionExecutionEnvironmentDraft } from "@/hooks/useSessionExecutionEnvironment.js";

const SOURCE_FILES = [
  "../src/SessionExecutionEnvironmentDialog.tsx",
  "../src/hooks/useSessionExecutionEnvironment.ts",
  "../src/WorkspaceHeaderSections.tsx",
] as const;

function collectReferencedMessageIds(): string[] {
  const ids = new Set<string>();
  for (const relativePath of SOURCE_FILES) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    for (const match of source.matchAll(
      /["'`](sessionExecutionEnvironment\.[A-Za-z0-9_.]+)["'`]/g,
    )) {
      ids.add(match[1]);
    }
  }
  return [...ids].sort();
}

describe("SessionExecutionEnvironment i18n", () => {
  it("弹窗引用的每个 message id 在 zh-CN / en-US 都有译文", () => {
    const missing: string[] = [];
    for (const id of collectReferencedMessageIds()) {
      if (!(id in zhCN)) missing.push(`zh-CN:${id}`);
      if (!(id in enUS)) missing.push(`en-US:${id}`);
    }
    expect(missing).toEqual([]);
  });

  it("两个 locale 的 sessionExecutionEnvironment 键集合一致（避免单侧缺键）", () => {
    const keySet = (messages: Record<string, string>) =>
      Object.keys(messages)
        .filter((id) => id.startsWith("sessionExecutionEnvironment."))
        .sort();
    expect(keySet(enUS)).toEqual(keySet(zhCN));
  });

  it("显式用户必填：校验结果落到已翻译文案，不回退 key 原文", () => {
    const userRequired = validateSessionExecutionEnvironmentDraft("Ubuntu-24.04", "");
    expect(userRequired).toBe("sessionExecutionEnvironment.error.userRequired");
    // 校验返回的是 id，展示层必须能查到译文，否则 UI 会显示 id 本身。
    expect(zhCN[userRequired as keyof typeof zhCN]).toBeTruthy();
    expect(enUS[userRequired as keyof typeof enUS]).toBeTruthy();
    expect(zhCN[userRequired as keyof typeof zhCN]).not.toBe(userRequired);
  });

  it("文案与 spec 显式 distro/user 口径一致：用户字段不再标可选", () => {
    expect(zhCN["sessionExecutionEnvironment.user.label"]).toBe("Linux 用户");
    expect(enUS["sessionExecutionEnvironment.user.label"]).toBe("Linux user");
    expect(zhCN["sessionExecutionEnvironment.user.placeholder"]).not.toContain("留空");
    expect(enUS["sessionExecutionEnvironment.user.placeholder"]).not.toContain("Leave empty");
    expect(
      zhCN["sessionExecutionEnvironment.action.explicitRequiredHint" as keyof typeof zhCN],
    ).toBeTruthy();
    expect(
      enUS["sessionExecutionEnvironment.action.explicitRequiredHint" as keyof typeof enUS],
    ).toBeTruthy();
  });

  it("已选发行版且用户名合法时不再报错", () => {
    expect(validateSessionExecutionEnvironmentDraft("Ubuntu-24.04", "zcodewslp2")).toBeNull();
    expect(validateSessionExecutionEnvironmentDraft("", "")).toBeNull();
  });
});
