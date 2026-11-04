// 外部 agent 执行过程的侧栏面板。
//
// 卡片只留状态（谁在跑/多久/成没成），过程搬到这里：工具行用会话同款 ToolLayout，
// 思考用 Reasoning，正文用 GenUiMessageResponse —— 与主对话、Oracle 审查面板同一套
// 渲染，不再自己拼等宽清单或原始 JSON。
//
// 数据源是模块级 store（见 v4/externalAgent/externalAgentActivityStore.ts）：
// 面板挂在 App 壳层，拿不到 SessionPane 的 projection lease；store 由 SessionPane
// 每帧推进来，因此切 tab / 面板隐藏期间记录仍然连续。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BotIcon, CheckCircle2Icon, CircleSlashIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ExternalAgentActivitySidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  getExternalAgentActivity,
  subscribeExternalAgentActivity,
} from "@/v4/externalAgent/externalAgentActivityStore.js";
import { ExternalAgentToolRow } from "@/v4/externalAgent/ExternalAgentToolRow.js";

/** 距底部多少像素内仍视为"在底部"，可以自动跟随新输出（与 Oracle 审查面板一致）。 */
const FOLLOW_BOTTOM_THRESHOLD_PX = 24;

interface ActivityEntry {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function ExternalAgentActivitySidePane({
  tab,
  onClose,
}: {
  tab: ExternalAgentActivitySidePaneTab;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const sessionId = tab.sessionId;
  const subscribe = useCallback(
    (listener: () => void) => subscribeExternalAgentActivity(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getExternalAgentActivity(sessionId), [sessionId]);
  const activity = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const running = activity?.status === "running";
  // 本地秒表：服务端只在事件到达时更新 elapsedMs，运行中由 UI 自己跳秒。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsedMs =
    activity === null
      ? 0
      : running
        ? Math.max(activity.elapsedMs, now - activity.startedAt)
        : activity.elapsedMs;

  // 结构化条目优先；只有纯文本 tail 时退回按行切分。空思考条目是"正在思考"的
  // 标记（CLI 不下发思考正文），运行中必须保留；结束后它只会变成一句假的
  // "正在思考"，所以完成态直接丢掉。
  const entries = useMemo<ActivityEntry[]>(() => {
    if (!activity) return [];
    if (activity.entries && activity.entries.length > 0) {
      return activity.entries.filter(
        (entry) => entry.text.trim().length > 0 || (entry.kind === "reasoning" && running),
      );
    }
    return (activity.tail ?? "")
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+$/u, ""))
      .filter((line) => line.length > 0)
      .map((line) => ({ kind: "text" as const, text: line }));
  }, [activity, running]);

  // 贴底跟随：只在用户本来就在底部时生效；运行中每来一条增量跟一次。
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const onScroll = () => {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      followBottomRef.current = distanceToBottom <= FOLLOW_BOTTOM_THRESHOLD_PX;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);
  const entryCount = entries.length;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !running || !followBottomRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [entryCount, running]);

