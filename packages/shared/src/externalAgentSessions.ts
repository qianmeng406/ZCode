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
 * Qoder CLI（国际版/CN 同为 `C--Users-...` 规则）的 cwd → project 目录名。
 *
 * 与 claude/codebuddy 的差别（2026-11-10 实测 `~/.qoder/projects` 与 `~/.qoder-cn/projects`）：
 * - 盘符**保留原大小写**，且冒号**不丢弃**而是也折叠成 `-`：`C:\Users\x` → `C--Users-x`；
 * - 分隔符折叠为 `-`；
 * - 首尾的 `-` 不裁剪（posix `/Users/x` → `-Users-x`，与实测目录形态一致）。
 *
 * 用错规则不会报错，只会指向一个不存在的目录 → 续接列表与上下文面板静默为空。
 */
export function cwdToQoderProjectDirName(cwd: string): string {
  // 逐字符折叠（不是把 `:\` 连续段折叠成一个 `-`）：`C:\Users` 的两个分隔符
  // 各产生一个 `-`，才是实测的 `C--Users`。
  return cwd.replace(/[:\\/]/gu, "-");
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

/** Command Code 的 cwd → project 目录名（`@sindresorhus/slugify` 实测规则）。 */
export function cwdToCommandCodeProjectDirName(cwd: string): string {
  const slug = cwd
    // 音标折叠：Café → cafe（slugify 的 transliterate 行为）；中文等非拉丁字符在
    // 下一步整体折叠成一个 `-`（与 slugify 一致：`/Users/张三/项目` → `users`）。
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "root";
}

/** 时间戳兼容：Command Code 存 ISO 字符串，旧数据可能是 epoch ms。 */
function readCommandCodeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** `metadata.isMeta` 的条目是 CLI 注入的内部记录，不属于对话内容。 */
function isCommandCodeMetaEntry(record: Record<string, unknown>): boolean {
  const message = record.message;
  const nestedMeta =
    message && typeof message === "object" ? (message as { meta?: unknown }).meta : undefined;
  const metadata = nestedMeta ?? record.metadata;
  return Boolean(
    metadata && typeof metadata === "object" && (metadata as { isMeta?: unknown }).isMeta === true,
  );
}

/**
 * 取出对话消息本体。
 *
 * Command Code 当前落盘是 V3：`{type:"message",message:{role,content,meta}}`；
 * 旧版本是扁平的 `{role,content,metadata}`。两种都要支持，否则新会话在列表与
 * 上下文面板里会整条消失（2026-11-09 用免费模型实测发现的形状）。
 */
function readCommandCodeMessage(record: Record<string, unknown>): {
  role: unknown;
  content: unknown;
  meta: Record<string, unknown> | undefined;
} {
  const message = record.message;
  if (message && typeof message === "object") {
    const value = message as { role?: unknown; content?: unknown; meta?: unknown };
    return {
      role: value.role,
      content: value.content,
      meta:
        value.meta && typeof value.meta === "object"
          ? (value.meta as Record<string, unknown>)
          : undefined,
    };
  }
  return {
    role: record.role,
    content: record.content,
    meta:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

/**
 * 扫描 Command Code 会话 JSONL 的概要。
 *
 * 形状（1.88.5 实测/源码）：
 * - 首行头 `{type:"session",version:3,id,timestamp,cwd}`；
 * - 其后条目 `{id,timestamp,sessionId,parentId,role,content,metadata}`；
 * - `content` 是 V2 part 数组，用户正文是 `{type:"text",text}`。
 *
 * 标题没有独立的 summary/ai-title 事件（headless 会话本来就不命名），用首条用户
 * 正文兜底；续接 id 优先用头里的 `id`。
 */
export function scanCommandCodeSessionFile(
  content: string,
  fallbackSessionId: string,
  updatedAtFallback: number,
): ExternalAgentSessionSummary | null {
  let sessionId = "";
  let firstUser = "";
  let latestTimestamp = 0;
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "session" && typeof record.id === "string" && record.id) {
      sessionId = sessionId || record.id;
    }
    if (typeof record.sessionId === "string" && record.sessionId) {
      sessionId = sessionId || record.sessionId;
    }
    const at = readCommandCodeTimestamp(record.timestamp);
    if (at !== undefined && at > latestTimestamp) latestTimestamp = at;
    if (isCommandCodeMetaEntry(record)) continue;
    const message = readCommandCodeMessage(record);
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const text = readContentText(message.content);
    // CLI 注入的提示（<command-*> / system-reminder）不是用户首句。
    if (text && !text.startsWith("<")) firstUser = firstUser || text;
  }
  const resolvedId = sessionId || fallbackSessionId;
  if (!resolvedId) return null;
  const titleSource = firstUser;
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
  options: {
    sessionId: string;
    before?: number;
    limit?: number;
    sourceTruncated?: boolean;
  },
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
  return paginateTranscript(entries, total, options);
}

/**
 * 从 `opencode session export <id>` 的 JSON 还原一条会话。
 *
 * 形状（v2.2.5 实测）：单个 JSON `{info, messages[]}`，不是 JSONL——所以不能复用
 * 上面逐行扫描的解析器。message.content 是 part 数组：
 * - `text`：用户输入与助手正文；
 * - `tool`：一次工具调用，`state.input` 是入参、`state.output` 是输出文本。
 *
 * 工具调用拆成「调用」与「结果」两条，与 claude-family 的 function_call /
 * function_call_result 对齐：面板按同一套 kind 渲染，不需要为每个驱动写分支。
 *
 * 跳过的消息类型：`system` / `idle` / `model-switched` / `compaction` 都是 CLI 自己
 * 的状态记录，不是对话内容。
 *
 * 同为纯函数：内容由执行机侧读好再喂进来，这里不做任何 IO。
 */
export function parseOpencodeSessionExport(
  content: string,
  options: {
    sessionId: string;
    before?: number;
    limit?: number;
    sourceTruncated?: boolean;
  },
): ExternalAgentTranscriptPage {
  const entries: ExternalAgentTranscriptEntry[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // export 内容被截断/损坏：返回空页而不是抛错——面板显示"没有可读内容"比整块崩掉好。
    parsed = undefined;
  }
  const messages =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { messages?: unknown }).messages)
      ? ((parsed as { messages: unknown[] }).messages as unknown[])
      : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as {
      type?: unknown;
      time?: unknown;
      content?: unknown;
    };
    const at =
      record.time &&
      typeof record.time === "object" &&
      typeof (record.time as { created?: unknown }).created === "number"
        ? (record.time as { created: number }).created
        : undefined;
    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;
    if (!Array.isArray(record.content)) continue;

    if (type === "user") {
      // 用户消息只保留正文；里面的 tool part 是 CLI 回填的工具结果，已在助手侧
      // 的 tool 条目里出现，重复展示会让同一次调用出现两遍。
      const text = readContentText(record.content);
      if (!text) continue;
      entries.push({
        kind: "user",
        ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.user),
        ...(at !== undefined ? { at } : {}),
      });
      continue;
    }

    // 助手消息：正文与工具调用按 part 顺序展开。正文用空行连接多段 text，避免
    // 两段话粘成一句。
    //
    // 正文条目在遇到第一个 tool part 之前就落位（而不是等整条消息扫完再追加）：
    // 一条 assistant 消息里常常是「一句话 → 一次工具调用」，先推后推决定了面板上
    // 是"说完再做"还是"做完再说话"。先到先得的工具条目位置则天然正确。
    const texts: string[] = [];
    const flushText = (): void => {
      const text = texts.join("\n\n");
      if (!text) return;
      texts.length = 0;
      entries.push({
        kind: "assistant",
        ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.assistant),
        ...(at !== undefined ? { at } : {}),
      });
    };
    for (const rawPart of record.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as {
        type?: unknown;
        text?: unknown;
        tool?: unknown;
        state?: unknown;
      };
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
        continue;
      }
      if (part.type === "reasoning") {
        // 思考过程不进行转录：面板展示的是"它做了什么"，思考片段量大且易误导。
        continue;
      }
      if (part.type !== "tool" || typeof part.tool !== "string" || !part.tool) continue;
      flushText();
      const state = (part.state && typeof part.state === "object" ? part.state : {}) as {
        input?: unknown;
        output?: unknown;
      };
      entries.push({
        kind: "tool",
        name: part.tool,
        ...clipTranscriptText(
          describeFunctionCall(part.tool, state.input),
          TRANSCRIPT_TEXT_LIMITS.tool,
        ),
        ...(at !== undefined ? { at } : {}),
      });
      const output = typeof state.output === "string" ? state.output.trim() : "";
      if (output) {
        entries.push({
          kind: "tool_result",
          name: part.tool,
          ...clipTranscriptText(output, TRANSCRIPT_TEXT_LIMITS.tool_result),
          ...(at !== undefined ? { at } : {}),
        });
      }
    }
    // 工具之后的正文属于新一轮"说话"，仍按 part 顺序落在后面。
    flushText();
  }
  return paginateTranscript(entries, entries.length, options);
}

