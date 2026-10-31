import type { ZCodeOracleReviewRecord } from "@zcode/shared";
import {
  findingFingerprint,
  parseStructuredFindings,
  severityForVerdict,
  type StructuredFinding,
} from "@zcode/shared/oracle-review";

/**
 * 会话内审查队列：把持久化的 Oracle 审查记录摊平成「按风险排序的待审条目」。
 *
 * 记录本身只保存 findings 自由文本（`rawOutput` 全文 / `findings` 段），没有结构化
 * 位置与严重度；这里复用 CLI 同一套解析与指纹，让「跳代码 / 标已读 / 去重」都有
 * 稳定键，同时不改协议、不为旧记录做迁移。
 */

export type ReviewQueueSeverity = StructuredFinding["severity"];

export interface ReviewQueueItem {
  /** fingerprint；同一发现跨重新审查只要位置/措辞不变就仍是同一条。 */
  key: string;
  reviewId: string;
  sessionId: string;
  fingerprint: string;
  severity: ReviewQueueSeverity;
  message: string;
  file?: string;
  line?: number;
  verdict: ZCodeOracleReviewRecord["verdict"];
  summary: string;
  depth: ZCodeOracleReviewRecord["depth"];
  modelLabel: string;
  completedAt: number;
  /** 记录级确认（✕ 关闭 / 整段移交）；队列的逐条已读另存本地。 */
  acknowledgedAt?: number;
  /** 无法解析出发现项时，用结论摘要合成的一条，避免「有结论没条目」。 */
  synthesized: boolean;
}

const SEVERITY_RANK: Record<ReviewQueueSeverity, number> = {
  error: 3,
  warning: 2,
  note: 1,
};

function reviewOutput(record: ZCodeOracleReviewRecord): string {
  return (record.rawOutput ?? record.findings ?? "").trim();
}

function toQueueItem(
  record: ZCodeOracleReviewRecord,
  finding: StructuredFinding,
  synthesized: boolean,
): ReviewQueueItem {
  const fingerprint = findingFingerprint(finding);
  return {
    key: fingerprint,
    reviewId: record.reviewId,
    sessionId: record.sessionId,
    fingerprint,
    severity: finding.severity,
    message: finding.message,
    ...(finding.file ? { file: finding.file } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    verdict: record.verdict,
    summary: record.summary,
    depth: record.depth,
    modelLabel: record.modelLabel,
    completedAt: record.completedAt,
    ...(record.acknowledgedAt !== undefined ? { acknowledgedAt: record.acknowledgedAt } : {}),
    synthesized,
  };
}

/**
 * 只把有结论可审的记录放进队列：pass 没有待办；fail/warn 即使解析不出条目，
 * 也用摘要合成一条，避免用户只看到"审查失败"却没有任何可操作项。
 */
export function buildReviewQueue(records: readonly ZCodeOracleReviewRecord[]): ReviewQueueItem[] {
  const byKey = new Map<string, ReviewQueueItem>();
  for (const record of records) {
    if (record.verdict === "pass") continue;
    const parsed = parseStructuredFindings(reviewOutput(record), record.verdict);
    if (parsed.length === 0) {
      const summary = record.summary.trim();
      if (!summary && record.verdict !== "fail" && record.verdict !== "warn") continue;
      const synthesized: StructuredFinding = {
        severity: severityForVerdict(record.verdict),
        message: summary || record.verdict.toUpperCase(),
      };
      const item = toQueueItem(record, synthesized, true);
      const existing = byKey.get(item.key);
      if (!existing || existing.completedAt < item.completedAt) byKey.set(item.key, item);
      continue;
    }
    for (const finding of parsed) {
      const item = toQueueItem(record, finding, false);
      const existing = byKey.get(item.key);
      if (!existing || existing.completedAt < item.completedAt) byKey.set(item.key, item);
    }
  }
  return [...byKey.values()].sort(compareQueueItems);
}

function compareQueueItems(left: ReviewQueueItem, right: ReviewQueueItem): number {
  const severity = (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0);
  if (severity !== 0) return severity;
  const located = Number(right.line !== undefined) - Number(left.line !== undefined);
  if (located !== 0) return located;
  return right.completedAt - left.completedAt;
}

/** 过滤掉本地已读条目；已读状态不写协议，换机器不跟随。 */
export function openReviewQueueItems(
  items: readonly ReviewQueueItem[],
  reviewedKeys: ReadonlySet<string>,
): ReviewQueueItem[] {
  return items.filter((item) => !reviewedKeys.has(item.key));
}

export function buildQueueFixPrompt(item: ReviewQueueItem): string {
  const location = item.file
    ? `${item.file}${item.line !== undefined ? `:${item.line}` : ""}`
    : "（未标注位置）";
  return [
    "上一轮 Oracle 审查留下一条待处理发现，请先核实再修复：",
    "",
    `- 等级：${item.severity}`,
    `- 位置：${location}`,
    `- 问题：${item.message}`,
    "",
    "如果经核实不成立，请说明理由；成立则修复并说明改动位置。",
  ].join("\n");
}

export function buildQueueAskPrompt(item: ReviewQueueItem): string {
  const location = item.file
    ? `${item.file}${item.line !== undefined ? `:${item.line}` : ""}`
    : "（未标注位置）";
  return [
    "关于这条 Oracle 审查发现，请先解释背景与影响，再给出处理建议：",
    "",
    `- 位置：${location}`,
    `- 问题：${item.message}`,
  ].join("\n");
}
