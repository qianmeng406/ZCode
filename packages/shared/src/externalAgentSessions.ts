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
//
// **本模块必须保持纯函数**：它经 @zcode/shared 的 index 进入 renderer 的模块图，
// 顶层 import 任何 node:fs / node:path 都会在浏览器里炸成
// "Module node:fs has been externalized"（整个 UI 白屏）。文件读取放在执行机侧
// （bootstrap 的探针脚本），这里只做字符串解析。
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
  return (
    cwd
      // CLI 落盘时盘符是小写（实测 `c:\Users\...` → `c-Users-...`），而 Windows 传进来的
      // cwd 通常是 `C:\Users\...`。不归一就指向一个不存在的目录，整个会话列表静默为空。
      .replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
      .replace(/:/g, "")
      .replace(/[\\/]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * 从一段 stdout/文件内容里扫描会话概要。
 *
 * 纯函数便于单测；执行机侧的探针脚本逐文件读出内容后喂进来。
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