/**
 * 从 `command-code` 的会话 JSONL 还原一条会话。
 *
 * 条目形状（V2 落盘，源码 `toStoredEntry` / `toV2` 实测）：
 * - `role:"assistant"`：`{type:"text",text}` / `{type:"reasoning",text}` /
 *   `{type:"tool-call",toolCallId,toolName,input}`；
 * - `role:"user"`：`{type:"text",text}` / `{type:"image",...}`；
 * - `role:"tool"`：`{type:"tool-result",toolCallId,toolName,output:{type:"text",value}}`。
 *
 * 与 claude-family 的逐行事件不同：这里没有 `type:"message"`，工具结果也是独立
 * 消息。所以必须单独解析，不能复用 claude-family 的 transcript 解析器。
 */
export function parseCommandCodeTranscript(
  content: string,
  options: {
    sessionId: string;
    before?: number;
    limit?: number;
    sourceTruncated?: boolean;
  },
): ExternalAgentTranscriptPage {
  const entries: ExternalAgentTranscriptEntry[] = [];
  // tool-result 自己不总带工具名（V2 里 toolName 常为空串）：用 toolCallId 回查。
  const toolNames = new Map<string, string>();
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
    // 首行头不是对话条目。
    if (record.type === "session") continue;
    if (isCommandCodeMetaEntry(record)) continue;
    const at = readCommandCodeTimestamp(record.timestamp);
    // V3 把消息包在 message 里（`{type:"message",message:{role,content}}`）；
    // 旧版是扁平 role/content。两种都解。
    const message = readCommandCodeMessage(record);
    const parts = Array.isArray(message.content) ? message.content : [];
    const role = message.role;

    if (role === "assistant") {
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          id?: unknown;
          toolCallId?: unknown;
          name?: unknown;
          toolName?: unknown;
          input?: unknown;
        };
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          entries.push({
            kind: "assistant",
            ...clipTranscriptText(part.text.trim(), TRANSCRIPT_TEXT_LIMITS.assistant),
            ...(at !== undefined ? { at } : {}),
          });
          continue;
        }
        if (part.type === "thinking" || part.type === "reasoning") {
          // 思考过程不进行转录（与其他驱动一致：量大且易误导）。
          continue;
        }
        // V3 落 Anthropic 形状（tool_use{id,name,input}）；V2 是
        // tool-call{toolCallId,toolName,input}。两种都收。
        if (part.type !== "tool_use" && part.type !== "tool-call") continue;
        const name =
          typeof part.name === "string" && part.name
            ? part.name
            : typeof part.toolName === "string" && part.toolName
              ? part.toolName
              : "tool";
        const toolCallId =
          typeof part.id === "string"
            ? part.id
            : typeof part.toolCallId === "string"
              ? part.toolCallId
              : "";
        if (toolCallId) toolNames.set(toolCallId, name);
        entries.push({
          kind: "tool",
          name,
          ...clipTranscriptText(
            describeFunctionCall(name, part.input),
            TRANSCRIPT_TEXT_LIMITS.tool,
          ),
          ...(at !== undefined ? { at } : {}),
        });
      }
      continue;
    }

    if (role === "user") {
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as {
          type?: unknown;
          text?: unknown;
          tool_use_id?: unknown;
          toolCallId?: unknown;
          content?: unknown;
          output?: unknown;
        };
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          // CLI 注入的提示（<command-*> / system-reminder）不是用户上下文。
          if (part.text.trimStart().startsWith("<")) continue;
          entries.push({
            kind: "user",
            ...clipTranscriptText(part.text.trim(), TRANSCRIPT_TEXT_LIMITS.user),
            ...(at !== undefined ? { at } : {}),
          });
          continue;
        }
        // V3 的工具结果挂在 user 消息里：`{type:"tool_result",tool_use_id,content}`。
        if (part.type !== "tool_result") continue;
        const toolCallId =
          typeof part.tool_use_id === "string"
            ? part.tool_use_id
            : typeof part.toolCallId === "string"
              ? part.toolCallId
              : "";
        const name = toolNames.get(toolCallId) ?? "tool";
        const text = readCommandCodeToolOutput(part.output ?? part.content);
        if (!text) continue;
        entries.push({
          kind: "tool_result",
          name,
          ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.tool_result),
          ...(at !== undefined ? { at } : {}),
        });
      }
      continue;
    }

    // 旧版 V2 把工具结果放在独立的 role:"tool" 消息里。
    if (role === "tool") {
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as {
          type?: unknown;
          toolCallId?: unknown;
          toolName?: unknown;
          output?: unknown;
        };
        if (part.type !== "tool-result") continue;
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
        const name =
          typeof part.toolName === "string" && part.toolName
            ? part.toolName
            : (toolNames.get(toolCallId) ?? "tool");
        const text = readCommandCodeToolOutput(part.output);
        if (!text) continue;
        entries.push({
          kind: "tool_result",
          name,
          ...clipTranscriptText(text, TRANSCRIPT_TEXT_LIMITS.tool_result),
          ...(at !== undefined ? { at } : {}),
        });
      }
    }
  }
  return paginateTranscript(entries, entries.length, options);
}

/** Command Code 工具结果正文：`{type:"text",value}`、纯字符串或 Anthropic content 数组。 */
function readCommandCodeToolOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  // V3 的 tool_result 直接给 content 数组（`[{type:"text",text}]`），不是信封对象。
  if (Array.isArray(output)) return readContentText(output);
  if (!output || typeof output !== "object") return "";
  const record = output as { value?: unknown; text?: unknown; content?: unknown };
  if (typeof record.value === "string") return record.value.trim();
  if (typeof record.text === "string") return record.text.trim();
  if (Array.isArray(record.content)) return readContentText(record.content);
  return "";
}

/**
 * 按条目序号从尾部切一页（claude-family 与 opencode 共用）。
 *
 * 分页规则只允许有一份：两个驱动如果各自实现，`hasMore`/预算裁剪的边界迟早分叉，
 * 面板"加载更早"就会在某些驱动上跳段。
 */
function paginateTranscript(
  entries: readonly ExternalAgentTranscriptEntry[],
  total: number,
  options: {
    sessionId: string;
    before?: number;
    limit?: number;
    sourceTruncated?: boolean;
  },
): ExternalAgentTranscriptPage {
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
