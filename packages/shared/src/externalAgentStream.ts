// claude-family `stream-json` 的解析：产出结构化活动条目。
//
// 为什么正文/思考只取完整消息（2026-11-05）：执行端给驱动层的实时进度是
// 「最后 N 字节」的滚动尾窗快照，输出一快窗口就滑动，前缀差分既会重复又会
// 丢段——用 delta 拼出来的正文是乱序碎片（实测把最终回答拼成"不同段落接龙"）。
// 而 stream-json 每轮模型输出都会跟一条**完整** `assistant` 消息，text/thinking/
// tool_use 都在其中且顺序可靠。所以：
// 1. delta 一律不产出条目（只保留"思考开始"的空标记给 UI 做"正在思考"）；
// 2. 正文/思考/工具一律以完整消息为准；
// 3. 半行 JSON 留在缓冲里等下一次。
import { z } from "zod";

export const externalAgentActivityEntrySchema = z
  .object({
    kind: z.enum(["reasoning", "text", "tool"]),
    text: z.string(),
  })
  .strict();
export type ExternalAgentActivityEntry = z.infer<typeof externalAgentActivityEntrySchema>;

export interface ClaudeStreamParser {
  /** 喂一段 stdout 文本，返回本次新产生的条目（可能为空）。 */
  push(chunk: string): ExternalAgentActivityEntry[];
  /** 进程结束时把残留的半行也尝试解析。 */
  flush(): ExternalAgentActivityEntry[];
}

/**
 * 对**完整**的 stream-json 输出做一次性解析（收口时的权威重建）。
 *
 * 执行中的实时进度是滚动尾窗快照，行会被窗口切断、内容会重复/丢失；
 * 进程结束后 stdout artifact 里有全量字节，用它整体重解析出的条目
 * 才是完整且有序的。driver 在收口时用这份结果替换活动条目。
 */
export function parseClaudeFamilyStreamActivities(stdout: string): ExternalAgentActivityEntry[] {
  const parser = createClaudeStreamParser();
  const entries = parser.push(stdout);
  return [...entries, ...parser.flush()];
}

const MAX_TOOL_DETAIL = 160;

export function createClaudeStreamParser(): ClaudeStreamParser {
  let buffer = "";

  const parseLine = (rawLine: string): ExternalAgentActivityEntry[] => {
    const line = rawLine.trim();
    if (!line) return [];
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return [];
    }
    if (!entry || typeof entry !== "object") return [];
    const record = entry as {
      type?: unknown;
      event?: unknown;
      message?: unknown;
    };

    // 增量事件不产出正文/思考条目（滚动尾窗差分不可靠，见文件头）；
    // 只保留「思考块开始」作为「正在思考」的信号给 UI。
    if (record.type === "stream_event" && record.event && typeof record.event === "object") {
      const event = record.event as { type?: unknown; content_block?: unknown };
      if (event.type !== "content_block_start") return [];
      const block = event.content_block as { type?: unknown } | undefined;
      return block?.type === "thinking" ? [{ kind: "reasoning", text: "" }] : [];
    }

    if (record.type !== "assistant" || !record.message || typeof record.message !== "object") {
      return [];
    }
    const content = (record.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const entries: ExternalAgentActivityEntry[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const item = part as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
        entries.push({ kind: "reasoning", text: item.thinking.trim() });
        continue;
      }
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        entries.push({ kind: "text", text: item.text });
        continue;
      }
      if (item.type !== "tool_use" || typeof item.name !== "string") continue;
      entries.push({
        kind: "tool",
        text: describeToolUse(item.name, item.input),
      });
    }
    return entries;
  };

  const consume = (text: string): ExternalAgentActivityEntry[] => {
    buffer += text;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    return lines.flatMap(parseLine);
  };

  return {
    push(chunk) {
      return consume(chunk);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return rest ? parseLine(rest) : [];
    },
  };
}

/**
 * 工具调用的单行描述：取最有信息量的那个入参。
 *
 * 活动卡只展示「它现在在做什么」，一行足够；超 160 字符的入参（整段脚本）截断，
 * 否则一条工具调用就能把卡片撑成一屏代码。
 */
function describeToolUse(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const readString = (key: string): string | undefined =>
    typeof args[key] === "string" && (args[key] as string).trim()
      ? (args[key] as string).trim()
      : undefined;
  const detail =
    readString("command") ??
    readString("file_path") ??
    readString("path") ??
    readString("pattern") ??
    readString("query");
  if (!detail) return name;
  return `${name}: ${detail.length > MAX_TOOL_DETAIL ? `${detail.slice(0, MAX_TOOL_DETAIL)}…` : detail}`;
}

// ── opencode（`opencode run --format json`，JSONL）──
//
// 事件形状（v2.2.5 实测）：
//   {type:"text"|"reasoning", part:{text}}
//   {type:"tool_use", part:{tool, state:{input, output}}}
//   {type:"step_start"|"step_finish"|"retry"|"error", ...}
// 与 claude 族的差别是两个字段层：正文在 `part.text`（不是 message.content 数组），
// 工具名在 `part.tool`、入参在 `part.state.input`。所以必须单独解析，不能复用
// claude 的行解析器。
//
// 与 claude 相同的两条纪律：
// 1. 每行本身就是一个完整事件（opencode 没有 claude 那种 delta 流），所以直接产出条目；
// 2. 半行 JSON 留在缓冲里等下一次，不产出——半个事件解析出来的字段是残的。

/**
 * 对**完整**的 opencode 输出做一次性解析（收口时的权威重建）。
 *
 * 理由同 parseClaudeFamilyStreamActivities：运行中的实时进度是滚动尾窗快照，
 * 只有进程结束后的 stdout artifact 才有全量有序字节。
 */
export function parseOpencodeStreamActivities(stdout: string): ExternalAgentActivityEntry[] {
  const parser = createOpencodeStreamParser();
  const entries = parser.push(stdout);
  return [...entries, ...parser.flush()];
}

export function createOpencodeStreamParser(): ClaudeStreamParser {
  let buffer = "";

  const parseLine = (rawLine: string): ExternalAgentActivityEntry[] => {
    const line = rawLine.trim();
    if (!line) return [];
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return [];
    }
    if (!entry || typeof entry !== "object") return [];
    const record = entry as { type?: unknown; part?: unknown };
    const part = (record.part && typeof record.part === "object" ? record.part : {}) as {
      text?: unknown;
      tool?: unknown;
      state?: unknown;
    };
    if (record.type === "text") {
      // 空文本不产出：step 边界处常见的空 text 事件会在面板上留一堆空行。
      return typeof part.text === "string" && part.text.trim()
        ? [{ kind: "text", text: part.text }]
        : [];
    }
    if (record.type === "reasoning") {
      return typeof part.text === "string" && part.text.trim()
        ? [{ kind: "reasoning", text: part.text }]
        : [];
    }
    if (record.type === "tool_use") {
      if (typeof part.tool !== "string" || !part.tool) return [];
      const state = part.state && typeof part.state === "object" ? part.state : {};
      const name = part.tool;
      const input = (state as { input?: unknown }).input;
      return [{ kind: "tool", text: describeToolUse(name, input) }];
    }
    // step_start / step_finish / retry / error / 未知 type：不是"过程"，不产出。
    return [];
  };

  const consume = (text: string): ExternalAgentActivityEntry[] => {
    buffer += text;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    return lines.flatMap(parseLine);
  };

  return {
    push(chunk) {
      return consume(chunk);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return rest ? parseLine(rest) : [];
    },
  };
}
