import type { ConversationRow } from "../zcode-protocol-v4/rows.js";

/**
 * 会话交接文档的纯逻辑：把 v4 行投影成可交给另一个 agent 的文本。
 *
 * 两条路径共用同一份输入：
 * - 智能摘要：`buildSessionHandoffTranscript` + `buildSessionHandoffPrompt` 交给模型；
 * - 确定性兜底：`buildDeterministicHandoffMarkdown` 直接排版，模型不可用时仍可交付。
 */

const DEFAULT_MAX_TRANSCRIPT_CHARS = 24_000;
const DETERMINISTIC_TOOL_LINES_MAX = 30;
// 工具条目只保留「定位信息」（文件/命令/URL），不再整段铺 JSON：
// 完整输入动辄几百字符，会把交接文档和模型预算都吃在参数原文上。
const TOOL_TARGET_MAX_CHARS = 200;
const TOOL_OUTPUT_MAX_CHARS = 800;
// 单条用户/助手消息同样封顶：一条粘贴的大日志能独占整个预算，且预算裁剪
// 循环「至少保留最后一条」——单条超预算时整个文档必然超预算。
const USER_ASSISTANT_MAX_CHARS = 6_000;

export interface SessionHandoffOptions {
  /** 正文字符预算；超出时丢弃更早的条目并保留最近内容。 */
  maxChars?: number;
  /** 是否把工具调用写进交接材料（默认 true）。 */
  includeTools?: boolean;
}

interface TranscriptEntry {
  heading: string;
  body: string;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function toolOutputText(row: Extract<ConversationRow, { kind: "toolCall" }>): string {
  if (row.error) return `error: ${row.error.message}`;
  const preview = row.outputPreview?.text ?? "";
  if (preview) return preview;
  if (typeof row.output === "string") return row.output;
  if (row.output && typeof row.output === "object" && "text" in row.output) {
    const text = (row.output as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** 从工具输入里提取最有定位价值的一个字段；解析不了就退回原文截断。 */
function toolTarget(row: Extract<ConversationRow, { kind: "toolCall" }>): string {
  const input = row.inputText.trim();
  if (!input) return "";
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["file_path", "path", "command", "url", "query", "pattern"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return clip(value, TOOL_TARGET_MAX_CHARS);
      }
    }
  } catch {
    // 非 JSON 输入：按原文保留一小段。
  }
  return clip(input, TOOL_TARGET_MAX_CHARS);
}

function rowEntries(rows: readonly ConversationRow[], includeTools: boolean): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const row of rows) {
    if (row.kind === "userInput") {
      if (!row.text.trim()) continue;
      entries.push({ heading: "用户", body: clip(row.text, USER_ASSISTANT_MAX_CHARS) });
      continue;
    }
    if (row.kind === "assistantText") {
      if (!row.text.trim()) continue;
      entries.push({ heading: "助手", body: clip(row.text, USER_ASSISTANT_MAX_CHARS) });
      continue;
    }
    if (row.kind === "toolCall" && includeTools) {
      const target = toolTarget(row);
      const output = toolOutputText(row);
      const head = `工具：${row.toolName}（${row.status}）${target ? ` → ${target}` : ""}`;
      const lines = [head];
      if (output) lines.push(`输出：${clip(output, TOOL_OUTPUT_MAX_CHARS)}`);
      entries.push({ heading: "工具", body: lines.join("\n") });
    }
  }
  return entries;
}

/**
 * 逐条投影成「标题 + 正文」；超预算时从最早处丢弃，保证最近的决定与阻塞留在文档里。
 */
export function buildSessionHandoffTranscript(
  rows: readonly ConversationRow[],
  options: SessionHandoffOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const entries = rowEntries(rows, options.includeTools ?? true);
  const rendered = entries.map((entry) => `### ${entry.heading}\n${entry.body}`);
  let total = rendered.reduce((sum, text) => sum + text.length + 2, 0);
  let start = 0;
  while (total > maxChars && start < rendered.length - 1) {
    total -= (rendered[start]?.length ?? 0) + 2;
    start += 1;
  }
  if (start === 0) return rendered.join("\n\n");
  return ["[... 更早的会话内容已省略 ...]", ...rendered.slice(start)].join("\n\n");
}

