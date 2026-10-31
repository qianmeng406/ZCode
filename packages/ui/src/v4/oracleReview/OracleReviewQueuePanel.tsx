import { ChevronRightIcon, CircleAlertIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ReviewQueueItem, ReviewQueueSeverity } from "./reviewQueue.js";

/**
 * 侧栏「待审」区：只负责展示与回调，数据/持久化在 useOracleReviewQueue，
 * 跳转与追问/修复由侧栏宿主接线（面板不直接依赖 composer 或代码查看器）。
 */

const SEVERITY_ICON: Record<ReviewQueueSeverity, typeof CircleAlertIcon> = {
  error: OctagonAlertIcon,
  warning: CircleAlertIcon,
  note: InfoIcon,
};

const SEVERITY_STYLE: Record<ReviewQueueSeverity, string> = {
  error: "text-destructive",
  warning: "text-warning",
  note: "text-muted-foreground",
};

const SEVERITY_LABEL_KEY: Record<ReviewQueueSeverity, string> = {
  error: "chat.oracleReview.queue.severityError",
  warning: "chat.oracleReview.queue.severityWarning",
  note: "chat.oracleReview.queue.severityNote",
};

function itemLocation(item: ReviewQueueItem): string | null {
  if (!item.file) return null;
  return item.line !== undefined ? `${item.file}:${item.line}` : item.file;
}

export function OracleReviewQueuePanel({
  items,
  reviewedCount,
  loading,
  onJump,
  onAsk,
  onFix,
  onMarkReviewed,
  onMarkAllReviewed,
  onClearReviewed,
}: {
  items: readonly ReviewQueueItem[];
  reviewedCount: number;
  loading: boolean;
  onJump: (item: ReviewQueueItem) => void;
  onAsk: (item: ReviewQueueItem) => void;
  onFix: (item: ReviewQueueItem) => void;
  onMarkReviewed: (item: ReviewQueueItem) => void;
  onMarkAllReviewed: () => void;
  onClearReviewed: () => void;
}) {
  const { intl } = useZCodeIntl();
  const text = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  return (
    <section className="border-b border-border/60 pb-3" data-testid="v4-oracle-review-queue">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-sm font-medium text-foreground">
          {text("chat.oracleReview.queue.title")}
          {items.length > 0 ? (
            <span className="ml-1 text-muted-foreground">({items.length})</span>
          ) : null}
        </h3>
        <div className="flex items-center gap-1">
          {items.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onMarkAllReviewed}
              data-testid="v4-oracle-review-queue-mark-all"
            >
              {text("chat.oracleReview.queue.markAll")}
            </Button>
          ) : null}
          {reviewedCount > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClearReviewed}
              data-testid="v4-oracle-review-queue-clear-reviewed"
            >
              {text("chat.oracleReview.queue.clearReviewed")}
            </Button>
          ) : null}
        </div>
      </div>

      {loading && items.length === 0 ? (
        <p className="mt-2 text-ui-sm text-muted-foreground">
          {text("chat.oracleReview.queue.loading")}
        </p>
      ) : items.length === 0 ? (
        <p
          className="mt-2 text-ui-sm text-muted-foreground"
          data-testid="v4-oracle-review-queue-empty"
        >
          {reviewedCount > 0
            ? text("chat.oracleReview.queue.allReviewed")
            : text("chat.oracleReview.queue.empty")}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => {
            const Icon = SEVERITY_ICON[item.severity] ?? InfoIcon;
            const location = itemLocation(item);
            return (
              <li
                key={item.key}
                className="rounded-md border border-border/60 bg-surface/60 px-2 py-1.5"
                data-testid="v4-oracle-review-queue-item"
              >
                <div className="flex items-start gap-2">
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      SEVERITY_STYLE[item.severity] ?? "text-muted-foreground",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {text(
                          SEVERITY_LABEL_KEY[item.severity] ??
                            "chat.oracleReview.queue.severityNote",
                        )}
                      </span>
                      {location ? (
                        <button
                          type="button"
                          className="truncate text-left underline-offset-2 hover:underline"
                          onClick={() => onJump(item)}
                          disabled={item.line === undefined}
                          data-testid="v4-oracle-review-queue-jump"
                        >
                          {location}
                        </button>
                      ) : null}
                      {item.synthesized ? (
                        <span>{text("chat.oracleReview.queue.synthesized")}</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-ui-sm text-foreground">
                      {item.message}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Button type="button" size="sm" variant="ghost" onClick={() => onAsk(item)}>
                        {text("chat.oracleReview.queue.ask")}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => onFix(item)}>
                        {text("chat.oracleReview.queue.fix")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onMarkReviewed(item)}
                        data-testid="v4-oracle-review-queue-mark"
                      >
                        {text("chat.oracleReview.queue.markReviewed")}
                      </Button>
                      {item.file ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onJump(item)}
                          data-testid="v4-oracle-review-queue-open"
                        >
                          {text("chat.oracleReview.queue.open")}
                          <ChevronRightIcon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
