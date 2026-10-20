// 回归：会话执行环境弹窗/入口引用的 message id 必须两个 locale 都存在。
// 现场缺陷（历史）：校验返回的 error.userRequired 曾在 zh/en 词表缺失，弹窗把 key
// 原样红字显示；现在 user 已改为可选，仍要求所有引用 id 有译文且两语言键集合一致。
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

  it("用户留空合法：不再返回必填错误 id", () => {
    expect(validateSessionExecutionEnvironmentDraft("Ubuntu-24.04", "")).toBeNull();
  });

  it("文案体现 user 可选与默认用户语义，且两种语言键一致", () => {
    expect(zhCN["sessionExecutionEnvironment.user.label"]).toContain("可选");
    expect(enUS["sessionExecutionEnvironment.user.label"]).toContain("optional");
    expect(zhCN["sessionExecutionEnvironment.user.placeholder"]).toContain("留空");
    expect(enUS["sessionExecutionEnvironment.user.placeholder"]).toContain("Leave empty");
    expect(zhCN["sessionExecutionEnvironment.user.defaultHint"]).toBeTruthy();
    expect(enUS["sessionExecutionEnvironment.user.defaultHint"]).toBeTruthy();
    expect(zhCN["sessionExecutionEnvironment.user.defaultTag"]).toBeTruthy();
    expect(enUS["sessionExecutionEnvironment.user.defaultTag"]).toBeTruthy();
    // 入口需要同时表达“本机默认”和“点击切换”，不能只剩一个无状态 Linux 文本。
    expect(zhCN["sessionExecutionEnvironment.toolbar.local"]).toBeTruthy();
    expect(enUS["sessionExecutionEnvironment.toolbar.local"]).toBeTruthy();
    expect(zhCN["sessionExecutionEnvironment.toolbar.title"]).toBeTruthy();
    expect(enUS["sessionExecutionEnvironment.toolbar.title"]).toBeTruthy();
    // 左侧固定文案必须是中性标题：菜单会追加当前值，不能再带 “本机 Linux” 限定。
    expect(zhCN["sessionExecutionEnvironment.menu.label"]).toBe("执行环境");
    expect(enUS["sessionExecutionEnvironment.menu.label"]).toBe("Execution environment");
    // 读取中不能先显示“本机 Windows”（会让 WSL 会话短暂误示），需要中性占位文案。
    expect(zhCN["sessionExecutionEnvironment.toolbar.loading"]).toBeTruthy();
    expect(enUS["sessionExecutionEnvironment.toolbar.loading"]).toBeTruthy();
  });

  it("已选发行版且用户名合法时不再报错", () => {
    expect(validateSessionExecutionEnvironmentDraft("Ubuntu-24.04", "zcodewslp2")).toBeNull();
    expect(validateSessionExecutionEnvironmentDraft("", "")).toBeNull();
  });
});
