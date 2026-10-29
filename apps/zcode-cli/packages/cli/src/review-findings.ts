import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { OracleVerdict } from "@zcode/shared/oracle-review";

/**
 * findings 是模型自由文本与「已接受问题」清单之间的那一层：
 * 解析（正文 → 结构化发现项）和基线（生成/读取指纹）。放在这里是为了让
 * review-command 保持「取数 + 引导 + 输出」，也让基线格式只有一个真相来源。
 */

/** 结构化发现项：findings 正文是自由文本，这里做保守提取，不猜测位置。 */
export interface StructuredFinding {
  severity: "error" | "warning" | "note";
  message: string;
  file?: string;
  line?: number;
}

/**
 * 只做保守提取：行首的等级词 → SARIF level，行内的 `path:line` → 位置。
 * 识别不到就退化为整体裁决等级，不猜测、不编造位置——CI 行内标注因此可能少几条，
 * 但不会指错文件。
 */
const SEVERITY_WORDS: Readonly<Record<string, StructuredFinding["severity"]>> = {
  critical: "error",
  blocker: "error",
  high: "error",
  error: "error",
  严重: "error",
  致命: "error",
  medium: "warning",
  moderate: "warning",
  warning: "warning",
  warn: "warning",
  警告: "warning",
  中等: "warning",
  low: "note",
  minor: "note",
  info: "note",
  note: "note",
  轻微: "note",
  提示: "note",
};

const FINDING_LOCATION_PATTERN = /([\w@./\\-]+\.[A-Za-z0-9]{1,8}):(\d{1,7})/u;

export function severityForVerdict(verdict: OracleVerdict): StructuredFinding["severity"] {
  if (verdict === "fail") return "error";
  if (verdict === "warn") return "warning";
  return "note";
}

function detectFindingSeverity(message: string): StructuredFinding["severity"] | undefined {
  // 只认行首：正文里顺带出现的 severity 词不该改变整行等级。
  const head = message.replace(/^[[(【\s]+/u, "");
  const match = /^([A-Za-z]{3,10}|严重|致命|警告|中等|轻微|提示)/u.exec(head);
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

const BASELINE_RULE_ID = "oracle-review-finding";

export interface ReviewBaselineEntry {
  fingerprint: string;
  ruleId: string;
  severity: StructuredFinding["severity"];
  file?: string;
  line?: number;
  /** 原始摘要，只为人审阅；匹配只认 fingerprint。 */
  message: string;
}

export interface ReviewBaselineFile {
  schemaVersion: 1;
  accepted: ReviewBaselineEntry[];
}

/**
 * 基线指纹（生成与匹配共用，保证两边算法一致）：
 * - 有 `file:line` → 按位置，模型换措辞不会让基线失效；
 * - 只有文件没有行号 → 位置不唯一，退回「文件 + 摘要」；
 * - 完全没有位置 → 只按摘要。
 *
 * 代价写在明处：位置匹配意味着同一行上的**新问题**也会被一并抑制，
 * 所以基线文件应当由人审阅后再提交，不要把它当成「忽略所有警告」的开关。
 */
export function findingFingerprint(finding: StructuredFinding): string {
  if (finding.file) {
    const file = normalizeBaselinePath(finding.file);
    if (finding.line !== undefined) return `loc|${file}|${finding.line}`;
    return `file|${file}|${normalizeBaselineMessage(finding.message)}`;
  }
  return `msg|${normalizeBaselineMessage(finding.message)}`;
}

function normalizeBaselinePath(file: string): string {
  return file.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function normalizeBaselineMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBaselineFile(baselinePath: string): Set<string> | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    return new Error(`${baselinePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.accepted)) {
    return new Error(`${baselinePath}: expected { schemaVersion: 1, accepted: [...] }`);
  }
  const fingerprints = new Set<string>();
  for (const entry of parsed.accepted) {
    if (!isRecord(entry) || typeof entry.fingerprint !== "string" || !entry.fingerprint) {
      return new Error(`${baselinePath}: every accepted entry needs a non-empty "fingerprint"`);
    }
    fingerprints.add(entry.fingerprint);
  }
  return fingerprints;
}

export function writeBaselineFile(
  baselinePath: string,
  findings: readonly StructuredFinding[],
): void {
  const accepted: ReviewBaselineEntry[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    accepted.push({
      fingerprint,
      ruleId: BASELINE_RULE_ID,
      severity: finding.severity,
      ...(finding.file ? { file: normalizeBaselinePath(finding.file) } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      message: finding.message,
    });
  }
  const payload: ReviewBaselineFile = { schemaVersion: 1, accepted };
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * 写基线前的预检：在调用模型之前确认目标真的可写。
 *
 * 只做 `mkdirSync` 是不够的——父目录已存在时递归创建不会报错，
 * 「目录存在但不可写」要等模型跑完后的真正写入才暴露。所以这里做一次真实探测：
 * 目标已存在就用读写模式打开后立刻关闭（不写入、不截断；目录与只读文件都会在这一步失败）；
 * 目标不存在就在父目录写一个探针文件再删掉。
 */
export function prepareBaselineFile(baselinePath: string): Error | undefined {
  try {
    const directory = dirname(baselinePath);
    mkdirSync(directory, { recursive: true });
    if (existsSync(baselinePath)) {
      // Windows 上 open(dir, "r+") 会成功，但真正的 writeFileSync 必然 EISDIR；
      // 显式判目录，避免「目标其实是目录」拖到模型之后才暴露。
      if (statSync(baselinePath).isDirectory()) {
        throw new Error(`target is a directory: ${baselinePath}`);
      }
      closeSync(openSync(baselinePath, "r+"));
      return undefined;
    }
    const probePath = join(directory, `.zcode-baseline-probe-${process.pid}-${Date.now()}`);
    closeSync(openSync(probePath, "w"));
    unlinkSync(probePath);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
