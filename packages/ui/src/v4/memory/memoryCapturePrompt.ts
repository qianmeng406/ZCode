/**
 * 「一键沉淀为记忆」的纯逻辑：提示词、结果解析、文件名与索引行。
 *
 * 放在纯函数里而不是塞进对话框：模型输出是不可信文本，解析/裁剪/文件名归一/索引用
 * 决定的边界都值得用表格驱动单测钉住，组件只负责展示与确认。
 */

export const MEMORY_CAPTURE_QUERY_SOURCE = "memory_capture";
/** 输入上限：一轮回复可能很长，沉淀只取有界片段，避免把整段历史再喂一次模型。 */
export const MEMORY_CAPTURE_MAX_INPUT_CHARS = 12_000;
export const MEMORY_CAPTURE_MAX_BODY_CHARS = 4_000;
export const MEMORY_CAPTURE_NAME_MAX_CHARS = 60;
export const MEMORY_CAPTURE_DESCRIPTION_MAX_CHARS = 140;

export const MEMORY_CAPTURE_TYPES = ["project", "user", "feedback", "reference"] as const;
export type MemoryCaptureType = (typeof MEMORY_CAPTURE_TYPES)[number];

export interface MemoryCaptureDraft {
  name: string;
  description: string;
  type: MemoryCaptureType;
  body: string;
}

export type MemoryCaptureParseResult =
  | { ok: true; draft: MemoryCaptureDraft }
  | { ok: false; reason: string };

const SYSTEM_PROMPT = [
  "You distill durable project memory from one finished coding turn.",
  "Return ONLY a JSON object, no prose and no code fences, with exactly these keys:",
  '{"name": string, "description": string, "type": "project" | "user" | "feedback" | "reference", "body": string}',
  "",
  "Rules:",
  `- name: a short title, at most ${MEMORY_CAPTURE_NAME_MAX_CHARS} characters.`,
  `- description: one line that will be shown in the memory index, at most ${MEMORY_CAPTURE_DESCRIPTION_MAX_CHARS} characters.`,
  "- body: Markdown with the durable fact itself, at most 4000 characters. Keep commands, paths, versions and environment details that a future session would need.",
  '- type: "project" for repo/workflow facts, "user" for who the user is, "feedback" for how the user wants work done, "reference" for external links or dashboards.',
  "- Record only what will still be true next week. Skip transitory steps, tool chatter and anything you are not sure about.",
  "- Never include secrets, tokens, keys or personal data.",
  '- If nothing in the turn is worth remembering, return {"name": ""}.',
].join("\n");

export function buildMemoryCaptureMessages(input: {
  assistantText: string;
  projectName: string;
}): Array<{ role: "system" | "user"; content: string }> {
  const excerpt = truncateMemoryCaptureInput(input.assistantText);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Project: ${input.projectName}`,
        "",
        "Excerpt of the assistant's final answer for this turn:",
        "<turn>",
        excerpt,
        "</turn>",
      ].join("\n"),
    },
  ];
}

export function truncateMemoryCaptureInput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MEMORY_CAPTURE_MAX_INPUT_CHARS) return trimmed;
  // 取尾部：结论与「下一步」通常在回复末尾，开头多是过程叙述。
  return `…${trimmed.slice(trimmed.length - MEMORY_CAPTURE_MAX_INPUT_CHARS)}`;
}

export function parseMemoryCaptureResult(text: string): MemoryCaptureParseResult {
  const json = extractJsonObject(text);
  if (json === undefined) return { ok: false, reason: "no-json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-json" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (name.length === 0 || body.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (!isMemoryCaptureType(type)) {
    return { ok: false, reason: "invalid-type" };
  }
  return {
    ok: true,
    draft: {
      name: name.slice(0, MEMORY_CAPTURE_NAME_MAX_CHARS),
      description: description.slice(0, MEMORY_CAPTURE_DESCRIPTION_MAX_CHARS),
      type,
      body: body.slice(0, MEMORY_CAPTURE_MAX_BODY_CHARS),
    },
  };
}

/** 文件名由标题归一而来：只留 ASCII 小写、数字与 `-`，避免越权字符与大小写别名。 */
export function memoryCaptureFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  return `${slug.length > 0 ? slug : "memory-note"}.md`;
}

export function buildMemoryIndexLine(input: {
  fileName: string;
  title: string;
  description: string;
}): string {
  const title = input.title.replace(/[[\]\r\n]+/gu, " ").trim() || input.fileName;
  const description = input.description.replace(/[\r\n]+/gu, " ").trim();
  return description.length > 0
    ? `- [${title}](${input.fileName}) — ${description}`
    : `- [${title}](${input.fileName})`;
}

/** 追加索引行；已有指向同一文件的链接时不重复追加（重复点击不产生重复行）。 */
export function appendMemoryIndexLine(indexContent: string | null, line: string): string {
  const linkMarker = extractLinkTarget(line);
  if (
    indexContent !== null &&
    linkMarker !== undefined &&
    indexContent.includes(`](${linkMarker})`)
  ) {
    return indexContent;
  }
  const base = indexContent === null || indexContent.trim().length === 0 ? null : indexContent;
  if (base === null) {
    return `# Memory\n\n${line}\n`;
  }
  const withoutTrailingBlankLines = base.replace(/[\r\n]+$/u, "");
  return `${withoutTrailingBlankLines}\n${line}\n`;
}

function extractLinkTarget(line: string): string | undefined {
  return /\]\(([^)\s]+)\)/u.exec(line)?.[1];
}

/**
 * 写入正文的文件形态：与 Memory Agent 生成的条目同一套 frontmatter
 * （`name` / `description` / `metadata.node_type: memory` / `metadata.type`），
 * 这样 Extraction、Dream 与索引消费方读到的都是同一种文件。
 */
export function formatMemoryCaptureFile(draft: MemoryCaptureDraft, fileName: string): string {
  const name = fileName.replace(/\.md$/u, "");
  return [
    "---",
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(draft.description)}`,
    "metadata:",
    "  node_type: memory",
    `  type: ${draft.type}`,
    "---",
    "",
    draft.body.trim(),
    "",
  ].join("\n");
}

function yamlScalar(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/[\r\n]+/gu, " ")}"`;
}

function isMemoryCaptureType(value: string): value is MemoryCaptureType {
  return (MEMORY_CAPTURE_TYPES as readonly string[]).includes(value);
}

/** 容忍模型偶尔多写的代码围栏或前后说明，但只接受一个完整对象。 */
function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/u.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}
