// 外部 coding agent 的状态卡。
//
// 只回答"谁在跑、跑多久、成没成"三件事——过程（工具调用/思考/正文）在右侧
// 过程面板里（ExternalAgentActivitySidePane），卡片不再自己渲染内容。
// 这样卡片高度恒定，输入区不会被几百行输出顶开；想看细节点「查看过程」。
//
// 数据来自会话状态（snapshot.externalAgentActivity），不是工具行——
// 工具行几百毫秒就结算，而外部 agent 可能还要跑十几分钟。
import { useEffect, useMemo, useState } from "react";
import { BotIcon, CheckCircle2Icon, ChevronRightIcon, CircleSlashIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import { EXTERNAL_AGENT_IDLE_HINT_MS } from "@/v4/externalAgent/externalAgentActivityStore.js";

export interface ExternalAgentActivityCardProps {
  activity: ExternalAgentActivity;
  /**
   * 最近一次有输出/状态变化的时间（store 记录）。运行中长时间不变时卡片提示
   * 「已 N 分钟无输出」——委派可能跑十几分钟，用户需要区分"在思考"和"卡住了"。
   */
  lastChangedAt?: number | null;
  /** 用户手动关闭（只影响本地展示）。 */
  onDismiss?: (taskId: string) => void;
  /** 打开右侧过程面板；未接线的宿主（子会话只读视图等）不提供入口。 */
  onOpen?: (taskId: string) => void;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function ExternalAgentActivityCard({
  activity,
  lastChangedAt,
  onDismiss,
  onOpen,
}: ExternalAgentActivityCardProps) {
  const { intl } = useZCodeIntl();
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

  // 无新输出的分钟数：阈值以下不显示，恢复输出后 lastChangedAt 更新，提示自动消失。
  const idleForMs = running && lastChangedAt ? Math.max(0, now - lastChangedAt) : 0;
  const idleLabel =
    idleForMs >= EXTERNAL_AGENT_IDLE_HINT_MS
      ? intl.formatMessage(
          { id: "chat.externalAgent.activity.idle" },
          { minutes: Math.max(1, Math.floor(idleForMs / 60_000)) },
        )
      : null;
  // 卡住提示要可行动：带上最后一步是什么（工具行形如 "Bash: npm test"）。
  // 只取工具行——正文/思考停在半句上没有诊断价值。
  const idleStep = useMemo(() => {
    const entries = activity.entries ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry?.text.trim()) continue;
      return entry.kind === "tool"
        ? (entry.text.trim().split(/\r?\n/u)[0] ?? "").slice(0, 80)
        : null;
    }
    return null;
  }, [activity.entries]);
  const idleText =
    idleLabel && idleStep
      ? `${idleLabel} · ${intl.formatMessage(
          { id: "chat.externalAgent.activity.idleStep" },
          { step: idleStep },
        )}`
      : idleLabel;

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
      // 与输入框同宽、同一套表面语言（rounded-xl + border + bg-surface）。
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
        {idleText ? (
          <span
            data-testid="external-agent-activity-idle"
            className="min-w-0 truncate text-ui-xs text-foreground-subtle"
            title={intl.formatMessage(
              { id: "chat.externalAgent.activity.idleTitle" },
              { minutes: Math.max(1, Math.floor(idleForMs / 60_000)) },
            )}
          >
            {idleText}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtle tabular-nums">
          {formatElapsed(elapsedMs)}
        </span>
        {onOpen ? (
          <button
            type="button"
            data-testid="external-agent-activity-open"
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={() => onOpen(activity.taskId)}
          >
            {intl.formatMessage({ id: "chat.externalAgent.activity.viewProcess" })}
            <ChevronRightIcon className="size-3" />
          </button>
        ) : null}
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
    </div>
  );
}
