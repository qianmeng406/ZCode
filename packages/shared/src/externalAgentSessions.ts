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

// ── 外部会话的完整上下文（transcript）──
//
// 续接菜单只能看到标题；用户想"进到那个外部会话里看全部上下文"时，需要把
// CLI 的 JSONL 还原成一条会话：用户消息 / 助手正文 / 工具调用 / 工具结果。
// 与上面的概要扫描同源：**纯函数**，文件读取留在执行机侧。
//
// 分页按"条目序号"切，不按字节：文件是 append-only 的，靠尾部追加新事件，
// 已有条目的序号稳定，"加载更早"因此不会跳段。

/** 单条正文上限：用户/助手保留更多，工具结果只留可辨认的片段。 */
const TRANSCRIPT_TEXT_LIMITS = {
  user: 12_000,
  assistant: 12_000,
  tool: 300,
  tool_result: 4_000,
} as const;

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 30;
export const MAX_TRANSCRIPT_PAGE_SIZE = 60;
/** 单页正文预算：超过就从最老的条目开始丢（面板滚动不需要一次拿全）。 */
const MAX_PAGE_CHARS = 240_000;

export const externalAgentTranscriptEntrySchema = z
  .object({
    kind: z.enum(["user", "assistant", "tool", "tool_result"]),
    text: z.string(),
    /** tool / tool_result 的工具名（Bash / Read / REPL…）。 */
    name: z.string().optional(),
    /** 事件时间（epoch ms）。 */
    at: z.number().int().optional(),
    /** 这一条因过长被截断（原文在 CLI 的会话文件里）。 */
    clipped: z.boolean().optional(),
  })
  .strict();
export type ExternalAgentTranscriptEntry = z.infer<typeof externalAgentTranscriptEntrySchema>;

export const externalAgentTranscriptPageSchema = z
  .object({
    sessionId: z.string().min(1),
    entries: z.array(externalAgentTranscriptEntrySchema),
    /** 规范化后的总条目数（分页游标的口径）。 */
    total: z.number().int().nonnegative(),
    /** 更早还有条目。 */
    hasMore: z.boolean(),
    /** 源文件超过读取上限，只解析了尾部（更早的条目根本不在本次数据里）。 */
    truncated: z.boolean(),
  })
  .strict();
export type ExternalAgentTranscriptPage = z.infer<typeof externalAgentTranscriptPageSchema>;

function clipTranscriptText(
  text: string,
  limit: number,
): Pick<ExternalAgentTranscriptEntry, "text" | "clipped"> {
  if (text.length <= limit) return { text };
  return { text: `${text.slice(0, limit)}…`, clipped: true };
}

/** 把 content 数组里的文本片段拼起来（user/assistant 两种消息共用）。 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
    .trim();
}

/** function_call_result 的正文：`output.text` 或 `output.content[]`。 */
function readToolResultText(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const record = output as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text.trim();
  return readContentText(record.content);
}

/**
 * `REPL({ code })` 里的真实动作在 code 文本中（`Bash({ command: "..." })`）：
 * 直接展示 code 会是一屏 JS，取 command 更像"它到底跑了什么"。
 */
function describeFunctionCall(name: string, rawArguments: unknown): string {
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === "string") {
    try {
      const parsed: unknown = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // arguments 不是 JSON（模型偶尔给纯文本）：下面按空参数处理。
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    args = rawArguments as Record<string, unknown>;
  }
  const readString = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const code = readString("code");
  if (code) {
    const command = /command:\s*(['"`])([\s\S]*?)\1/.exec(code)?.[2];
    const detail = (command ?? code).replace(/\s+/gu, " ").trim();
    return detail ? `${name}: ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}` : name;
  }
  const detail =
    readString("command") ??
    readString("file_path") ??
    readString("path") ??
    readString("pattern") ??
    readString("query");
  if (!detail) return name;
  return `${name}: ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}`;
}

/**
 * 解析 claude-family 的会话 JSONL（codebuddy / claude 同构）。
 *
 * 跳过的东西：
 * - `system-reminder` / `<command-*>` 开头的用户消息（CLI 自己注入的提示与本地命令回显）；
 * - `providerData.skipRun` 的消息（`/model` 之类的本地命令，不会进模型上下文）；
 * - `session-meta` / `summary` / `ai-title` / `turn-metrics` / `file-history-snapshot`
 *   （元数据，不是对话内容）。
 */
export function parseClaudeFamilyTranscript(
  content: string,
  options: { sessionId: string; before?: number; limit?: number; sourceTruncated?: boolean },
): ExternalAgentTranscriptPage {
  const entries: ExternalAgentTranscriptEntry[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const at = typeof record.timestamp === "number" ? record.timestamp : undefined;

    if (record.type === "message") {
      const role = record.role;
      if (role !== "user" && role !== "assistant") continue;
      const providerData = record.providerData;
      if (
        providerData &&
        typeof providerData === "object" &&
        (providerData as { skipRun?: unknown }).skipRun === true
      ) {
        continue;
      }
      const text = readContentText(record.content);
      if (!text) continue;
      // CLI 注入的提示（command-caveat 等）不是用户上下文。
      if (role === "user" && text.startsWith("<")) continue;
      entries.push({
        kind: role,
        ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS[role]),
        ...(at !== undefined ? { at } : {}),
      });
      continue;
    }

    if (record.type === "function_call") {
      const name = typeof record.name === "string" && record.name ? record.name : "tool";
      const text = describeFunctionCall(name, record.arguments ?? record.input);
      entries.push({
        kind: "tool",
        name,
        ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.tool),
        ...(at !== undefined ? { at } : {}),
      });
      continue;
    }

    if (record.type === "function_call_result") {
      const text = readToolResultText(record.output);
      if (!text) continue;
      const name = typeof record.name === "string" && record.name ? record.name : "tool";
      entries.push({
        kind: "tool_result",
        name,
        ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.tool_result),
        ...(at !== undefined ? { at } : {}),
      });
    }
  }

  const total = entries.length;
  const limit = Math.min(
    MAX_TRANSCRIPT_PAGE_SIZE,
    Math.max(1, options.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE),
  );
  const before = Math.max(0, Math.min(options.before ?? total, total));
  let start = Math.max(0, before - limit);
  let chars = 0;
  for (let index = start; index < before; index += 1) chars += entries[index]!.text.length;
  while (start < before - 1 && chars > MAX_PAGE_CHARS) {
    chars -= entries[start]!.text.length;
    start += 1;
  }
  return {
    sessionId: options.sessionId,
    entries: entries.slice(start, before),
    total,
    hasMore: start > 0,
    truncated: options.sourceTruncated === true,
  };
}
