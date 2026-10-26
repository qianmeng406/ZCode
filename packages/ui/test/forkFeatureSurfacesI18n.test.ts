import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

/**
 * fork 定制功能面（新设置分区 + 记忆编辑/沉淀/整理）的 i18n key 存在性护栏。
 *
 * locale 是 `Record<string, string>`，缺 key 不会 typecheck 报错，运行时直接把机器 key
 * 显示给用户（例如 CAS 冲突时显示 `settings.memory.editor.error.changed`）。这里扫描这
 * 几个文件里的字面量 key，要求中英两份都有；新增文案漏注册会直接失败。
 */
const SURFACES = [
  "src/settings/fork-features/ForkFeaturesSection.tsx",
  "src/settings/MemoryFileEditor.tsx",
  "src/settings/MemorySettingsViewer.tsx",
  "src/v4/memory/MemoryCaptureDialog.tsx",
  "src/v4/memory/memoryDreamResult.ts",
  "src/chat-input-toolbar/contextUsage.tsx",
] as const;

/** 只认值形态的 key 字面量（模板字符串拼接的动态后缀不会命中，避免误判）。 */
const KEY_LITERAL_PATTERN = /"((?:settings|chat|common)\.[A-Za-z0-9_.]+)"/g;

function collectKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(KEY_LITERAL_PATTERN)) {
    keys.add(match[1]!);
  }
  return [...keys].sort();
}

function readSurface(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

describe("fork feature surfaces i18n", () => {
  it.each(SURFACES)("%s 的文案 key 在中英 locale 都已注册", (surface) => {
    const keys = collectKeys(readSurface(surface));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => zhCN[key] === undefined)).toEqual([]);
    expect(keys.filter((key) => enUS[key] === undefined)).toEqual([]);
  });

  it("记忆编辑器把两种最常见的写入失败映射为已注册文案", () => {
    // 保存/删除失败的高频路径：并发改动（CAS）与超过 5 MiB 上限。
    for (const key of [
      "settings.memory.viewer.fileChanged",
      "settings.memory.viewer.fileTooLarge",
      "settings.memory.viewer.fileLoading",
    ]) {
      expect(zhCN[key], key).toBeTruthy();
      expect(enUS[key], key).toBeTruthy();
    }
  });
});