/**
 * 智能摘要的提示词：强调"给下一个接手的人"而不是复盘报告，并要求固定小节，
 * 便于复制到任何 agent / 人。
 */
export function buildSessionHandoffPrompt(transcript: string, title: string): string {
  return [
    "你正在把一段 AI 编码会话整理成交接文档，读者是接下来接手这个任务的人或 agent。",
    "只写接手所必需的事实，不要客套，不要复述完整对话。",
    "",
    `会话标题：${title}`,
    "",
    "请严格按以下小节输出 Markdown：",
    "## 当前目标",
    "## 已决策",
    "## 涉及的文件与命令",
    "## 阻塞与风险",
    "## 下一步",
    "",
    "规则：",
    "- 只写材料里有依据的内容；不确定的写「待确认」，不要编造。",
    "- 文件、命令、测试名尽量原样保留。",
    "- 「下一步」给出可执行的 1-3 条。",
    "- 全文控制在 1000 字以内；逐条列工具调用属于复盘，不要写。",
    "- 材料开头的「[... 更早的会话内容已省略 ...]」表示更早内容未提供：",
    "  摘要只基于给出的材料；若明显缺少关键上下文，在「阻塞与风险」里写",
    "  「更早上下文未包含在材料中」，不要推测被省略的内容。",
    "",
    "会话材料：",
    transcript,
  ].join("\n");
}

function firstUserText(rows: readonly ConversationRow[]): string {
  for (const row of rows) {
    if (row.kind === "userInput" && row.text.trim()) return row.text.trim();
  }
  return "";
}

function lastUserText(rows: readonly ConversationRow[]): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "userInput" && row.text.trim()) return row.text.trim();
  }
  return "";
}

function toolLines(rows: readonly ConversationRow[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const key = `${row.toolName}\u0000${row.inputText.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const command = row.toolName === "Bash" ? clip(extractCommand(row.inputText), 200) : "";
    lines.push(command ? `- \`${command}\`` : `- ${row.toolName}`);
  }
  if (lines.length <= DETERMINISTIC_TOOL_LINES_MAX) return lines;
  // 长会话会积累几百条命令；只保留最近的，省略条数写明，避免交接文档被命令列表淹没。
  const omitted = lines.length - DETERMINISTIC_TOOL_LINES_MAX;
  return [`- …更早的 ${omitted} 条工具调用已省略`, ...lines.slice(-DETERMINISTIC_TOOL_LINES_MAX)];
}

function extractCommand(inputText: string): string {
  try {
    const parsed: unknown = JSON.parse(inputText);
    if (parsed && typeof parsed === "object" && "command" in parsed) {
      const command = (parsed as { command?: unknown }).command;
      if (typeof command === "string") return command;
    }
  } catch {
    // 非 JSON 输入：按原文保留一段。
  }
  return inputText.replace(/\s+/gu, " ").trim();
}

/**
 * 确定性兜底：不调用模型，按固定小节把事实摊开。内容会比智能摘要长，
 * 但生成是零成本、可离线，且不会因为模型失败而让用户拿不到交接文档。
 */
export function buildDeterministicHandoffMarkdown(
  rows: readonly ConversationRow[],
  title: string,
): string {
  const objective = firstUserText(rows);
  const latestAsk = lastUserText(rows);
  const transcript = buildSessionHandoffTranscript(rows, {
    maxChars: DEFAULT_MAX_TRANSCRIPT_CHARS,
  });
  const tools = toolLines(rows);
  return [
    `# 会话交接：${title}`,
    "",
    "## 当前目标",
    objective || "（会话里没有用户输入）",
    ...(latestAsk && latestAsk !== objective ? ["", `最近一次请求：${latestAsk}`] : []),
    "",
    "## 涉及的文件与命令",
    tools.length > 0 ? tools.join("\n") : "（这次会话没有调用工具）",
    "",
    "## 会话内容",
    transcript || "（空会话）",
    "",
    "## 下一步",
    latestAsk
      ? `- 按最近一次请求继续：${clip(latestAsk, 200)}`
      : "- 先确认这次会话要交付的目标（材料里没有用户输入）。",
    "",
    "## 备注",
    "本文由确定性模板生成（模型摘要不可用）；内容取自会话原始记录。",
    "",
  ].join("\n");
}
