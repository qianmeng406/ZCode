import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentTranscriptEntry } from "@zcode/shared";
import {
  externalAgentTranscriptKey,
  getExternalAgentTranscriptState,
  loadExternalAgentTranscript,
  registerExternalAgentTranscriptLoader,
  resetExternalAgentTranscript,
} from "@/v4/externalAgent/externalAgentTranscriptStore.js";

function entry(text: string): ExternalAgentTranscriptEntry {
  return { kind: "user", text };
}

/** 造一个"共 total 条、可向前翻页"的 loader。 */
function pagedLoader(total: number) {
  return vi.fn(async (input: { before?: number; limit?: number }) => {
    const limit = input.limit ?? 30;
    const before = Math.min(input.before ?? total, total);
    const start = Math.max(0, before - limit);
    return {
      entries: Array.from({ length: before - start }, (_, index) =>
        entry(`第 ${start + index + 1} 条`),
      ),
      total,
      hasMore: start > 0,
      truncated: false,
    };
  });
}

describe("externalAgentTranscriptStore", () => {
  it("首次加载读最新一页，「加载更早」向前翻页且不重复", async () => {
    const key = externalAgentTranscriptKey("s1", "ext-1");
    const loader = pagedLoader(70);
    registerExternalAgentTranscriptLoader(key, loader);

    await loadExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).entries.map((e) => e.text)).toEqual(
      Array.from({ length: 30 }, (_, i) => `第 ${41 + i} 条`),
    );
    expect(getExternalAgentTranscriptState(key).hasMore).toBe(true);

    await loadExternalAgentTranscript(key);
    const state = getExternalAgentTranscriptState(key);
    expect(state.entries).toHaveLength(60);
    expect(state.entries[0]?.text).toBe("第 11 条");
    expect(state.entries.at(-1)?.text).toBe("第 70 条");
    // 第二次读的 before = 第一次窗口的第一条（0 基 40）。
    expect(loader.mock.calls[1]?.[0]).toMatchObject({ before: 40 });
  });

  it("累计上限 300 条：到顶后不再提供翻页", async () => {
    const key = externalAgentTranscriptKey("s2", "ext-2");
    registerExternalAgentTranscriptLoader(key, pagedLoader(1000));
    // 30 条/页 → 11 页才 330；第 10 页 300 条时停。
    for (let index = 0; index < 12; index += 1) {
      await loadExternalAgentTranscript(key);
    }
    const state = getExternalAgentTranscriptState(key);
    expect(state.entries.length).toBeLessThanOrEqual(300);
    expect(state.hasMore).toBe(false);
  });

  it("读取失败记录 error，不清空已加载内容", async () => {
    const key = externalAgentTranscriptKey("s3", "ext-3");
    registerExternalAgentTranscriptLoader(key, async () => {
      throw new Error("boom");
    });
    await loadExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).error).toBe("boom");
    expect(getExternalAgentTranscriptState(key).loaded).toBe(false);
  });

  it("内容截断标记透传（源文件过大只读尾部）", async () => {
    const key = externalAgentTranscriptKey("s4", "ext-4");
    registerExternalAgentTranscriptLoader(key, async () => ({
      entries: [entry("尾部")],
      total: 1,
      hasMore: false,
      truncated: true,
    }));
    await loadExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).truncated).toBe(true);
  });

  it("reset 清掉缓存（重新打开会重读）", async () => {
    const key = externalAgentTranscriptKey("s5", "ext-5");
    const loader = pagedLoader(5);
    registerExternalAgentTranscriptLoader(key, loader);
    await loadExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).loaded).toBe(true);
    resetExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).loaded).toBe(false);
  });

  it("没有注册 loader 时不发起请求、也不报错", async () => {
    const key = externalAgentTranscriptKey("s6", "ext-6");
    await loadExternalAgentTranscript(key);
    expect(getExternalAgentTranscriptState(key).loaded).toBe(false);
    expect(getExternalAgentTranscriptState(key).error).toBeNull();
  });
});
