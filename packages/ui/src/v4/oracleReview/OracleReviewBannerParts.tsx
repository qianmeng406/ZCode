import { useState } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleHelpIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ORACLE_REVIEW_REQUEST_TIMEOUT_MS } from "./oracleReviewSupport.js";
import type { OracleReviewFailure, OracleReviewState } from "./oracleReviewSupport.js";

/**
 * 横幅的展示件层（从 OracleReviewBanner 拆出，控制文件行数）：
 * 裁决视觉预设 / 失败文案归并 / 附加信息段 / pending 阶段标签。
 */

export const VERDICT_PRESETS = {
  pass: {
    icon: CheckCircle2Icon,
    labelKey: "chat.oracleReview.verdict.pass",
    className: "border-[var(--color-success)]/40 bg-[var(--color-success)]/10",
    iconClassName: "text-[var(--color-success)]",
  },
  warn: {
    icon: TriangleAlertIcon,
    labelKey: "chat.oracleReview.verdict.warn",
    className: "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10",
    iconClassName: "text-[var(--color-warning)]",
  },
  fail: {
    icon: OctagonAlertIcon,
    labelKey: "chat.oracleReview.verdict.fail",
    className: "border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10",
    iconClassName: "text-[var(--color-destructive)]",
  },
  insufficient: {
    icon: CircleHelpIcon,
    labelKey: "chat.oracleReview.verdict.insufficient",
    className: "border-[var(--color-warning)]/30 bg-surface",
    iconClassName: "text-[var(--color-warning)]",
  },
  unknown: {
    icon: CircleHelpIcon,
    labelKey: "chat.oracleReview.verdict.unknown",
    className: "border-border bg-surface",
    iconClassName: "text-foreground-subtle",
  },
} as const;

export const STAGE_LABEL_KEYS = {
  collecting: "chat.oracleReview.stage.collecting",
  analyzing: "chat.oracleReview.stage.analyzing",
  reviewing: "chat.oracleReview.stage.reviewing",
} as const;

export function failureDetail(state: Extract<OracleReviewState, { status: "error" }>): {
  titleKey: string;
  detail?: string;
  /** i18n 插值（如超时分钟数），与代码常量共享，不在文案里硬编码时长。 */
  titleValues?: Record<string, string>;
} {
  const failure: OracleReviewFailure = state.failure;
  switch (failure.kind) {
    case "no-turn":
      return { titleKey: "chat.oracleReview.error.noTurn" };
    case "no-model":
      return { titleKey: "chat.oracleReview.error.noModel" };
    case "stale-target":
      return { titleKey: "chat.oracleReview.error.staleTarget", detail: failure.message };
    case "context-analysis":
      return {
        titleKey: "chat.oracleReview.error.contextAnalysis",
        detail: failure.message.slice(0, 160),
      };
    case "empty-response":
      return {
        // 以工具调用收尾而无正文：与「思考吃掉预算」是两种成因，文案分开，
        // 否则用户会按提示去换模型，而真正要做的是拿到一段文本结论。
        titleKey:
          failure.finishReason === "tool-calls"
            ? "chat.oracleReview.error.toolCallNoText"
            : "chat.oracleReview.error.emptyResponse",
        detail: failure.finishReason,
      };
    case "timeout":
      return {
        titleKey: "chat.oracleReview.error.timeout",
        // 展示底层真实错误消息，误判或新场景下用户能看到实际原因。
        detail: failure.message,
        titleValues: {
          minutes: String(Math.round(ORACLE_REVIEW_REQUEST_TIMEOUT_MS / 60_000)),
        },
      };
    case "request":
      return {
        titleKey: "chat.oracleReview.error.request",
        detail: failure.message,
      };
    default: {
      // 穷举保护：新增 failure kind 而漏改本 switch 时在编译期之外再拦一道。
      const exhaustive: never = failure;
      throw new Error(`Unhandled oracle review failure: ${String(exhaustive)}`);
    }
  }
}


/** 结果卡的附加信息段（范围/限制/需求核验）；内容缺席不渲染。 */
export function ResultSection({
  titleKey,
  body,
  defaultOpen = false,
}: {
  titleKey: string;
  body: string;
  defaultOpen?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:text-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          />
          <span>{intl.formatMessage({ id: titleKey })}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-border/60 px-3 py-2 font-mono text-ui-sm text-foreground">
          {body}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

