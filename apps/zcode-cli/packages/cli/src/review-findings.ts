import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
  const directory = dirname(baselinePath);
  mkdirSync(directory, { recursive: true });
  // 原子替换（B1-06）：先写同目录临时文件再 rename。直接 writeFileSync 到目标时，
  // 写到一半失败（磁盘满、进程被杀）会把旧基线留成截断的半个 JSON，下一次审查读基线
  // 直接报结构错误——用户既丢基线又丢新结果。临时文件必须与目标同目录，rename 才在
  // 同一文件系统内保持原子性。
  const tempPath = join(directory, `.zcode-baseline-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempPath, baselinePath);
  } catch (error) {
    // 失败时清掉临时文件，旧目标文件保持原样。
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
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
