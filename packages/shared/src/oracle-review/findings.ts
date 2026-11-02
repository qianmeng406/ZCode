import type { OracleVerdict } from "./verdict.js";

/**
 * findings 是模型自由文本与结构化视图之间的那一层。
 *
 * 这里只做**保守提取**：行首的等级词决定 severity，行内的 `path:line` 才带位置；
 * 识别不到就退化为整体裁决等级，不猜测、不编造位置。CI 行内标注因此可能少几条，
 * 但不会指错文件。CLI 的 baseline/SARIF、桌面端审查队列共用同一套解析与指纹。
 *
 * 行为说明：审查 prompt 使用 `- [高|中|低] 位置 — 问题`，这里补上 `高/中/低` 后，
 * 这类行不再落入"按整体裁决兜底"的旧路径，而是解析出显式等级。因此 CLI 的
 * baseline/SARIF 对同类输出的等级判定会变化（更准确，但不是逐字节兼容）。
 */

/** 结构化发现项：findings 正文是自由文本，这里做保守提取，不猜测位置。 */
export interface StructuredFinding {
  severity: "error" | "warning" | "note";
  message: string;
  file?: string;
  line?: number;
}

const SEVERITY_WORDS: Readonly<Record<string, StructuredFinding["severity"]>> = {
  critical: "error",
  blocker: "error",
  high: "error",
  error: "error",
  严重: "error",
  致命: "error",
  高: "error",
  medium: "warning",
  moderate: "warning",
  warning: "warning",
  warn: "warning",
  警告: "warning",
  中等: "warning",
  中: "warning",
  low: "note",
  minor: "note",
  info: "note",
  note: "note",
  轻微: "note",
  提示: "note",
  低: "note",
};

const FINDING_LOCATION_PATTERN = /([\w@./\\-]+\.[A-Za-z0-9]{1,8}):(\d{1,7})/u;

/**
 * 机器标记行：审查输出的段落标题与裁决行。它们不是问题条目——
 * 真实问题只来自 `- [高|中|低] 位置 — 问题` 这类列表项。
 * 模型偶尔不按格式输出（把段落写成 `FINDINGS:` / `VERDICT: FAIL` 等独立行），
 * 旧逻辑会把每一行都当成一条发现，审查队列因此出现几十条"待审"噪声
 * （2026-11-02 线上：75 条待审里只有 1 条是真问题）。
 */
const SECTION_MARKER_PATTERN =
  /^\s*(?:\*\*)?(?:VERDICT|SUMMARY|FINDINGS|REQUIREMENTS|SCOPE|LIMITS|结论|判定|总评|摘要|发现|需求|范围|限制)(?:\*\*)?\s*[:：]/iu;
/** findings 段内常见的空/无问题标记。 */
const NO_FINDINGS_LINE_PATTERN =
  /^\s*(?:[-*+•]\s*)?(?:\*\*)?(?:无|none|no findings|no issues|没有(?:发现)?问题)(?:\*\*)?\s*[。.]?\s*$/iu;

export function severityForVerdict(verdict: OracleVerdict): StructuredFinding["severity"] {
  if (verdict === "fail") return "error";
  if (verdict === "warn") return "warning";
  return "note";
}

function detectFindingSeverity(message: string): StructuredFinding["severity"] | undefined {
  // 只认行首：正文里顺带出现的 severity 词不该改变整行等级。
  const head = message.replace(/^[[(【\s]+/u, "");
  // 审查 prompt 要求 `- [高|中|低] 位置 — 问题`，英文模板则用 high/medium/low。
  const match = /^([A-Za-z]{3,10}|严重|致命|警告|中等|轻微|提示|高|中|低)/u.exec(head);
  return match?.[1] ? SEVERITY_WORDS[match[1].toLowerCase()] : undefined;
}

export function parseStructuredFindings(
  findings: string,
  verdict: OracleVerdict,
): StructuredFinding[] {
  const fallback = severityForVerdict(verdict);
  const result: StructuredFinding[] = [];
  for (const raw of findings.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    // 段落标题 / 裁决行不是问题条目：模型不按格式输出时会留下一串这类行，
    // 逐行成条会把审查队列刷满噪声待审项。
    if (SECTION_MARKER_PATTERN.test(line)) continue;
    if (NO_FINDINGS_LINE_PATTERN.test(line)) continue;
    // 去掉列表符号/编号，保留正文：message 要给行内 annotation 直接读。
    const message = line.replace(/^[-*+•]\s+/u, "").replace(/^\d+[.)]\s+/u, "");
    if (!message) continue;
    const location = FINDING_LOCATION_PATTERN.exec(message);
    result.push({
      severity: detectFindingSeverity(message) ?? fallback,
      message,
      ...(location?.[1] && location[2]
        ? { file: location[1], line: Number.parseInt(location[2], 10) }
        : {}),
    });
  }
  return result;
}

/**
 * 基线/队列指纹（生成与匹配共用，保证两边算法一致）：
 * - 有 `file:line` → 按位置，模型换措辞不会让基线失效；
 * - 只有文件没有行号 → 位置不唯一，退回「文件 + 摘要」；
 * - 完全没有位置 → 只按摘要。
 *
 * 代价写在明处：位置匹配意味着同一行上的**新问题**也会被一并抑制，
 * 所以基线文件应当由人审阅后再提交，不要把它当成「忽略所有警告」的开关。
 */
export function findingFingerprint(finding: StructuredFinding): string {
  if (finding.file) {
    const file = normalizeFindingPath(finding.file);
    if (finding.line !== undefined) return `loc|${file}|${finding.line}`;
    return `file|${file}|${normalizeFindingMessage(finding.message)}`;
  }
  return `msg|${normalizeFindingMessage(finding.message)}`;
}

export function normalizeFindingPath(file: string): string {
  return file.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function normalizeFindingMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/gu, " ").trim();
}
