// 外部 coding agent 的活动卡。
//
// 为什么独立成卡而不是塞进工具行：后台任务的工具行几百毫秒就结算，而外部 agent
// 可能还要跑十几分钟。用户需要一张**一直可见**的卡回答三件事：谁在跑、跑多久、
// 最近在做什么。
//
// 数据来自会话状态（snapshot.externalAgentActivity），不是工具行——
// 这样切会话/工具行结算都不影响它；结束态保留在时间线里当执行记录。
import { useEffect, useMemo, useState } from "react";
import { BotIcon, CheckCircle2Icon, ChevronDownIcon, CircleSlashIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";

export interface ExternalAgentActivityCardProps {
  activity: ExternalAgentActivity;
  /** 用户手动关闭（只影响本地展示）。 */
  onDismiss?: (taskId: string) => void;
}

const COLLAPSED_ENTRIES = 4;
const EXPANDED_ENTRIES = 200;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function ExternalAgentActivityCard({ activity, onDismiss }: ExternalAgentActivityCardProps) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const running = activity.status === "running";
  // 本地秒表：避免服务端每秒发一条事件，只在 running 时走。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsedMs = running
    ? Math.max(activity.elapsedMs, now - activity.startedAt)
    : activity.elapsedMs;
  // 结构化条目优先（思考/正文/工具）；只有纯文本 tail 时才退回按行切分。
  const entries = useMemo(() => {
    if (activity.entries && activity.entries.length > 0) {
      return activity.entries.filter((entry) => entry.text.trim().length > 0);
    }
    return (activity.tail ?? "")
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+$/u, ""))
      .filter((line) => line.length > 0)
      .map((line) => ({ kind: "text" as const, text: line }));
  }, [activity.entries, activity.tail]);
  const visibleEntries = entries.slice(-(expanded ? EXPANDED_ENTRIES : COLLAPSED_ENTRIES));
  const hiddenCount = Math.max(0, entries.length - visibleEntries.length);

  const statusLabel = intl.formatMessage({
    id:
      activity.status === "running"
        ? "chat.externalAgent.activity.running"
        : activity.status === "completed"
          ? "chat.externalAgent.activity.completed"
          : activity.status === "failed"
            ? "chat.externalAgent.activity.failed"
            : "chat.externalAgent.activity.cancelled",
  });

  return (
    <div
      data-testid="external-agent-activity"
      // 与输入框同宽、同一套表面语言（rounded-xl + border + bg-surface），
      // 不再用半透明模糊：那是浮层语汇，嵌在对话流里会显得脏。
      className="mb-2 w-full overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex min-w-0 items-center gap-2 px-4 py-2.5">
        <span className="relative flex size-2.5 shrink-0 items-center justify-center">
          {running ? (
            <>
              <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-primary/50" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </>
          ) : activity.status === "completed" ? (
            <CheckCircle2Icon className="size-3.5 text-foreground-subtle" />
          ) : activity.status === "failed" ? (
            <XIcon className="size-3.5 text-danger" />
          ) : (
            <CircleSlashIcon className="size-3.5 text-foreground-subtle" />
          )}
        </span>
        <BotIcon className="size-4 shrink-0 text-foreground-subtle" />
        <span className="truncate text-ui-base font-medium">{activity.agentLabel}</span>
        <span
          className={cn(
            "shrink-0 rounded-md px-1.5 py-0.5 text-ui-xs",
            running
              ? "bg-primary/10 text-primary"
              : activity.status === "failed"
                ? "bg-danger/10 text-danger"
                : "bg-surface-raised text-foreground-subtle",
          )}
        >
          {statusLabel}
        </span>
        <span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtle tabular-nums">
          {formatElapsed(elapsedMs)}
        </span>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: expanded
              ? "chat.externalAgent.activity.collapse"
              : "chat.externalAgent.activity.expand",
          })}
          className="shrink-0 rounded p-0.5 text-foreground-subtle hover:bg-surface-hover"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
          />
        </button>
        {onDismiss ? (
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "chat.externalAgent.activity.dismiss" })}
            className="shrink-0 rounded p-0.5 text-foreground-subtle hover:bg-surface-hover"
            onClick={() => onDismiss(activity.taskId)}
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      {visibleEntries.length > 0 || activity.error ? (
        <div className="border-t border-border/60 bg-panel/40 px-4 py-2.5">
          {hiddenCount > 0 ? (
            <div className="mb-1.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.externalAgent.activity.hiddenLines" },
                { count: hiddenCount },
              )}
            </div>
          ) : null}
          {/* 与对话正文同一套渲染：正文走 MessageResponse（markdown/代码块），
              思考走弱化样式，工具调用是单行等宽记录。容器固定高度内滚动，
              展开后也只加高不撑爆输入区。 */}
          <div
            className={cn(
              "flex flex-col gap-1.5 overflow-y-auto pr-1",
              expanded ? "max-h-[min(60vh,520px)]" : "max-h-48",
            )}
          >
            {visibleEntries.map((entry, index) =>
              entry.kind === "tool" ? (
                <div
                  key={`${index}-${entry.text.slice(0, 24)}`}
                  className="flex min-w-0 items-start gap-1.5 font-mono text-ui-xs text-foreground-subtle"
                >
                  <span className="shrink-0 text-primary">▸</span>
                  <span className="min-w-0 break-all">{entry.text}</span>
                </div>
              ) : (
                <MessageResponse
                  key={`${index}-${entry.kind}`}
                  className={cn(
                    "text-ui-sm leading-relaxed",
                    entry.kind === "reasoning"
                      ? "border-l-2 border-border pl-2 text-ui-xs italic text-foreground-subtle"
                      : "text-foreground",
                  )}
                >
                  {entry.text}
                </MessageResponse>
              ),
            )}
          </div>
          {activity.error ? (
            <p className="mt-1.5 text-ui-xs text-danger">{activity.error}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
