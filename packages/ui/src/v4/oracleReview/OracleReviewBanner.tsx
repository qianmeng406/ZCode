import { useMemo } from "react";
import {
  Loader2Icon,
  Maximize2Icon,
  OctagonAlertIcon,
  RefreshCwIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildOracleFixPrompt } from "./oracleReviewSupport.js";
import type { OracleReviewState } from "./oracleReviewSupport.js";
import { formatOracleModelLabel, type OracleModelLabelProvider } from "./oracleReviewModelLabel.js";
import { VERDICT_PRESETS, failureDetail, STAGE_LABEL_KEYS } from "./OracleReviewBannerParts.js";

/** 等待超过该秒数后在 pending 卡片上提示「渠道响应慢，可换把关模型」。 */
const SLOW_REVIEW_HINT_SECONDS = 120;

/**
 * Oracle 审查横幅：挂在输入框上方（与 ChatErrorBanner 同层）。
 *
 * 只保留「一眼可判」的信息（阶段/裁决 + 单行摘要 + 模型）与四个动作；完整结论、
 * 逐轮正文与工具取证在右侧审查面板（`OracleReviewSidePane`）里查看，避免输入区
 * 被长报告撑开。全部状态都不阻塞输入。
 */

export function OracleReviewBanner({
  state,
  providers,
  pendingElapsedSeconds = 0,
  pendingOutputChars = 0,
  onOpenPanel,
  onRereview,
  onDismiss,
  onFix,
}: {
  state: OracleReviewState;
  /** provider 目录：把审查记录里的 `providerId/modelId` 显示成可读名字（UUID 不上屏）。 */
  providers?: readonly OracleModelLabelProvider[];
  /** pending 已等待秒数（宿主每秒更新）；驱动时长跳动与慢渠道提示。 */
  pendingElapsedSeconds?: number;
  /** pending 期间模型已累计输出字符数（CLI 流式进度推送，宿主按 500ms 节流）；0 表示尚无产出。 */
  pendingOutputChars?: number;
  /** 展开右侧审查面板（查看完整结论与逐轮过程）。 */
  onOpenPanel?: () => void;
  onRereview: () => void;
  onDismiss: () => void;
  onFix: (fixPrompt: string, reviewId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const modelLabelOf = (label: string | undefined): string | undefined =>
    formatOracleModelLabel(label, providers ?? []);
  const pending = state.status === "pending";
  const result = state.status === "result" ? state : null;
  const verdictPreset = result ? VERDICT_PRESETS[result.verdict] : null;
  const findings = result?.findings ?? "";
  // 深度审查的过程线索：已执行工具数 + 已读文件数（仅 pending 期间有值）。
  const toolEvents = state.status === "pending" ? (state.toolEvents ?? []) : [];
  const readFilesCount = new Set(
    toolEvents
      .filter((event) => event.toolName === "Read" && event.target)
      .map((event) => event.target),
  ).size;
  // 移交的是审查方最终输出全文（rawOutput），格式解析不再决定「能不能处理」：
  // unknown/insufficient 同样可移交，由主会话自行判读。唯一豁免是「通过且无问题」
  // 的占位结论——没有可处理的内容，注入下一轮只是浪费一轮。
  const handoffOutput = result?.rawOutput || findings;
  const canFix =
    Boolean(result) &&
    handoffOutput.length > 0 &&
    !(result!.verdict === "pass" && /^(无|none)\s*。?$/i.test(findings));
  const fixPrompt = useMemo(
    () => (canFix ? buildOracleFixPrompt(handoffOutput) : ""),
    [canFix, handoffOutput],
  );

  if (state.status === "idle") return null;

  return (
    <div className="mb-6 w-full shrink-0">
      <div
        className={cn(
          "overflow-hidden rounded-xl border shadow-none",
          verdictPreset ? verdictPreset.className : "border-border bg-card",
        )}
        data-testid="v4-oracle-review-banner"
      >
        <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
          {state.status === "pending" ? (
            <>
              <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                {intl.formatMessage(
                  {
                    id:
                      state.depth === "deep"
                        ? "chat.oracleReview.pendingDeep"
                        : "chat.oracleReview.pending",
                  },
                  {
                    model: modelLabelOf(state.modelLabel) ?? state.modelLabel,
                    // 深度审查附当前轮次；标准审查不插值 round。
                    round: String(state.round ?? 1),
                    minutes: String(Math.floor(pendingElapsedSeconds / 60)),
                    seconds: String(pendingElapsedSeconds % 60).padStart(2, "0"),
                  },
                )}
              </span>
              <span className="hidden shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle md:inline">
                {intl.formatMessage({ id: STAGE_LABEL_KEYS[state.stage] })}
              </span>
              {state.status === "pending" && toolEvents.length > 0 ? (
                <span className="hidden shrink-0 tabular-nums text-ui-sm text-foreground-subtle md:inline">
                  {intl.formatMessage(
                    { id: "chat.oracleReview.pendingDeepTools" },
                    { count: String(toolEvents.length), files: String(readFilesCount) },
                  )}
                </span>
              ) : null}
              {pendingOutputChars > 0 ? (
                <span className="hidden shrink-0 tabular-nums text-ui-sm text-foreground-subtle md:inline">
                  {intl.formatMessage(
                    { id: "chat.oracleReview.pendingOutput" },
                    { chars: String(pendingOutputChars) },
                  )}
                </span>
              ) : null}
              {pendingElapsedSeconds >= SLOW_REVIEW_HINT_SECONDS ? (
                <span className="hidden shrink-0 text-ui-sm text-foreground-subtle md:inline">
                  {intl.formatMessage({ id: "chat.oracleReview.pendingSlow" })}
                </span>
              ) : null}
            </>
          ) : null}
          {state.status === "error"
            ? (() => {
                const detail = failureDetail(state);
                return (
                  <>
                    <OctagonAlertIcon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                      {intl.formatMessage({ id: detail.titleKey }, detail.titleValues)}
                      {detail.detail ? ` · ${detail.detail.slice(0, 160)}` : ""}
                    </span>
                    {state.modelLabel ? (
                      <span
                        className="hidden shrink-0 font-mono text-ui-xs text-foreground-subtle md:inline"
                        title={state.modelLabel}
                      >
                        {modelLabelOf(state.modelLabel) ?? state.modelLabel}
                      </span>
                    ) : null}
                  </>
                );
              })()
            : null}
          {result && verdictPreset ? (
            <>
              <verdictPreset.icon className={cn("size-4 shrink-0", verdictPreset.iconClassName)} />
              <span
                className={cn("shrink-0 font-medium text-ui-base", verdictPreset.iconClassName)}
              >
                {intl.formatMessage({ id: verdictPreset.labelKey })}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-ui-base text-foreground"
                title={result.summary || undefined}
              >
                {result.summary ||
                  intl.formatMessage({ id: "chat.oracleReview.verdict.unknownSummary" })}
              </span>
              {result.depth === "deep" ? (
                <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.oracleReview.deepBadge" })}
                </span>
              ) : null}
              {result.restored ? (
                <span className="hidden shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle md:inline">
                  {intl.formatMessage({ id: "chat.oracleReview.restoredBadge" })}
                </span>
              ) : null}
              <span
                className="hidden shrink-0 font-mono text-ui-xs text-foreground-subtle md:inline"
                title={result.modelLabel}
              >
                {modelLabelOf(result.modelLabel) ?? result.modelLabel}
              </span>
            </>
          ) : null}
          <div className="flex shrink-0 items-center gap-0.5">
            {onOpenPanel ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-ui-base text-foreground-subtle"
                data-testid="v4-oracle-review-expand"
                onClick={onOpenPanel}
              >
                <Maximize2Icon className="size-3.5" />
                <span>{intl.formatMessage({ id: "chat.oracleReview.expand" })}</span>
              </Button>
            ) : null}
            {!pending ? (
              <>
                {canFix ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-ui-base"
                    data-testid="v4-oracle-review-fix"
                    onClick={() => onFix(fixPrompt, result!.reviewId)}
                  >
                    <WrenchIcon className="size-3.5" />
                    <span>{intl.formatMessage({ id: "chat.oracleReview.fix" })}</span>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-ui-base text-foreground-subtle"
                  onClick={onRereview}
                >
                  <RefreshCwIcon className="size-3.5" />
                  <span>{intl.formatMessage({ id: "chat.oracleReview.rereview" })}</span>
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground-subtle"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
