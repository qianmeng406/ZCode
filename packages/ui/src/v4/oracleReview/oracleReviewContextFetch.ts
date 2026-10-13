import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { formatOracleCommitLine, type OracleDiffSection } from "./oracleReviewSupport.js";

/**
 * 审查的上下文取数层：从会话历史取本回合的请求文本、从 git 取最近提交摘要。
 * 与 prompt 构建/裁决解析分文件，避免支持文件无限膨胀；只依赖结构化取数端口，
 * 不引入 hook/services 运行时依赖（保持 node:test 可直测）。
 */

/**
 * 回合请求文本的取数：快照行窗口是**尾部窗口**（大回合会把更早的行挤出窗口），
 * 只扫窗口会在「请求行已被裁剪」时取空——prompt 只剩对照上下文，审查者据此
 * 臆断任务（实测：把上一轮审查的 5 条 findings 当成本回合任务，判"跑偏"）。
 * 因此窗口未命中时用 rows/range 游标向前翻页补历史，直到找到真实用户输入。
 */
const ORACLE_ROWS_RANGE_PAGE_LIMIT = 200;
const ORACLE_ROWS_RANGE_MAX_PAGES = 5;

export interface OracleUserRequestLookup {
  text: string;
  /** window=窗口内直接命中；history=翻页补历史；missing=两处都取不到。 */
  source: "window" | "history" | "missing";
}

/** rows/range 翻页的最小结构面（避免把 services 依赖带进纯函数层）。 */
export type OracleFetchRowsBefore = (
  beforeRowId: number,
  limit: number,
) => Promise<{ rows: readonly ConversationRow[]; hasMore: boolean }>;

function findRealUserInputBefore(
  rows: readonly ConversationRow[],
  turnRowId: number,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "userInput" || row.rowId >= turnRowId) continue;
    // 非真实用户输入（后台结果/工作流启动等）不是本回合的请求文本。
    if (row.origin !== undefined && row.origin !== "realUser") continue;
    return row.text;
  }
  return null;
}

export async function findOracleUserRequestBeforeTurn(params: {
  windowRows: readonly ConversationRow[];
  turnRowId: number;
  fetchRowsBefore: OracleFetchRowsBefore;
  maxPages?: number;
}): Promise<OracleUserRequestLookup> {
  // 窗口是连续尾部：命中即权威（窗口内更近的 userInput 就是本回合的请求）。
  const fromWindow = findRealUserInputBefore(params.windowRows, params.turnRowId);
  if (fromWindow !== null) return { text: fromWindow, source: "window" };

  const earliestWindowRowId = params.windowRows[0]?.rowId;
  if (earliestWindowRowId === undefined) return { text: "", source: "missing" };
  let beforeRowId = earliestWindowRowId;
  const maxPages = params.maxPages ?? ORACLE_ROWS_RANGE_MAX_PAGES;
  for (let page = 0; page < maxPages; page += 1) {
    let result: { rows: readonly ConversationRow[]; hasMore: boolean };
    try {
      result = await params.fetchRowsBefore(beforeRowId, ORACLE_ROWS_RANGE_PAGE_LIMIT);
    } catch {
      // 历史查询失败不阻塞审查：退回 missing，由 prompt/注入抑制逻辑兜底。
      return { text: "", source: "missing" };
    }
    const hit = findRealUserInputBefore(result.rows, params.turnRowId);
    if (hit !== null) return { text: hit, source: "history" };
    const earliestPageRow = result.rows[0];
    if (!result.hasMore || earliestPageRow === undefined) break;
    beforeRowId = earliestPageRow.rowId;
  }
  return { text: "", source: "missing" };
}

/** 审查 prompt 附带的最近提交条数：只作「此前改动可能已在早前提交中」的对照线索。 */
const RECENT_COMMITS_FOR_REVIEW = 8;

/** getCommitGraph 的最小结构面（避免把 services/hook 依赖带进本纯函数层）。 */
interface OracleCommitGraphService {
  getCommitGraph(params: {
    workspacePath: string;
    maxCount?: number;
  }): Promise<{ commits: readonly { hash: string; subject: string }[] }>;
}

/** 最近提交摘要；非 git 工作区/查询失败返回 null，审查照常进行。 */
export async function readOracleRecentCommitSubjects(
  gitService: OracleCommitGraphService | undefined | null,
  workspacePath: string,
): Promise<string[] | null> {
  if (!gitService) return null;
  try {
    const graph = await gitService.getCommitGraph({
      workspacePath,
      maxCount: RECENT_COMMITS_FOR_REVIEW,
    });
    return graph.commits.map((commit) => formatOracleCommitLine(commit.hash, commit.subject));
  } catch {
    return null;
  }
}

