import { isOracleDiffExcludedPath, type OracleDiffSection } from "./types.js";

/**
 * 把一个 unified diff 文本切成按文件分段的审查证据（纯函数，无 git 依赖）。
 *
 * CLI 的 `zcode review` 把 `git diff` 的原始输出交给它；这样"哪段算一段证据""哪些
 * 路径不审"与设置页的工作区兜底用同一套规则（types.isOracleDiffExcludedPath），
 * 不会出现「本地不审 node_modules、CI 却把依赖树喂给模型」。
 */

/** 与 UI 工作区兜底同一预算：40 个文件 / 800 KB。 */
const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_BYTES = 800_000;

/** `diff --git a/<path> b/<path>`；带引号的路径（空格/中文）两边都去掉引号。 */
const DIFF_HEADER_PATTERN = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;

export interface OracleDiffSplitResult {
  readonly sections: OracleDiffSection[];
  /** 过滤后剩余的可审查文件数（可能大于实际纳入的 sections 数）。 */
  readonly fileCount: number;
  /** 实际纳入的字符数（与 UI 兜底同口径，按字符串长度而非字节）。 */
  readonly bytes: number;
  /** 因文件数或体积上限被裁剪。 */
  readonly truncated: boolean;
  /** 被排除规则跳过的文件数。 */
  readonly excluded: number;
}

export function splitUnifiedDiffIntoOracleSections(
  diffText: string,
  options: { maxFiles?: number; maxBytes?: number } = {},
): OracleDiffSplitResult {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = diffText.split(/\r?\n/);

  const blocks: { path: string; start: number; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(DIFF_HEADER_PATTERN);
    if (!match) continue;
    const previous = blocks.at(-1);
    if (previous) previous.end = index;
    // b 侧路径是改动后的真实位置；重命名时以它为准。
    const path = (match[2] ?? match[1] ?? "").replace(/^"+|"+$/g, "");
    if (!path) continue;
    blocks.push({ path, start: index, end: lines.length });
  }

  let excluded = 0;
  const reviewable = blocks.filter((block) => {
    if (isOracleDiffExcludedPath(block.path)) {
      excluded += 1;
      return false;
    }
    return true;
  });
  const selected = reviewable.slice(0, maxFiles);
  let truncated = reviewable.length > selected.length;
  const sections: OracleDiffSection[] = [];
  let bytes = 0;
  for (const block of selected) {
    const text = lines.slice(block.start, block.end).join("\n").trimEnd();
    if (!text) continue;
    // 首个文件即使超预算也纳入：否则「一个大文件」会被报告成「没有可审的改动」。
    if (sections.length > 0 && bytes + text.length > maxBytes) {
      truncated = true;
      break;
    }
    sections.push({ path: block.path, text });
    bytes += text.length;
  }

  return { sections, fileCount: reviewable.length, bytes, truncated, excluded };
}
