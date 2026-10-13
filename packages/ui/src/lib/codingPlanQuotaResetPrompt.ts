import type { UsageQuotaLimit } from "@zcode/shared";
import { getQuotaRemainingPercentage } from "./codingPlanQuotaPresentation.js";

/**
 * 「5 小时额度剩余 ≤ 阈值 → 弹窗 + 重置卡」的纯判定模型。
 *
 * 检测源是 entitlement 快照（getQuotaRemainingPercentage 的「剩余」口径），不是请求
 * 失败码——提示要发生在**还剩 10%** 的时候，等 1308 就已经用完了。快照的新鲜度由
 * 组件负责（挂载一次 + 每轮结束静默刷新），这里只做纯判定。
 */

/** 5 小时窗口剩余额度低于该百分比（含）时提示。 */
export const CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT = 10;

export interface QuotaResetPromptEntryInput {
  opportunityCount: number;
  opportunityExpiresAt: number | null;
  processing: boolean;
  done: boolean;
}

export type QuotaResetPromptDismissReason =
  | "window-dismissed"
  | "already-reset"
  | "quota-above-threshold"
  | "quota-unknown";

export interface QuotaResetPromptModel {
  visible: boolean;
  dismissReason: QuotaResetPromptDismissReason | null;
  /** 5 小时窗口的去重键（重置时刻）；快照缺失时退化为 "unknown"。 */
  windowKey: string;
  /** 窗口重置时刻；快照缺失时为 null（界面就不显示重置时间）。 */
  resetAtMs: number | null;
  remainingPercent: number | null;
  /** 服务端确认仍有可用重置卡时才允许点「使用重置卡」。 */
  canUseResetCard: boolean;
  opportunityCount: number;
  opportunityExpiresAt: number | null;
  processing: boolean;
}

/** 同一 5 小时窗口只弹一次； dismissed 集合由组件按 renderer 会话持有。 */
export function resolveCodingPlanQuotaResetPromptModel(params: {
  fiveHourLimit: UsageQuotaLimit | null | undefined;
  entry: QuotaResetPromptEntryInput | null;
  dismissedWindowKeys: readonly string[];
  thresholdPercent?: number;
}): QuotaResetPromptModel {
  const thresholdPercent =
    params.thresholdPercent ?? CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT;
  const remainingPercent = getQuotaRemainingPercentage(params.fiveHourLimit ?? null);
  const resetAtMs =
    typeof params.fiveHourLimit?.nextResetTime === "number" &&
    Number.isFinite(params.fiveHourLimit.nextResetTime)
      ? params.fiveHourLimit.nextResetTime
      : null;
  const windowKey = resetAtMs === null ? "unknown" : String(resetAtMs);

  const base = { windowKey, resetAtMs, remainingPercent };
  // 快照没有可判定的剩余占比时不提示：提示文案承诺了一个具体的不足程度，
  // 数据缺失就沉默，而不是拿 unknown 冒充「不足 10%」。
  if (remainingPercent === null) {
    return invisible("quota-unknown", base);
  }
  if (remainingPercent > thresholdPercent) {
    return invisible("quota-above-threshold", base);
  }
  if (params.dismissedWindowKeys.includes(windowKey)) {
    return invisible("window-dismissed", base);
  }
  // entry.done（已拿到服务端 used_at）说明重置已生效，弹窗没有存在意义。
  if (params.entry?.done) {
    return invisible("already-reset", base);
  }
  const opportunityCount = params.entry?.opportunityCount ?? 0;
  return {
    visible: true,
    dismissReason: null,
    windowKey,
    resetAtMs,
    remainingPercent,
    canUseResetCard: opportunityCount > 0 && params.entry?.processing !== true,
    opportunityCount,
    opportunityExpiresAt: params.entry?.opportunityExpiresAt ?? null,
    processing: params.entry?.processing === true,
  };
}

function invisible(
  reason: QuotaResetPromptDismissReason,
  extra: { windowKey: string; resetAtMs: number | null; remainingPercent: number | null },
): QuotaResetPromptModel {
  return {
    visible: false,
    dismissReason: reason,
    windowKey: extra.windowKey,
    resetAtMs: extra.resetAtMs,
    remainingPercent: extra.remainingPercent,
    canUseResetCard: false,
    opportunityCount: 0,
    opportunityExpiresAt: null,
    processing: false,
  };
}