  const statusLabel = activity
    ? intl.formatMessage({
        id:
          activity.status === "running"
            ? "chat.externalAgent.activity.running"
            : activity.status === "completed"
              ? "chat.externalAgent.activity.completed"
              : activity.status === "failed"
                ? "chat.externalAgent.activity.failed"
                : "chat.externalAgent.activity.cancelled",
      })
    : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="external-agent-activity-panel"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        {/* 头像 + 状态角标：状态不再是并排的第二个图标，窄面板下省一格宽度。 */}
        <span className="relative flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised">
          <BotIcon className="size-3.5 text-foreground-subtle" />
          <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-background">
            {running ? (
              <>
                <span className="absolute inline-flex size-3 animate-ping rounded-full bg-primary/40" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </>
            ) : activity?.status === "completed" ? (
              <CheckCircle2Icon className="size-3 text-foreground-subtle" />
            ) : activity?.status === "failed" ? (
              <XIcon className="size-3 text-danger" />
            ) : activity ? (
              <CircleSlashIcon className="size-3 text-foreground-subtle" />
            ) : null}
          </span>
        </span>
        <span
          className="min-w-0 shrink truncate text-ui-base font-medium text-foreground"
          title={activity?.agentLabel}
        >
          {activity?.agentLabel ?? intl.formatMessage({ id: "sidePane.externalAgentActivity" })}
        </span>
        {statusLabel ? (
          <span
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 text-ui-xs",
              running
                ? "bg-primary/10 text-primary"
                : activity?.status === "failed"
                  ? "bg-danger/10 text-danger"
                  : "bg-input text-foreground-subtle",
            )}
          >
            {statusLabel}
          </span>
        ) : null}
        {activity?.model ? (
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle"
            title={activity.model}
          >
            {activity.model}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {activity ? (
          <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtle">
            {formatElapsed(elapsedMs)}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground-subtle"
          aria-label={intl.formatMessage({ id: "common.close" })}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <ScrollFadeViewport ref={viewportRef} className="px-3 py-3">
        {activity === null ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.externalAgent.activity.empty" })}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="external-agent-activity-panel-trace">
            {/* 长任务会超出条目上限、从最老开始裁：必须说清楚，否则用户只觉得内容不全。 */}
            {activity.trimmedEntries ? (
              <p
                className="text-ui-xs text-foreground-subtle"
                data-testid="external-agent-activity-panel-trimmed"
              >
                {intl.formatMessage(
                  { id: "chat.externalAgent.activity.hiddenLines" },
                  { count: activity.trimmedEntries },
                )}
              </p>
            ) : null}
            {entries.map((entry, index) => {
              const streaming = running && index === entries.length - 1;
              if (entry.kind === "tool") {
                return (
                  <div key={`t-${index}`} data-testid="external-agent-activity-panel-tool">
                    <ExternalAgentToolRow
                      toolId={`external-agent-tool-${index}`}
                      text={entry.text}
                      workspacePath={tab.workspacePath}
                    />
                  </div>
                );
              }
              if (entry.kind === "reasoning") {
                // CLI 只下发"思考开始"与空内容：呈现"正在思考"而不是空块。
                if (!entry.text.trim()) {
                  return (
                    <div
                      key={`r-${index}`}
                      className="flex items-center gap-1.5 border-l-2 border-border pl-2 text-ui-xs italic text-foreground-subtle"
                      data-testid="external-agent-activity-panel-thinking"
                    >
                      {running ? (
                        <span className="inline-flex size-1.5 animate-pulse rounded-full bg-foreground-subtle" />
                      ) : null}
                      {intl.formatMessage({ id: "chat.externalAgent.activity.thinking" })}
                    </div>
                  );
                }
                return (
                  <div key={`r-${index}`} data-testid="external-agent-activity-panel-reasoning">
                    <Reasoning className="w-full" isStreaming={streaming}>
                      <ReasoningTrigger streamingText={entry.text} />
                      <ReasoningContent>{entry.text}</ReasoningContent>
                    </Reasoning>
                  </div>
                );
              }
              return (
                <div key={`x-${index}`} data-testid="external-agent-activity-panel-text">
                  {/* 会话正文同一个渲染器：markdown/代码块/gen-ui 引用都按对话里的样子排。 */}
                  <GenUiMessageResponse
                    completed={!streaming}
                    messageKey={`external-agent:${index}`}
                    streaming={streaming}
                    workspacePath={tab.workspacePath}
                    sessionId={tab.sessionId}
                    {...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {})}
                    {...(tab.remoteSessionId
                      ? { workspaceRemoteSessionId: tab.remoteSessionId }
                      : {})}
                  >
                    {entry.text}
                  </GenUiMessageResponse>
                </div>
              );
            })}
            {activity.error ? (
              <p className="whitespace-pre-wrap break-words text-ui-sm text-danger">
                {activity.error}
              </p>
            ) : null}
            {/* 只有空思考标记被过滤掉时才会走到这里：给一句说明，别留空面板。 */}
            {!running && entries.length === 0 && !activity.error ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.externalAgent.activity.noTrace" })}
              </p>
            ) : null}
          </div>
        )}
      </ScrollFadeViewport>
    </div>
  );
}
