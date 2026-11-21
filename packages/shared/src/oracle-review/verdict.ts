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
const ORACLE_LIMITS_LINE_PATTERN = /^\s*(?:\*\*)?(?:LIMITS|限制)(?:\*\*)?\s*[:：]\s*(.*?)\s*$/i;
/**
 * 段落标题行（含裁决/总评）：回退切片与结构化解析都要挡掉。
 * 与 findings.ts 的 SECTION_MARKER_PATTERN 同义，两处各自定义以保持模块独立。
 */
const ORACLE_SECTION_MARKER_PATTERN =
  /^\s*(?:\*\*)?(?:VERDICT|SUMMARY|FINDINGS|REQUIREMENTS|SCOPE|LIMITS|结论|判定|总评|总结|摘要|发现|问题清单|需求核验|审查范围|范围|限制)(?:\*\*)?\s*[:：]/iu;

/**
 * 否定式「通过」：语义是否定，但字面含「通过」。
 *
 * 修复原因（2026-11-18，B1-01）：旧实现用 `/^pass\b|通过/` 兜底，任何含「通过」的
 * 词组都被判 pass——「未通过」「不能通过」「无法通过」「尚未通过」「不能算通过」
 * 全部反向，审查把失败判成通过。这里把否定/不确定表达显式先判，再走肯定匹配。
 * 顺序仍然是语义优先：不确定 > 否定 > 肯定。
 */
function classifyChineseVerdictPhrase(w: string): OracleVerdict | undefined {
  // 1) 不确定：既不是通过也不是失败，保留证据不足语义，不得强判任一极性。
  //    「无法判断是否通过」「无法确认通过」「不能确定能否通过」都落这里，必须在否定规则之前——
  //    它们含「无法/不能」字样，若走否定规则会被判成确定 fail，而方案明确要求保留不确定。
  if (/无法判断|无法确认|无法评估|不能确定|难以判断|说不准|无法核实/.test(w)) return "insufficient";
  // 2) 否定：出现任一否定词就判 fail。这些词与「通过」共现时否定优先。
  if (/未通过|没通过|没有通过|尚未|未满足|不满足|不能通过|无法通过|不得通过|不予通过/.test(w)) {
    return "fail";
  }
  // 3) 「不能」/「无法」+ 通过/达标 的组合（含中间插字，如「不能算通过」）。
  if (/(?:不能|无法|不得|不予)[^，。；\n]{0,6}(?:通过|达标|满足)/.test(w)) return "fail";
  return undefined;
}

/** 宽松归一：认英文与中文同义表达；认不出返回 unknown。 */
function normalizeOracleVerdictWord(word: string): OracleVerdict {
  const w = word.trim().toLowerCase();
  if (!w) return "unknown";
  // 顺序即语义：不确定 → 否定 → 警告 → 肯定。中文否定必须先于肯定判定，
  // 否则「未通过」会被 `通过` 吞成 pass。
  const chinese = classifyChineseVerdictPhrase(w);
  if (chinese) return chinese;
  if (/^fail\b|失败|需要修复|不通过/.test(w)) return "fail";
  if (/^warn\b|注意|警告/.test(w)) return "warn";
  if (/^insufficient\b|信息不足|证据不足|材料不足/.test(w)) return "insufficient";
  // 肯定兜底：只认「通过」前面没有否定的情形（否定已在上方返回）。
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
      ? collectUntil(findingsIndex + 1, [...stopAfterBody, ORACLE_REQUIREMENTS_LINE_PATTERN])
      : lines
          .slice(verdictLineIndex + 1)
          .filter((line) => !ORACLE_SUMMARY_LINE_PATTERN.test(line))
          // 无 FINDINGS 段的回退切片同样要挡掉段落标题行：模型按 REVIEW 风格
          // 输出时，"FINDINGS:"/"REQUIREMENTS:"/"SCOPE:" 这些标题行会被当成
          // 发现项，审查队列于是出现几十条纯标题噪声（2026-11-02 线上）。
          .filter((line) => !ORACLE_SECTION_MARKER_PATTERN.test(line))
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

/**
 * findings 是否为空（结构化判空，供「通过且无问题」的唯一移交豁免使用）。
 *
 * 模型对「没有问题」的写法有无限变体（「无」「无问题清单」「（无）」「None」「N/A」…），
 * 按措辞正则匹配会漏；这里先归一化——去空白、去掉括号/引号/标点这类包装后，只认
 * 少量明确的空语义占位词，其余一律视为「有问题」。宁可多给一次移交入口，也不把
 * 真实问题当空结论吞掉。
 */
const ORACLE_EMPTY_FINDINGS_WORDS = new Set([
  "无",
  "无问题",
  "无问题清单",
  "没有问题",
  "none",
  "nothing",
  // 归一化会去掉空白与 "/"，这里存的是归一化后的形态。
  "nofindings",
  "noissues",
  "na",
]);

export function isOracleFindingsEmpty(text: string): boolean {
  const normalized = text
    // 全角空格/零宽字符与所有包装标点不参与判空。
    .replace(/[\s\u3000\u200b]+/gu, "")
    .replace(/[（）()【】\[\]「」『』“”"'’‘<>《》。．.，,、:：;；!！?？—–\-_*/\\|~`]/gu, "")
    .toLowerCase();
  return normalized.length === 0 || ORACLE_EMPTY_FINDINGS_WORDS.has(normalized);
}
