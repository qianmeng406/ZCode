// 流式 markdown 增量分块器：供 MessageResponse 的 chunkedStreaming 开关使用。
//
// Streamdown 在 streaming 模式下每帧对整篇文本做一次 Lexer 切块；Block 组件本身
// 有 content memo，但块数组每帧全量重建，长回复时整篇扫描是每帧的主要成本。
// 这里换一种等价的切分方式：流式文本是追加式的，一个块后面已经出现另一个真实块
// ⇒ 该块不会再被扩展，视为稳定并提交；此后每帧只需解析未提交的尾部小块。
// 稳定块的 content 字符串不变，Streamdown 的 Block memo 直接跳过重新解析。
//
// 边界守卫（都在 split 内处理，出错时退化为整篇解析，正确性不受影响）：
// - 文本不再是已提交前缀的扩展（citation 截断/图片归一化/重试改写）⇒ 重置状态；
// - 出现脚注 `[^id]` ⇒ 重置并返回整篇单块（Streamdown 对脚注有整篇特判）；
// - 未闭合围栏/HTML/$$/列表等永远只存在于未提交的尾部块（它们是最后一个真实块），
//   不会被提交，remend 追加的闭合符也随之留在尾部。
//
// 为什么「追加改写已提交块语义」不会发生（setext 下划线 / 引用续行 / 列表缩进
// 续行只能改写**紧邻前块**，而提交边界保证已提交块与文档追加点之间至少隔着一个
// 真实块）：审查场景「已提交 Other 段落后追加 ---」的前提不成立——Other 作为当时
// 的最后一个真实块不会被提交；--- 到达时它位于未提交尾部、随尾部重切成标题。
// 该性质由 streamingMarkdownChunks.test.ts 的 setext/续行序列 parity 用例固化；
// 每步 split(text) 与 parseMarkdownIntoBlocks(text) 深度相等即「开关开启输出与
// 标准路径一致」的直接证据。
import { parseMarkdownIntoBlocks } from "streamdown";

/** 脚注引用/定义标记：Streamdown 遇到脚注会把整篇作为单块处理。 */
const FOOTNOTE_MARKER_RE = /\[\^[^\]\s]+\]?/u;

export interface IncrementalMarkdownSplitter {
  split: (markdown: string) => string[];
  /** 已提交的稳定前缀长度（测试/诊断用）。 */
  readonly committedLength: number;
}

export function createIncrementalMarkdownSplitter(): IncrementalMarkdownSplitter {
  let committedPrefix = "";
  let committedChunks: string[] = [];
  // 已验证无脚注标记的整篇前缀：追加式流式下只扫「前缀末 2 字符 + 新增尾段」，
  // 每帧脚注检查从 O(整篇) 降为 O(增量)。2 字符重叠覆盖唯一跨界劈开情形——
  // 标记要求 `[^` 后至少 1 个 id 字符，更长的截断（`[^x`）在前缀内即可整段命中，
  // 只有恰好停在 `[^` 的边界需要重叠参与匹配（重叠串始终是原文的连续子串）。
  let footnoteFreePrefix = "";

  const reset = () => {
    committedPrefix = "";
    committedChunks = [];
    footnoteFreePrefix = "";
  };

  const hasFootnoteMarker = (markdown: string): boolean => {
    if (footnoteFreePrefix.length >= 2 && markdown.startsWith(footnoteFreePrefix)) {
      return FOOTNOTE_MARKER_RE.test(
        `${footnoteFreePrefix.slice(-2)}${markdown.slice(footnoteFreePrefix.length)}`,
      );
    }
    return FOOTNOTE_MARKER_RE.test(markdown);
  };

  const split = (markdown: string): string[] => {
    if (hasFootnoteMarker(markdown)) {
      // 命中脚注不推进验证前缀：脚注持续存在期间每帧全文重扫、保持整篇单块。
      reset();
      return [markdown];
    }
    if (committedPrefix !== "" && !markdown.startsWith(committedPrefix)) {
      reset();
    }
    footnoteFreePrefix = markdown;

    const tail = markdown.slice(committedPrefix.length);
    const tailChunks = parseMarkdownIntoBlocks(tail);
    // 找最后一个非空白块：其前的块（含其间空白块）都已“后面有新块”，可提交。
    let lastRealIndex = -1;
    for (let index = 0; index < tailChunks.length; index += 1) {
      if (tailChunks[index]!.trim().length > 0) lastRealIndex = index;
    }
    if (lastRealIndex <= 0) {
      // 尾部还没有出现第二个真实块：无可提交内容，原样返回已提交 + 尾部。
      return [...committedChunks, ...tailChunks];
    }

    const newlyStable = tailChunks.slice(0, lastRealIndex);
    committedChunks = [...committedChunks, ...newlyStable];
    committedPrefix = committedPrefix + newlyStable.join("");
    const rest = markdown.slice(committedPrefix.length);
    // 必须返回新数组：Streamdown 对相同数组引用会 bail out，尾部块将不更新。
    return [...committedChunks, ...parseMarkdownIntoBlocks(rest)];
  };

  return {
    split,
    get committedLength() {
      return committedPrefix.length;
    },
  };
}
