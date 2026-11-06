// 某个外部 CLI 会话的完整上下文面板（只读）。
//
// 与「外部 Agent 过程」的分工：过程面板只放**这一次委派**的实时过程；这里是
// 直接读 CLI 自己的会话文件，看到历次委派累积的完整对话（用户任务 / 助手正文 /
// 工具调用 / 工具结果）。
//
// 上下文省略（与主对话的会话窗口收纳同一条思路）：
// - 初始只加载最新 30 条，顶部「加载更早」按需向前翻页（游标 = 条目序号）；
// - 累计上限 300 条，超过后不再提供翻页，避免把整段历史拉进内存；
// - 单条长正文/工具结果默认折叠，带渐变遮罩 + 展开。
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { BotIcon, ChevronDownIcon, ChevronUpIcon, LoaderIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ExternalAgentTranscriptSidePaneTab } from "@/lib/workspaceSidePane.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { ExternalAgentToolRow } from "@/v4/externalAgent/ExternalAgentToolRow.js";
import {
  externalAgentTranscriptKey,
  getExternalAgentTranscriptState,
  hasExternalAgentTranscriptLoader,
  loadExternalAgentTranscript,
  subscribeExternalAgentTranscript,
} from "@/v4/externalAgent/externalAgentTranscriptStore.js";
import type { ExternalAgentTranscriptEntry } from "@zcode/shared";

/** 超过这个长度才需要折叠（短条目直接展示，不要为了折叠而折叠）。 */
const CLAMP_MIN_CHARS = 800;
const CLAMP_MIN_LINES = 12;
const CLAMPED_MAX_HEIGHT_PX = 256;

function shouldClamp(entry: ExternalAgentTranscriptEntry): boolean {
  return entry.text.length > CLAMP_MIN_CHARS || entry.text.split("\n").length > CLAMP_MIN_LINES;
}

const ClampedBlock = memo(function ClampedBlock({
  children,
  clampable,
  testId,
}: {
  children: React.ReactNode;
  clampable: boolean;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const collapsed = clampable && !expanded;
  return (
    <div className="relative" data-testid={testId}>
      <div
        className={collapsed ? "overflow-hidden" : undefined}
        style={collapsed ? { maxHeight: `${CLAMPED_MAX_HEIGHT_PX}px` } : undefined}
      >
        {children}
      </div>
      {collapsed ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
      ) : null}
      {clampable ? (
        <button
          type="button"
          className="mt-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          {intl.formatMessage({
            id: expanded
              ? "chat.externalAgent.transcript.collapse"
              : "chat.externalAgent.transcript.expand",
          })}
        </button>
      ) : null}
    </div>
  );
});

const ToolResultBlock = memo(function ToolResultBlock({
  entry,
}: {
  entry: ExternalAgentTranscriptEntry;
}) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2"
      data-testid="external-agent-transcript-tool-result"
    >
      {entry.name ? (
        <div className="mb-1 text-ui-xs font-medium text-foreground-subtle">{entry.name}</div>
      ) : null}
      <ClampedBlock clampable={shouldClamp(entry)} testId="external-agent-transcript-tool-output">
        <pre className="whitespace-pre-wrap break-words font-mono text-ui-xs leading-relaxed text-foreground-subtle">
          {entry.text}
        </pre>
      </ClampedBlock>
    </div>
  );
});

