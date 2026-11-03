// claude-family（codebuddy / claude）的外部会话列表扫描。
//
// 为什么在这里而不是 bootstrap：扫描规则依赖 CLI 的落盘格式（JSONL 事件流），
// 与 argv 形状、输出解析同属"驱动族知识"；bootstrap 只负责拿 ExecutionPort 读文件。
//
// 落盘事实（codebuddy 2.179.2 实测，claude 同构）：
// - `<cliHome>/projects/<cwd 路径分隔符换成 ->/<sessionId>.jsonl`，一行一个事件；
// - `session-meta` 事件带 sessionId（注意：文件名里的 id 与 meta.sessionId 可能不同，
//   续接必须用 meta 里的 id）；首条 message 前通常还有一条 command-caveat 的
//   system-reminder 输入，跳过 `<` 开头的文本才是用户真实首句；
// - `summary` / `ai-title` 事件给出会话标题（ai-title 是英文，summary 是用户语言）。
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const externalAgentSessionSummarySchema = z.object({
  /** CLI 自报的会话 id（`-r` 续接用它，可能 ≠ 文件名）。 */
  sessionId: z.string().min(1),
  /** 标题：summary（用户语言）优先，其次 ai-title，最后首句截断。 */
  title: z.string(),
  /** 最近一次活动时间（epoch ms）。 */
  updatedAt: z.number().int(),
  /** 首条用户输入的截断文本（标题缺席时的展示兜底）。 */
  preview: z.string().optional(),
});
export type ExternalAgentSessionSummary = z.infer<typeof externalAgentSessionSummarySchema>;

/** 标题候选的最大长度；更长的在扫描时截断（列表只需要一行）。 */
const TITLE_MAX_CHARS = 120;
/** 最多返回多少条（按 updatedAt 降序截断）。 */
export const MAX_EXTERNAL_AGENT_SESSIONS = 30;

/** cwd → CLI 的 projects 目录名：分隔符换成 `-`，Windows 盘符冒号丢弃（`c:\x` → `c-x`）。 */
export function cwdToProjectDirName(cwd: string): string {
  return cwd
    .replace(/:/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 从一段 stdout/文件内容里扫描会话概要。
 *
 * 纯函数便于单测；文件读取版 `scanClaudeFamilySessionsFromDir` 只是逐文件喂进来。
 * 单文件解析失败（半个事件、截断）不抛——列表是尽力而为的展示，缺一条不致命。
 */
export function scanClaudeFamilySessionsFromLines(
  lines: readonly string[],
  fallbackSessionId: string,
  updatedAtFallback: number,
): ExternalAgentSessionSummary | null {
  let sessionId = "";
  let summary = "";
  let aiTitle = "";
  let firstUser = "";
  let latestTimestamp = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      type?: unknown;
      sessionId?: unknown;
      timestamp?: unknown;
      summary?: unknown;
      aiTitle?: unknown;
      role?: unknown;
      content?: unknown;
    };
    if (typeof record.timestamp === "number" && record.timestamp > latestTimestamp) {
      latestTimestamp = record.timestamp;
    }
    // 续接 id 以 session-meta（或任意行）里的 sessionId 为准：文件名可能只是落盘键。
    if (!sessionId && typeof record.sessionId === "string" && record.sessionId) {
      sessionId = record.sessionId;
    }
    if (!summary && record.type === "summary" && typeof record.summary === "string") {
      summary = record.summary.trim();
    }
    if (!aiTitle && record.type === "ai-title" && typeof record.aiTitle === "string") {
      aiTitle = record.aiTitle.trim();
    }
    // 首条用户输入：跳过 system-reminder（command-caveat 等内部注入）。
    if (
      !firstUser &&
      record.type === "message" &&
      record.role === "user" &&
      Array.isArray(record.content)
    ) {
      const text = record.content
        .map((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("")
        .trim();
      if (text && !text.startsWith("<")) firstUser = text;
    }
  }
  const resolvedId = sessionId || fallbackSessionId;
  if (!resolvedId) return null;
  const titleSource = summary || aiTitle || firstUser;
  const title = titleSource
    ? titleSource.length > TITLE_MAX_CHARS
      ? `${titleSource.slice(0, TITLE_MAX_CHARS)}…`
      : titleSource
    : resolvedId;
  return {
    sessionId: resolvedId,
    title,
    updatedAt: latestTimestamp || updatedAtFallback,
    ...(firstUser ? { preview: firstUser.slice(0, TITLE_MAX_CHARS) } : {}),
  };
}

/** 便利包装：从一段完整文本扫描（测试与调用方共用）。 */
export function scanClaudeFamilySessionFile(
  content: string,
  fallbackSessionId: string,
  updatedAtFallback: number,
): ExternalAgentSessionSummary | null {
  return scanClaudeFamilySessionsFromLines(
    content.split(/\r?\n/u),
    fallbackSessionId,
    updatedAtFallback,
  );
}

/**
 * 扫描 CLI 的 projects 目录，返回某 cwd 的外部会话列表（updatedAt 降序）。
 *
 * - 目录不存在（CLI 从未在本 cwd 跑过）→ 空数组，不是错误；
 * - home 缺席（没有 USERPROFILE/HOME 的非常规环境）→ 空数组；
 * - 只认 `*.jsonl`，忽略子目录与临时文件。
 */
export async function scanClaudeFamilySessions(options: {
  cliHome: string;
  cwd: string;
  driver: "claude-family";
  limit?: number;
}): Promise<ExternalAgentSessionSummary[]> {
  const projectDir = path.join(options.cliHome, "projects", cwdToProjectDirName(options.cwd));
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return [];
  }
  const limit = options.limit ?? MAX_EXTERNAL_AGENT_SESSIONS;
  const summaries: ExternalAgentSessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(projectDir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    let content: string;
    try {
      stat = await fs.stat(filePath);
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const summary = scanClaudeFamilySessionFile(
      content,
      name.slice(0, -".jsonl".length),
      stat.mtimeMs,
    );
    if (summary) summaries.push(summary);
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}
