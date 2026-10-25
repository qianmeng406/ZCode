// 流式 markdown 增量分块器（markdown-streaming-chunks.ts）的行为契约：
// 1. 拼接不变量：split(text).join("") === text（任何输入）；
// 2. 与 Streamdown 默认整篇切块的 parity：追加式前缀序列上，增量分块结果与
//    parseMarkdownIntoBlocks(全文) 深度相等（Block memo 生效的前提）；
// 3. 尾部保护：未闭合围栏/列表/$$/引用等始终留在未提交尾部；
// 4. 非前缀变化与脚注：重置为整篇单块/整篇切块，正确性不受影响。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseMarkdownIntoBlocks } from "streamdown";

import { MessageResponse } from "@/components/ai-elements/message.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { createIncrementalMarkdownSplitter } from "@/components/ai-elements/markdown-streaming-chunks.js";

// 与 messageResponseStreamdownMode.test.ts 相同的服务端渲染环境（CodeBlock 需要
// intl provider；store/platform 走 mock）。
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "zai-light",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
  useOptionalPlatform: () => ({
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

/** 模拟流式到达：对完整文档按若干切点产生前缀序列。 */
function prefixesOf(document: string, cutPoints: number[]): string[] {
  return cutPoints.map((cut) => document.slice(0, cut));
}

describe("createIncrementalMarkdownSplitter", () => {
  it("拼接不变量：任何输入下 split(text).join('') === text", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const document = [
      "# 标题",
      "",
      "第一段文本，包含 **加粗** 与 `code`。",
      "",
      "- 列表项 A",
      "- 列表项 B",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "收尾段落。",
    ].join("\n");
    for (const prefix of prefixesOf(document, [5, 20, 45, 80, 120, document.length])) {
      const chunks = splitter.split(prefix);
      expect(chunks.join("")).toBe(prefix);
    }
  });

  it("追加式 parity：增量分块与整篇切块深度相等，且稳定块内容不变", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const document = [
      "开头段落。",
      "",
      "## 小节",
      "",
      "小节正文第一段。",
      "",
      "小节正文第二段。",
      "",
      "- 项目一",
      "- 项目二",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "结尾段落。",
    ].join("\n");
    let previousStable: string[] = [];
    for (const prefix of prefixesOf(document, [10, 30, 60, 90, 130, document.length])) {
      const chunks = splitter.split(prefix);
      expect(chunks).toEqual(parseMarkdownIntoBlocks(prefix));
      // 已提交前缀对应的块内容在后续追加中保持不变（Block memo 命中条件）。
      const stableCount = splitter.committedLength;
      let consumed = 0;
      const stableChunks: string[] = [];
      for (const chunk of chunks) {
        if (consumed >= stableCount) break;
        stableChunks.push(chunk);
        consumed += chunk.length;
      }
      if (previousStable.length > 0) {
        expect(stableChunks.slice(0, previousStable.length)).toEqual(previousStable);
      }
      previousStable = stableChunks;
    }
  });

  it("尾部保护：未闭合围栏留在尾部块，且稳定段落不被它牵连", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const chunks1 = splitter.split("第一段。\n\n第二段。\n\n```ts\nconst a = 1;");
    // “第一段/第二段”后面出现了真实块（围栏），可提交；围栏（未闭合）保持为尾块。
    expect(chunks1.length).toBeGreaterThanOrEqual(3);
    expect(chunks1.at(-1)).toContain("```ts");
    const chunks2 = splitter.split("第一段。\n\n第二段。\n\n```ts\nconst a = 1;\nconst b = 2;");
    expect(chunks2.at(-1)).toContain("const b = 2;");
    // 前两个稳定块在追加后内容不变。
    expect(chunks2[0]).toBe(chunks1[0]);
    expect(chunks2[1]).toBe(chunks1[1]);
    expect(chunks2.join("")).toBe("第一段。\n\n第二段。\n\n```ts\nconst a = 1;\nconst b = 2;");
  });

  it("尾部保护：宽松列表/有序列表跨空行不会被提前提交拆散", () => {
    const splitter = createIncrementalMarkdownSplitter();
    // t1 的列表是最后一个真实块：不提交；t2 追加第二项后整表重解析为一个块。
    const chunks1 = splitter.split("引导段。\n\n- 项目一");
    expect(chunks1.at(-1)).toBe("- 项目一");
    const chunks2 = splitter.split("引导段。\n\n- 项目一\n\n- 项目二");
    expect(chunks2).toEqual(parseMarkdownIntoBlocks("引导段。\n\n- 项目一\n\n- 项目二"));
    const ordered = splitter.split("引导段。\n\n1. 步骤一\n\n2. 步骤二");
    expect(ordered).toEqual(parseMarkdownIntoBlocks("引导段。\n\n1. 步骤一\n\n2. 步骤二"));
  });

  it("尾部保护：$$ 数学块与引用块保持在尾部", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const math = splitter.split("前文。\n\n$$\nE = mc^2\n$$\n\n后文。\n\n$$\na+b");
    expect(math.join("")).toContain("a+b");
    expect(math).toEqual(
      parseMarkdownIntoBlocks("前文。\n\n$$\nE = mc^2\n$$\n\n后文。\n\n$$\na+b"),
    );
    const quote = createIncrementalMarkdownSplitter();
    const quoted = quote.split("前文。\n\n> 引用一\n>\n> 引用二");
    expect(quoted).toEqual(parseMarkdownIntoBlocks("前文。\n\n> 引用一\n>\n> 引用二"));
  });

  it("脚注：出现 [^id] 时重置为整篇单块", () => {
    const splitter = createIncrementalMarkdownSplitter();
    splitter.split("段落一。\n\n段落二。");
    expect(splitter.committedLength).toBeGreaterThan(0);
    const withFootnote = splitter.split(
      "段落一。\n\n段落二。\n\n正文里的脚注[^1]。\n\n[^1]: 定义。",
    );
    expect(splitter.committedLength).toBe(0);
    expect(withFootnote).toEqual(["段落一。\n\n段落二。\n\n正文里的脚注[^1]。\n\n[^1]: 定义。"]);
  });

  it("非前缀变化（改写/截断）：重置状态并保持拼接不变量与整篇 parity", () => {
    const splitter = createIncrementalMarkdownSplitter();
    splitter.split("原始段落 A。\n\n原始段落 B。");
    expect(splitter.committedLength).toBeGreaterThan(0);
    const rewritten = "重写后的段落。\n\n另一段。";
    const chunks = splitter.split(rewritten);
    // reset 后本调用重新提交新文本的稳定前缀：与一个全新 splitter 的行为一致。
    const fresh = createIncrementalMarkdownSplitter();
    const freshChunks = fresh.split(rewritten);
    expect(splitter.committedLength).toBe(fresh.committedLength);
    expect(chunks.join("")).toBe(rewritten);
    expect(chunks).toEqual(parseMarkdownIntoBlocks(rewritten));
    expect(chunks).toEqual(freshChunks);
  });

  it("连续相同输入返回新数组（Streamdown 对相同引用会 bail out）", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const text = "同一段。\n\n同一段二。";
    const first = splitter.split(text);
    const second = splitter.split(text);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("组件冒烟：chunkedStreaming 开启的流式渲染输出与关闭一致（首次渲染）", () => {
    // 用 createElement 而非 JSX：保持 .ts 扩展，让本文件进入根 vitest 的收集范围。
    const document =
      "段落一。\n\n**加粗** 与 [链接](https://example.com)。\n\n```js\nconsole.log(1);\n```";
    const render = (props: { streaming?: boolean; chunkedStreaming?: boolean }) =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(TooltipProvider, null, createElement(MessageResponse, props, document)),
        ),
      );
    const base = render({ streaming: true });
    const chunked = render({ streaming: true, chunkedStreaming: true });
    expect(chunked).toBe(base);
    expect(chunked).toContain("段落一");
    // 流式模式下代码块体由 CodeBlock 异步渲染（既有行为），静态标记里断言外壳。
    expect(chunked).toContain('data-language="js"');
  });

  // 以下用例固化「追加改写已提交块语义」的风险边界：setext 下划线 / 引用续行 /
  // 列表缩进续行这类构造只能改写**紧邻前块**，而提交边界保证已提交块与文档追加点
  // 之间至少隔着一个真实块（未提交尾块），因此已提交块不可能被后续追加改写。
  // 每个序列在每一步都断言与整篇切块的深度 parity——这是「开关开启输出与标准
  // 路径一致」的直接证据。
  it("setext 场景：段落行后追加 ---/=== 构成标题时，增量结果与整篇切块一致且已提交块不变", () => {
    const splitter = createIncrementalMarkdownSplitter();
    const t1 = "Intro 段。\n\nOther";
    const c1 = splitter.split(t1);
    expect(c1).toEqual(parseMarkdownIntoBlocks(t1));
    // Other 是当时的最后一个真实块，未被提交——这正是后续 --- 能改写它时不出错的原因。
    const introChunks = c1.slice(0, -1);

    const t2 = "Intro 段。\n\nOther\n---";
    const c2 = splitter.split(t2);
    expect(c2).toEqual(parseMarkdownIntoBlocks(t2));
    // 已提交的 Intro 块逐块不变。
    expect(c2.slice(0, introChunks.length)).toEqual(introChunks);

    const t3 = "Intro 段。\n\nOther\n---\n\nTail 段。\n\nFinal";
    const c3 = splitter.split(t3);
    expect(c3).toEqual(parseMarkdownIntoBlocks(t3));
    expect(c3.slice(0, introChunks.length)).toEqual(introChunks);

    const h1Splitter = createIncrementalMarkdownSplitter();
    const s1 = h1Splitter.split("引导。\n\nTitle");
    const s2 = h1Splitter.split("引导。\n\nTitle\n===\n\n正文。");
    expect(s2).toEqual(parseMarkdownIntoBlocks("引导。\n\nTitle\n===\n\n正文。"));
    expect(s1.length).toBeGreaterThan(0);
  });

  it("引用/列表续行场景：跨空行续行改写的是未提交尾块，与整篇切块保持一致", () => {
    const quote = createIncrementalMarkdownSplitter();
    const q1 = quote.split("前文。\n\n> 引用一");
    expect(q1).toEqual(parseMarkdownIntoBlocks("前文。\n\n> 引用一"));
    const q2 = quote.split("前文。\n\n> 引用一\n>\n> 引用二");
    expect(q2).toEqual(parseMarkdownIntoBlocks("前文。\n\n> 引用一\n>\n> 引用二"));
    const q3 = quote.split("前文。\n\n> 引用一\n>\n> 引用二\n\n收尾。");
    expect(q3).toEqual(parseMarkdownIntoBlocks("前文。\n\n> 引用一\n>\n> 引用二\n\n收尾。"));

    const list = createIncrementalMarkdownSplitter();
    const l1 = list.split("开场。\n\n- 项目一");
    expect(l1).toEqual(parseMarkdownIntoBlocks("开场。\n\n- 项目一"));
    // 缩进续行并入同一列表（宽松列表）。
    const l2 = list.split("开场。\n\n- 项目一\n\n  延续内容");
    expect(l2).toEqual(parseMarkdownIntoBlocks("开场。\n\n- 项目一\n\n  延续内容"));
    const l3 = list.split("开场。\n\n- 项目一\n\n  延续内容\n\n后记。");
    expect(l3).toEqual(parseMarkdownIntoBlocks("开场。\n\n- 项目一\n\n  延续内容\n\n后记。"));
  });
});
