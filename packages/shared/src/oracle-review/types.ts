/**
 * Oracle 审查的共享契约层：审查深度、querySource 归属、diff 形状与排除规则。
 *
 * 这些常量与纯函数同时被 UI（会话内审查）与 CLI（`zcode review`）使用。放在
 * `@zcode/shared` 而不是 `@zcode/ui`，是因为 CLI 依赖链上不存在 ui 包；两份实现
 * 分叉会让「同一批改动在设置页与 CI 里按不同标准被审查」。
 */

export const ORACLE_TURN_REVIEW_QUERY_SOURCE = "oracle_turn_review";
// 全量材料 + 最高推理档的思考可能很久；10 分钟客户端 deadline（宿主会据此派生
// 取消 signal，跳过 CLI 侧 60s 默认超时），横幅不阻塞输入。
export const ORACLE_REVIEW_REQUEST_TIMEOUT_MS = 600_000;
export const ORACLE_DEEP_REVIEW_QUERY_SOURCE = "oracle_deep_review";
// 深度审查是多轮只读子代理（读文件/搜索/只读 bash 取证），耗时数倍于标准审查。
export const ORACLE_DEEP_REVIEW_TIMEOUT_MS = 1_200_000;
// 上下文分析阶段（独立 querySource/operationId，可被独立取消与路由进度）。
export const ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE = "oracle_review_context";
export const ORACLE_CONTEXT_ANALYSIS_TIMEOUT_MS = 300_000;

export type OracleReviewDepth = "standard" | "deep";

/** 深度审查的进度通知也走同一 workspace/generateTextProgress 通道，按来源认领。 */
export function isOracleReviewQuerySource(querySource: string): boolean {
  return (
    querySource === ORACLE_TURN_REVIEW_QUERY_SOURCE ||
    querySource === ORACLE_DEEP_REVIEW_QUERY_SOURCE ||
    querySource === ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE
  );
}

// 注入上下文的长度上限：最近提交行不设限会无上限撑大审查 prompt。
const MAX_COMMIT_LINE_CHARS = 120;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface OracleReviewDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: readonly string[];
}

export interface OracleReviewDiffItem {
  path: string;
  additions: number;
  deletions: number;
  patches: readonly OracleReviewDiffHunk[];
}

export interface OracleDiffSection {
  path: string;
  text: string;
}

/** 把 v4 fileChanges 的 hunk 拼成 unified diff 文本（形状同 ConversationFileSummaryPanel 的局部 formatPatch）。 */
export function formatOraclePatch(path: string, patches: readonly OracleReviewDiffHunk[]): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

/**
 * diff 原样进 prompt，不做任何裁剪——截断会让审查结论只覆盖部分改动。
 * 空 patch（二进制/无文本差异）跳过。超大 diff 若顶到模型上下文上限，会让上游
 * 报错并如实显示在横幅里，不静默截断。
 */
export function buildOracleDiffSections(
  items: readonly OracleReviewDiffItem[],
): OracleDiffSection[] {
  const sections: OracleDiffSection[] = [];
  for (const item of items) {
    if (item.patches.length === 0) continue;
    sections.push({ path: item.path, text: formatOraclePatch(item.path, item.patches) });
  }
  return sections;
}

/** 提交行：hash 前 7 位 + subject（截断到单行上限，防超长 subject 撑大 prompt）。 */
export function formatOracleCommitLine(hash: string, subject: string): string {
  return truncate(`${hash.slice(0, 7)} ${subject}`, MAX_COMMIT_LINE_CHARS);
}

// 工作区兜底只看「可审查的文本改动」：目录条目（含嵌套仓库，git 会整体列为一条
// 未跟踪目录）、依赖与构建产物、工具内部目录都会污染审查输入——实测曾把工作区根
// 的未跟踪杂物（含一次性垃圾文件与嵌套仓库）整包喂给审查者。
const ORACLE_DIFF_EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".zcode",
  ".cache",
  ".turbo",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
]);

/**
 * 该路径是否不应进入审查证据。
 *
 * UI 的工作区兜底与 CLI 的 `git diff` 切分共用同一规则：两边分叉会出现「设置页
 * 不审 node_modules，CI 却把整棵依赖树喂给模型」。
 */
export function isOracleDiffExcludedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  // 目录条目没有文本 diff 可审，且往往把整个依赖树算作一条改动。
  if (normalized.endsWith("/")) return true;
  return normalized
    .split("/")
    .filter(Boolean)
    .some((segment) => ORACLE_DIFF_EXCLUDED_SEGMENTS.has(segment));
}
