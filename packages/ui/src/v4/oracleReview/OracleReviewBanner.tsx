import { useMemo, useState } from "react";
import {
  ChevronRightIcon,
  Loader2Icon,
  OctagonAlertIcon,
  RefreshCwIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildOracleFixPrompt } from "./oracleReviewSupport.js";
import type { OracleReviewState } from "./oracleReviewSupport.js";
import {
  VERDICT_PRESETS,
  failureDetail,
  ResultSection,
  STAGE_LABEL_KEYS,
} from "./OracleReviewBannerParts.js";

/** 等待超过该秒数后在 pending 卡片上提示「渠道响应慢，可换把关模型」。 */
const SLOW_REVIEW_HINT_SECONDS = 120;

/**
 * Oracle 审查结果横幅：挂在输入框上方（与 ChatErrorBanner 同层）。
 * pending 展示阶段（取材料/上下文分析/审查中）；result 展示裁决 + 摘要 + 可折叠的
 * 问题清单、需求核验（深度）与范围/限制；error 展示失败原因与按原请求重试。
 * 全部状态都不阻塞输入。
 */

export function OracleReviewBanner({
  state,
  pendingElapsedSeconds = 0,
  pendingOutputChars = 0,
  onRereview,
  onDismiss,
  onFix,
}: {
  state: OracleReviewState;
  /** pending 已等待秒数（宿主每秒更新）；驱动时长跳动与慢渠道提示。 */
  pendingElapsedSeconds?: number;
  /** pending 期间模型已累计输出字符数（CLI 流式进度推送，宿主按 500ms 节流）；0 表示尚无产出。 */
  pendingOutputChars?: number;
  onRereview: () => void;
  onDismiss: () => void;
  onFix: (fixPrompt: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [toolLogOpen, setToolLogOpen] = useState(false);
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
  // 「无」这类占位结论不给修复按钮；只有可行动的问题清单才注入下一轮。
  // 信息不足（insufficient）不是问题清单，同样不给。
  const canFix =
    Boolean(result) &&
    result!.verdict !== "unknown" &&
    result!.verdict !== "insufficient" &&
    findings.length > 0 &&
    !/^(无|none)\s*。?$/i.test(findings);
  const fixPrompt = useMemo(
    () => (canFix ? buildOracleFixPrompt(findings) : ""),
    [canFix, findings],
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
                    model: state.modelLabel,
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
              {state.status === "pending" && state.toolName ? (
                <span className="hidden shrink-0 text-ui-sm text-foreground-subtle md:inline">
                  {intl.formatMessage(
                    { id: "chat.oracleReview.pendingDeepTool" },
                    { tool: state.toolName },
                  )}
                  {state.toolTarget ? (
                    // inline-block：行内元素上 max-width/truncate 不生效，长命令
                    // 会撑出卡片把右侧计数挤出可视区（用户实测）。
                    <span className="ml-1 inline-block max-w-48 truncate font-mono align-bottom">
                      {state.toolTarget}
                    </span>
                  ) : null}
                </span>
              ) : null}
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
                        {state.modelLabel}
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
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
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
                {result.modelLabel}
              </span>
            </>
          ) : null}
          <div className="flex shrink-0 items-center gap-0.5">
            {!pending ? (
              <>
                {canFix ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-ui-base"
                    data-testid="v4-oracle-review-fix"
                    onClick={() => onFix(fixPrompt)}
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
        {state.status === "pending" && toolEvents.length > 0 ? (
          <Collapsible open={toolLogOpen} onOpenChange={setToolLogOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:text-foreground"
                data-testid="v4-oracle-review-tool-log"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    toolLogOpen ? "rotate-90" : "rotate-0",
                  )}
                />
                <span>
                  {intl.formatMessage(
                    { id: "chat.oracleReview.pendingDeepTools" },
                    { count: String(toolEvents.length), files: String(readFilesCount) },
                  )}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="max-h-48 overflow-y-auto border-t border-border/60 px-3 py-2 font-mono text-ui-sm text-foreground">
                {toolEvents.map((event, index) => (
                  <div
                    key={`${index}-${event.toolName}-${event.target ?? ""}`}
                    className="truncate"
                  >
                    {event.round > 1 ? (
                      <span className="text-foreground-subtlest">#{event.round} </span>
                    ) : null}
                    {event.toolName}
                    {event.target ? (
                      <span className="text-foreground-subtle"> {event.target}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        {result ? (
          <>
            <Collapsible open={findingsOpen} onOpenChange={setFindingsOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:text-foreground"
                  aria-label={intl.formatMessage({ id: "chat.oracleReview.findingsToggle" })}
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      findingsOpen ? "rotate-90" : "rotate-0",
                    )}
                  />
                  <span>{intl.formatMessage({ id: "chat.oracleReview.findings" })}</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-mono text-ui-sm text-foreground">
                  {findings || intl.formatMessage({ id: "chat.oracleReview.findingsEmpty" })}
                </pre>
              </CollapsibleContent>
            </Collapsible>
            {result.requirements ? (
              <ResultSection
                titleKey="chat.oracleReview.requirements"
                body={result.requirements}
              />
            ) : null}
            {result.scope ? <ResultSection titleKey="chat.oracleReview.scope" body={result.scope} /> : null}
            {result.limits ? <ResultSection titleKey="chat.oracleReview.limits" body={result.limits} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
