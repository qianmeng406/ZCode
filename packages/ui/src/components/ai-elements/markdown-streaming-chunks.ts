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

  const reset = () => {
    committedPrefix = "";
    committedChunks = [];
  };

  const split = (markdown: string): string[] => {
    if (FOOTNOTE_MARKER_RE.test(markdown)) {
      reset();
      return [markdown];
    }
    if (committedPrefix !== "" && !markdown.startsWith(committedPrefix)) {
      reset();
    }

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