/**
 * 工作区改动兜底：回合内的改动若由脚本/命令完成，checkpoint 不会记录工具级
 * 文件变更（fileChanges 为空），标准审查会直接拒绝、深度审查也看不到 diff。
 * 这里回退到 git 的「未提交改动」，让脚本回合也能被审查。
 *
 * 口径如实：这是工作区相对 HEAD 的当前改动，可能包含同期其他未提交改动，
 * prompt 会标注来源并要求审查者无法确认归属时如实说明。
 */
const ORACLE_WORKSPACE_DIFF_MAX_FILES = 40;
const ORACLE_WORKSPACE_DIFF_MAX_BYTES = 800_000;

/** git 取数的最小结构面（避免把 services 依赖带进纯函数层）。 */
export interface OracleWorkspaceDiffPort {
  getChanges(params: { workspacePath: string }): Promise<
    readonly {
      path: string;
      workspaceRelativePath?: string;
      kind: string;
      section: string;
      isStaged: boolean;
    }[]
  >;
  getDiff(params: {
    workspacePath: string;
    path: string;
    staged?: boolean;
    sourceId?: string;
  }): Promise<{ patch: string | null }>;
}

export interface OracleWorkspaceDiffResult {
  sections: OracleDiffSection[];
  fileCount: number;
  /** 超出文件数或字节上限被裁剪。 */
  truncated: boolean;
  /** 被判定为不可审查（目录/依赖/内部目录）而跳过的条目数。 */
  excluded: number;
}

// 工作区兜底只看「可审查的文本改动」：目录条目（含嵌套仓库，git 会整体列为一条
// 未跟踪目录）、依赖与构建产物、工具内部目录都会污染审查输入——实测曾把工作区根
// 的未跟踪杂物（含一次性垃圾文件与嵌套仓库）整包喂给审查者。
const ORACLE_WORKSPACE_DIFF_EXCLUDED_SEGMENTS = new Set([
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

function isUnreviewableWorkspaceChange(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  // 目录条目没有文本 diff 可审，且往往把整个依赖树算作一条改动。
  if (normalized.endsWith("/")) return true;
  return normalized
    .split("/")
    .filter(Boolean)
    .some((segment) => ORACLE_WORKSPACE_DIFF_EXCLUDED_SEGMENTS.has(segment));
}

export async function readOracleWorkspaceDiff(
  port: OracleWorkspaceDiffPort | undefined | null,
  workspacePath: string,
  options?: { maxFiles?: number; maxBytes?: number },
): Promise<OracleWorkspaceDiffResult> {
  if (!port) return { sections: [], fileCount: 0, truncated: false, excluded: 0 };
  const maxFiles = options?.maxFiles ?? ORACLE_WORKSPACE_DIFF_MAX_FILES;
  const maxBytes = options?.maxBytes ?? ORACLE_WORKSPACE_DIFF_MAX_BYTES;

  let changes: Awaited<ReturnType<OracleWorkspaceDiffPort["getChanges"]>>;
  try {
    changes = await port.getChanges({ workspacePath });
  } catch {
    return { sections: [], fileCount: 0, truncated: false, excluded: 0 };
  }
  if (changes.length === 0) return { sections: [], fileCount: 0, truncated: false, excluded: 0 };

  const reviewable = changes.filter(
    (change) => !isUnreviewableWorkspaceChange(change.workspaceRelativePath ?? change.path),
  );
  const excluded = changes.length - reviewable.length;
  const selected = reviewable.slice(0, maxFiles);
  let truncated = reviewable.length > selected.length;
  const sections: OracleDiffSection[] = [];
  let bytes = 0;
  for (const change of selected) {
    let patch: string | null = null;
    try {
      const diff = await port.getDiff({
        workspacePath,
        path: change.path,
        ...(change.isStaged ? { staged: true } : {}),
        ...(change.section === "staged" || change.section === "unstaged"
          ? { sourceId: change.section }
          : {}),
      });
      patch = diff.patch;
    } catch {
      patch = null;
    }
    const text =
      patch && patch.trim()
        ? patch
        : `（无可用 unified diff：kind=${change.kind}${change.isStaged ? " staged" : ""}，可能是新增/二进制文件）`;
    bytes += text.length;
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    sections.push({ path: change.workspaceRelativePath ?? change.path, text });
  }
  return { sections, fileCount: reviewable.length, truncated, excluded };
}
