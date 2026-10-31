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
import {
  findingFingerprint,
  normalizeFindingPath,
  type StructuredFinding,
} from "@zcode/shared/oracle-review";

/**
 * findings 的解析与指纹已下沉到 `@zcode/shared/oracle-review`，桌面端审查队列
 * 与 CLI 共用同一套算法；这里只保留基线文件的读写与可写性预检。
 * 重新导出解析函数，原有调用方（review-command / 单测）不用改导入路径。
 */

export {
  findingFingerprint,
  parseStructuredFindings,
  severityForVerdict,
  type StructuredFinding,
} from "@zcode/shared/oracle-review";

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
      ...(finding.file ? { file: normalizeFindingPath(finding.file) } : {}),
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
