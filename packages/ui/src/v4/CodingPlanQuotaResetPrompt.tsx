import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, GiftIcon, Loader2, XIcon } from "lucide-react";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import type { IUsageStatsService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { formatCodingPlanQuotaResetCountdown } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaResetTime,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT,
  resolveCodingPlanQuotaResetPromptModel,
} from "@/lib/codingPlanQuotaResetPrompt.js";

/**
 * 5 小时窗口剩余额度不足时的「使用重置卡」小弹窗。
 *
 * 检测源是 entitlement 快照的剩余占比（≤10% 即提示，含用完），不是请求失败码——
 * 提示要赶在用完**之前**。快照新鲜度由本组件负责：挂载拉一次，之后每个轮次结束
 * （running/prewarming → idle）静默强刷一次，正好是消耗发生的时刻；不做空闲轮询。
 *
 * 仅官方 Coding Plan 供应商会激活（zhipu-account 账号访问缺失时整组件休眠、零请求）。
 * 同一 5 小时窗口只提示一次（按窗口重置时刻去重，renderer 会话内存活）。
 */

const RESET_DONE_AUTO_CLOSE_MS = 1_600;

/** renderer 会话内已提示过（用户关掉）的 5 小时窗口。 */
const dismissedWindowKeys = new Set<string>();

function isSessionActivePhase(phase: SessionPhase | null): boolean {
  return phase === "running" || phase === "prewarming";
}

export function CodingPlanQuotaResetPrompt({
  providerId,
  usageStatsService,
  phase,
  onDismiss,
}: {
  providerId: string | null;
  usageStatsService: IUsageStatsService | undefined;
  phase: SessionPhase | null;
  /** 仅用于让上层知道弹窗已关闭（重置成功或用户点掉）；展示状态由本组件自持。 */
  onDismiss?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const settings = useProviderSettingsView();
  const accountAccess = useMemo(() => {
    if (settings.state.status !== "ready" || !providerId) return null;
    return resolveEntitledAccountProviderAccess(settings.state.view, providerId);
  }, [providerId, settings.state]);

  const entitlement = useUsageEntitlementWithService(usageStatsService, {
    enabled: Boolean(accountAccess),
    includeSubscription: true,
    preferredProviderId: providerId ?? undefined,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: true,
  });

  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: providerId,
    preferredProviderId: providerId,
    accountAccess: accountAccess?.access ?? null,
    enabled: Boolean(accountAccess),
  });

  // 轮次结束（活跃 → 非活跃）即刻强刷：消耗发生在轮次内，此刻的剩余占比最新鲜。
  // 不做空闲轮询——空闲时额度不会变化，轮询只是烧配额。
  const previousActiveRef = useRef(isSessionActivePhase(phase));
  useEffect(() => {
    const active = isSessionActivePhase(phase);
    const previous = previousActiveRef.current;
    previousActiveRef.current = active;
    if (previous && !active && accountAccess) {
      void entitlement.refresh({ force: true, silent: true, reason: "manual" });
    }
  }, [accountAccess, entitlement.refresh, phase]);

  const fiveHourLimit = findCodingPlanQuotaLimit(
    entitlement.snapshot?.quota?.limits ?? [],
    "TOKENS_LIMIT",
    3,
    5,
  );
  const model = resolveCodingPlanQuotaResetPromptModel({
    fiveHourLimit,
    entry: resetUi.enabled
      ? {
          opportunityCount: resetUi.entry?.opportunityCount ?? 0,
          opportunityExpiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
          processing: resetUi.processing,
          done: resetUi.done,
        }
      : null,
    dismissedWindowKeys: [...dismissedWindowKeys],
  });

  const closedRef = useRef(false);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    // 重置成功后短暂展示「已重置」再自动收起；用户手动关掉则立即记入该窗口。
    if (!model.visible || !resetUi.done || closed) return;
    const timer = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      dismissedWindowKeys.add(model.windowKey);
      onDismiss?.();
    }, RESET_DONE_AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closed, model.visible, model.windowKey, onDismiss, resetUi.done]);

  if (closed) return null;
  if (!model.visible) return null;

  const close = () => {
    closedRef.current = true;
    dismissedWindowKeys.add(model.windowKey);
    setClosed(true);
    onDismiss?.();
  };

  const resetAtLabel = model.resetAtMs
    ? formatQuotaResetTime({ locale, value: model.resetAtMs, format: "adaptive" })
    : undefined;

  return (
    <div
      className="relative w-full shrink-0 rounded-xl border border-warning/40 bg-surface p-3 shadow-lg/20"
      role="alert"
      aria-label={intl.formatMessage({ id: "chat.quota.resetPrompt.title" })}
    >
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "chat.quota.resetPrompt.dismiss" })}
        className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
        onClick={close}
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="flex min-w-0 items-start gap-2.5 pr-7">
        <GiftIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "chat.quota.resetPrompt.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.quota.resetPrompt.body" },
              { percent: String(CODING_PLAN_FIVE_HOUR_PROMPT_THRESHOLD_PERCENT) },
            )}
            {resetAtLabel ? (
              <span className="text-foreground">
                {" "}
                {intl.formatMessage(
                  { id: "chat.quota.resetPrompt.resetAt" },
                  { time: resetAtLabel },
                )}
              </span>
            ) : null}
          </div>
          {model.canUseResetCard ? (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5"
                disabled={resetUi.processing}
                onClick={() => {
                  void resetUi.reset();
                }}
              >
                {resetUi.processing ? (
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <GiftIcon className="size-3.5" />
                )}
                {intl.formatMessage({ id: "chat.quota.resetPrompt.use" })}
              </Button>
              {model.opportunityExpiresAt ? (
                <span className="text-ui-xs text-foreground-subtle tabular-nums">
                  {intl.formatMessage(
                    { id: "chat.quota.resetPrompt.cardCount" },
                    { count: model.opportunityCount },
                  )}
                  {" · "}
                  {formatCodingPlanQuotaResetCountdown(
                    Math.max(0, Math.ceil((model.opportunityExpiresAt - Date.now()) / 1_000)),
                    (descriptor, values) => intl.formatMessage(descriptor, values),
                  )}
                  {" · "}
                  {intl.formatMessage({ id: "chat.quota.resetPrompt.expiresHint" })}
                </span>
              ) : null}
            </div>
          ) : resetUi.done ? (
            <div className="mt-2 flex items-center gap-1.5 text-ui-sm text-success">
              <CheckIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.quota.resetPrompt.done" })}
            </div>
          ) : resetUi.processing ? (
            <div className="mt-2 flex items-center gap-1.5 text-ui-sm text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {intl.formatMessage({ id: "chat.quota.resetPrompt.resetting" })}
            </div>
          ) : (
            <div className="mt-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.quota.resetPrompt.noCard" })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
