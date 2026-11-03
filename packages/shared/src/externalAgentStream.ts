// claude-family `stream-json` 的增量解析：产出结构化活动条目。
//
// 为什么需要状态：codebuddy 的 stream-json 有两种粒度混在一起——
// - `stream_event` 里的 content_block_delta（思考/正文的增量，实时）；
// - `assistant` 完整消息（包括 tool_use；正文/思考也已经以 delta 到过）。
//
// 所以这里的纪律是：
// 1. delta 一律先到先用（活动卡要即时感）；
// 2. 完整消息里的 text/thinking 只在**没收到过对应 delta** 时才补发，避免重复；
// 3. tool_use 只在完整消息里出现，正常产出；
// 4. 半行 JSON 留在缓冲里等下一次。
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

const MAX_TOOL_DETAIL = 160;

export function createClaudeStreamParser(): ClaudeStreamParser {
  let buffer = "";
  let sawTextDelta = false;
  let sawThinkingDelta = false;

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
    const record = entry as { type?: unknown; event?: unknown; message?: unknown };

    // 增量事件：思考与正文都实时到。
    if (record.type === "stream_event" && record.event && typeof record.event === "object") {
      const event = record.event as { type?: unknown; delta?: unknown };
      if (event.type !== "content_block_delta" || !event.delta || typeof event.delta !== "object")
        return [];
      const delta = event.delta as { type?: unknown; thinking?: unknown; text?: unknown };
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        sawThinkingDelta = true;
        return [{ kind: "reasoning", text: delta.thinking }];
      }
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        sawTextDelta = true;
        return [{ kind: "text", text: delta.text }];
      }
      return [];
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
        if (!sawThinkingDelta) entries.push({ kind: "reasoning", text: item.thinking.trim() });
        continue;
      }
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        if (!sawTextDelta) entries.push({ kind: "text", text: item.text });
        continue;
      }
      if (item.type !== "tool_use" || typeof item.name !== "string") continue;
      entries.push({ kind: "tool", text: describeToolUse(item.name, item.input) });
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

/** 工具调用的单行描述：取最有信息量的那个入参。 */
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