export function ExternalAgentTranscriptSidePane({
  tab,
  onClose,
}: {
  tab: ExternalAgentTranscriptSidePaneTab;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const key = externalAgentTranscriptKey(tab.sessionId, tab.externalSessionId);
  const subscribe = useCallback(
    (listener: () => void) => subscribeExternalAgentTranscript(key, listener),
    [key],
  );
  const getSnapshot = useCallback(() => getExternalAgentTranscriptState(key), [key]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // 首次挂载自动读最新一页；已加载过（缓存命中）不重读。
  useEffect(() => {
    if (state.loaded || state.loading) return;
    void loadExternalAgentTranscript(key);
  }, [key, state.loaded, state.loading]);

  // 滚动：首次加载落在最底部（读的是"最近一页"）；"加载更早"是把内容插到
  // 顶部，必须补偿高度差，否则当前看的那段会被顶走。
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const anchorFromBottomRef = useRef<number | null>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !state.loaded || didInitialScrollRef.current) return;
    didInitialScrollRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
  }, [state.loaded]);
  const loadEarlier = useCallback(() => {
    const viewport = viewportRef.current;
    anchorFromBottomRef.current = viewport ? viewport.scrollHeight - viewport.scrollTop : null;
    void loadExternalAgentTranscript(key);
  }, [key]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorFromBottomRef.current;
    if (!viewport || anchor === null || state.loading) return;
    anchorFromBottomRef.current = null;
    viewport.scrollTop = viewport.scrollHeight - anchor;
  }, [state.entries, state.loading]);

  const loadedCount = state.entries.length;
  const headerStatus = useMemo(() => {
    if (!state.loaded) return null;
    return intl.formatMessage(
      { id: "chat.externalAgent.transcript.count" },
      { count: state.total },
    );
  }, [intl, state.loaded, state.total]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="external-agent-transcript-panel"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-raised">
          <BotIcon className="size-3.5 text-foreground-subtle" />
        </span>
        <span
          className="min-w-0 shrink truncate text-ui-base font-medium text-foreground"
          title={tab.title}
        >
          {tab.title}
        </span>
        <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
          {tab.externalSessionId.slice(0, 8)}
        </span>
        {headerStatus ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">{headerStatus}</span>
        ) : null}
        <span className="min-w-0 flex-1" />
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollFadeViewport ref={viewportRef} className="px-3 py-3">
          <div className="flex flex-col gap-3" data-testid="external-agent-transcript-entries">
            {/* 顶部：往前翻页 + 源文件截断提示（只影响更早的部分）。 */}
            {state.hasMore ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-full border border-border bg-surface px-3 py-1 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
                  data-testid="external-agent-transcript-load-earlier"
                  disabled={state.loading}
                  onClick={loadEarlier}
                >
                  {state.loading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <ChevronUpIcon className="size-3" />
                  )}
                  {intl.formatMessage({ id: "chat.externalAgent.transcript.loadEarlier" })}
                </button>
              </div>
            ) : null}
            {state.truncated ? (
              <p
                className="text-ui-xs text-foreground-subtle"
                data-testid="external-agent-transcript-truncated"
              >
                {intl.formatMessage({ id: "chat.externalAgent.transcript.truncated" })}
              </p>
            ) : null}

            {!state.loaded && state.loading ? (
              <div
                className="flex items-center gap-2 text-ui-sm text-foreground-subtle"
                data-testid="external-agent-transcript-loading"
              >
                <LoaderIcon className="size-3.5 animate-spin" />
                {intl.formatMessage({ id: "chat.externalAgent.transcript.loading" })}
              </div>
            ) : null}

            {state.error ? (
              <div className="flex flex-col gap-2" data-testid="external-agent-transcript-error">
                <p className="whitespace-pre-wrap break-words text-ui-sm text-danger">
                  {state.error}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start text-foreground-subtle"
                  onClick={() => void loadExternalAgentTranscript(key, { reload: true })}
                >
                  {intl.formatMessage({ id: "chat.externalAgent.transcript.retry" })}
                </Button>
              </div>
            ) : null}

            {state.loaded && loadedCount === 0 && !state.error ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.externalAgent.transcript.empty" })}
              </p>
            ) : null}

            {/* 恢复出来的历史 tab 没有读取器（transport 是会话级的）：给明确指引，
                而不是永远转圈或空白。 */}
            {!state.loaded &&
            !state.loading &&
            !state.error &&
            !hasExternalAgentTranscriptLoader(key) ? (
              <p
                className="text-ui-sm text-foreground-subtle"
                data-testid="external-agent-transcript-not-loaded"
              >
                {intl.formatMessage({ id: "chat.externalAgent.transcript.notLoaded" })}
              </p>
            ) : null}

            {state.entries.map((entry, index) => {
              const entryKey = `${state.firstIndex + index}`;
              if (entry.kind === "user") {
                return (
                  <div
                    key={entryKey}
                    className="flex justify-end"
                    data-testid="external-agent-transcript-user"
                  >
                    <ConversationUserInputBubble
                      text={entry.text}
                      rowId={`external-agent-transcript:${key}:${entryKey}`}
                    />
                  </div>
                );
              }
              if (entry.kind === "tool") {
                return (
                  <div key={entryKey} data-testid="external-agent-transcript-tool">
                    <ExternalAgentToolRow
                      toolId={`external-agent-transcript-tool-${key}-${entryKey}`}
                      text={entry.text}
                      workspacePath={tab.workspacePath}
                    />
                  </div>
                );
              }
              if (entry.kind === "tool_result") {
                return <ToolResultBlock key={entryKey} entry={entry} />;
              }
              return (
                <div key={entryKey} data-testid="external-agent-transcript-assistant">
                  <ClampedBlock clampable={shouldClamp(entry)}>
                    <GenUiMessageResponse
                      completed
                      messageKey={`external-agent-transcript:${key}:${entryKey}`}
                      streaming={false}
                      workspacePath={tab.workspacePath}
                      sessionId={tab.sessionId}
                      {...(tab.workspaceIdentity
                        ? { workspaceIdentity: tab.workspaceIdentity }
                        : {})}
                      {...(tab.remoteSessionId
                        ? { workspaceRemoteSessionId: tab.remoteSessionId }
                        : {})}
                    >
                      {entry.text}
                    </GenUiMessageResponse>
                  </ClampedBlock>
                </div>
              );
            })}

            {/* 已到最早 / 已达累计上限：给一句明确的边界，别让用户以为还有更多。 */}
            {state.loaded && !state.hasMore && loadedCount > 0 ? (
              <p
                className="pt-1 text-center text-ui-xs text-foreground-subtle"
                data-testid="external-agent-transcript-end"
              >
                {intl.formatMessage({ id: "chat.externalAgent.transcript.noMore" })}
              </p>
            ) : null}
          </div>
        </ScrollFadeViewport>
      </div>
    </div>
  );
}
