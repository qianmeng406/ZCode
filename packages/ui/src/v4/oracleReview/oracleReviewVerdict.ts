/**
 * 裁决解析层（从 support.ts 拆出，控制文件行数）：VERDICT/SUMMARY/FINDINGS 与
 * 深度审查新增的 REQUIREMENTS/SCOPE/LIMITS 段的宽松解析。
 */

export type OracleVerdict = "pass" | "warn" | "fail" | "insufficient" | "unknown";

/**
 * 客户端 deadline 超时判定：协议 client 的 ZCodeProtocolRequestTimeoutError 有专属
 * name，且 RPC 层显式序列化/还原 name（channelServer/channelClient），因此按类型标记
 * 判定而不是匹配 message——AbortError、ETIMEDOUT、服务端自带 "timeout" 字样的错误
 * 都不会被误判进超时分支，原样走通用失败文案展示真实消息。
 */

export interface OracleVerdictParse {
  verdict: OracleVerdict;
  summary: string;
  /** findings 全文（多行）；unknown 时是模型原文，卡片直接展示不硬造结论。 */
  findings: string;
  /** deep：需求核验表（REQUIREMENTS 段原文，逐行）。 */
  requirements?: string;
  /** 本次审查覆盖范围（SCOPE 段）。 */
  scope?: string;
  /** 审查限制（LIMITS 段）。 */
  limits?: string;
}

const ORACLE_VERDICT_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:VERDICT|结论|判定)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+?)(?:\*\*)?\s*$/i;
const ORACLE_SUMMARY_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:SUMMARY|总结|总评)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*?)(?:\*\*)?\s*$/i;
const ORACLE_FINDINGS_LINE_PATTERN = /^\s*(?:\*\*)?(?:FINDINGS|问题清单)(?:\*\*)?\s*[:：]?\s*$/i;
const ORACLE_REQUIREMENTS_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:REQUIREMENTS|需求核验)(?:\*\*)?\s*[:：]?\s*$/i;
const ORACLE_SCOPE_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:SCOPE|范围|审查范围)(?:\*\*)?\s*[:：]\s*(.*?)\s*$/i;
const ORACLE_LIMITS_LINE_PATTERN =
  /^\s*(?:\*\*)?(?:LIMITS|限制)(?:\*\*)?\s*[:：]\s*(.*?)\s*$/i;

/** 宽松归一：认英文与中文同义表达；认不出返回 unknown。 */
function normalizeOracleVerdictWord(word: string): OracleVerdict {
  const w = word.trim().toLowerCase();
  if (!w) return "unknown";
  // 顺序即语义：不通过→fail（含「通过」字样），信息不足→insufficient，
  // 通过但…→warn，纯通过/PASS→pass。
  if (/^fail\b|失败|需要修复|不通过|不满足/.test(w)) return "fail";
  if (/^warn\b|注意|警告/.test(w)) return "warn";
  if (/^insufficient\b|信息不足|证据不足|材料不足|无法判断|无法评估/.test(w)) return "insufficient";
  if (/^pass\b|通过/.test(w)) return "pass";
  return "unknown";
}

/**
 * 模型偶尔不守格式：剥代码块/加粗包壳、认中文标签、扫前 10 行；解析不出降级
 * unknown 并保留原文。SCOPE/LIMITS/REQUIREMENTS 缺席时保持 undefined（旧结论
 * 与解析失败的结果都没有这些段）。
 */
export function parseOracleVerdict(raw: string): OracleVerdictParse {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  const lines = text.split("\n");
  let verdict: OracleVerdict = "unknown";
  let summary = "";
  for (const line of lines.slice(0, 10)) {
    const verdictMatch = line.match(ORACLE_VERDICT_LINE_PATTERN);
    if (verdictMatch) {
      verdict = normalizeOracleVerdictWord(verdictMatch[1]!);
      if (verdict !== "unknown") {
        break;
      }
    }
  }
  for (const line of lines.slice(0, 10)) {
    const summaryMatch = line.match(ORACLE_SUMMARY_LINE_PATTERN);
    if (summaryMatch) {
      summary = summaryMatch[1]!.trim();
      break;
    }
  }
  if (verdict === "unknown") {
    return { verdict, summary, findings: text };
  }
  // SCOPE/LIMITS 是单行段；REQUIREMENTS 是多行段（到 SCOPE/LIMITS 或文末为止）。
  let scope: string | undefined;
  let limits: string | undefined;
  for (const line of lines) {
    const scopeMatch = line.match(ORACLE_SCOPE_LINE_PATTERN);
    if (scopeMatch && scopeMatch[1]?.trim()) {
      scope = scopeMatch[1].trim();
      continue;
    }
    const limitsMatch = line.match(ORACLE_LIMITS_LINE_PATTERN);
    if (limitsMatch && limitsMatch[1]?.trim()) {
      limits = limitsMatch[1].trim();
    }
  }
  const requirementsIndex = lines.findIndex((line) => ORACLE_REQUIREMENTS_LINE_PATTERN.test(line));
  const findingsIndex = lines.findIndex((line) => ORACLE_FINDINGS_LINE_PATTERN.test(line));
  const collectUntil = (from: number, stopPatterns: RegExp[]): string => {
    const collected: string[] = [];
    for (let index = from; index < lines.length; index += 1) {
      if (stopPatterns.some((pattern) => pattern.test(lines[index]!))) break;
      collected.push(lines[index]!);
    }
    return collected.join("\n").trim();
  };
  const stopAfterBody = [ORACLE_SCOPE_LINE_PATTERN, ORACLE_LIMITS_LINE_PATTERN];
  // 无 FINDINGS 段时的回退切片：判定行识别必须与主模式同一套模式（含「判定」
  // 别名与加粗/全角冒号），否则「判定：」风格输出的判定行会连同 SCOPE/LIMITS/
  // REQUIREMENTS 段一起被吞进 findings 重复展示、并被一键修复整段注入。
  const verdictLineIndex = lines.findIndex(
    (line) =>
      ORACLE_VERDICT_LINE_PATTERN.test(line) ||
      /^\s*(?:\*\*)?(?:VERDICT|结论|判定)(?:\*\*)?\s*[:：]/i.test(line),
  );
  const findings =
    findingsIndex >= 0
      ? collectUntil(findingsIndex + 1, [
          ...stopAfterBody,
          ORACLE_REQUIREMENTS_LINE_PATTERN,
        ])
      : lines
          .slice(verdictLineIndex + 1)
          .filter((line) => !ORACLE_SUMMARY_LINE_PATTERN.test(line))
          .filter(
            (line) =>
              !stopAfterBody.some((pattern) => pattern.test(line)) &&
              !ORACLE_REQUIREMENTS_LINE_PATTERN.test(line),
          )
          .join("\n")
          .trim();
  const requirements =
    requirementsIndex >= 0 ? collectUntil(requirementsIndex + 1, stopAfterBody) : undefined;
  return {
    verdict,
    summary,
    findings,
    ...(requirements ? { requirements } : {}),
    ...(scope ? { scope } : {}),
    ...(limits ? { limits } : {}),
  };
}

