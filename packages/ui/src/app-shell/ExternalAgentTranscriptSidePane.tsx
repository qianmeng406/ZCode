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
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import {
  ExternalAgentToolRow,
  resolveExternalAgentToolPresentation,
} from "@/v4/externalAgent/ExternalAgentToolRow.js";
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
  const toggle = (
    <button
      type="button"
      data-testid="external-agent-transcript-clamp-toggle"
      aria-expanded={expanded}
      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
      {intl.formatMessage({
        id: expanded
          ? "chat.externalAgent.transcript.collapse"
          : "chat.externalAgent.transcript.expand",
      })}
    </button>
  );
  return (
    <div className="relative" data-testid={testId}>
      {/* 展开后正文可能有上千像素高：收起按钮必须粘在块顶部。曾经把它只放在块尾，
          展开一段长正文后按钮被推到很远，用户以为「展开就收不回去」。 */}
      {expanded ? (
        <div className="sticky top-0 z-10 -mx-1 mb-1 flex bg-background/95 px-1 py-0.5 backdrop-blur">
          {toggle}
        </div>
      ) : null}
      <div
        className={collapsed ? "overflow-hidden" : undefined}
        style={collapsed ? { maxHeight: `${CLAMPED_MAX_HEIGHT_PX}px` } : undefined}
      >
        {children}
      </div>
      {collapsed ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
      ) : null}
      {clampable && !expanded ? <div className="mt-1 flex">{toggle}</div> : null}
    </div>
  );
});

/** CLI 把工具结果包在 `{"result": "..."}` 里（REPL 一族）。 */
const TOOL_RESULT_WRAPPER = /^\{\s*"(?:result|text|output|stdout|content|message)"\s*:\s*"/u;
const TOOL_RESULT_KEYS = ["result", "text", "output", "stdout", "content", "message"] as const;

/**
 * 剥掉 CLI 的结果包装，拿到正文。
 *
 * 先按前缀剥壳：解析器把过长的结果截断成 `...…`，末尾不是 `"}`，JSON.parse 直接失败，
 * 按前缀切就是唯一稳的路径。没包装的才尝试整段 JSON。
 */
function unwrapToolResult(text: string): string {
  const trimmed = text.trim();
  const wrapper = TOOL_RESULT_WRAPPER.exec(trimmed);
  if (wrapper) {
    return trimmed
      .slice(wrapper[0].length)
      .replace(/(?:"\s*\}?|…)\s*$/u, "")
      .replace(/\\"/gu, '"');
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        for (const key of TOOL_RESULT_KEYS) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) return value;
        }
      }
    } catch {
      // 不是合法 JSON（半个事件/纯文本）：按原文展示。
    }
  }
  return text;
}

/**
 * 结果行的摘要：一行人类可读的文本。
 *
 * 直接把原文首行拿来当摘要，用户看到的是 `{"result":"total 1285\ndrwxr-xr-x...`。
 * 所以：先剥包装，再把换行/转义换行压成空格。
 */
function toolResultPreview(text: string): string {
  // 摘要是一行：换行压成空格，长内容由 CSS 截断（这里先砍到 160 字，
  // 避免把整段输出拼进 title/aria 属性）。
  return unwrapToolResult(text).replace(/\\n/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160);
}

const ToolResultBlock = memo(function ToolResultBlock({
  entry,
  rowKey,
}: {
  entry: ExternalAgentTranscriptEntry;
  rowKey: string;
}) {
  const { intl } = useZCodeIntl();
  const toolName = entry.name ?? "tool";
  const presentation = resolveExternalAgentToolPresentation(toolName, (id) =>
    intl.formatMessage({ id }),
  );
  const preview = toolResultPreview(entry.text);
  // 工具结果默认收起（与会话里的工具详情一致）：81 条历史里终端输出占大头，
  // 全摊开就是一面滚不完的日志墙。点行展开、再点收起，摘要行始终在内容上方。
  return (
    <div data-testid="external-agent-transcript-tool-result">
      <ToolLayout
        toolId={`external-agent-transcript-tool-result-${rowKey}`}
        icon={presentation.icon}
        kindLabel={presentation.kindLabel}
        primaryText={
          <span className="min-w-0 truncate text-foreground-subtle" title={preview}>
            {preview}
          </span>
        }
        prioritizePrimaryText
        title={preview}
        content={
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-surface/60 p-3 font-mono text-ui-xs leading-relaxed text-foreground-subtle">
            {entry.text}
          </pre>
        }
      />
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
                return (
                  <ToolResultBlock key={entryKey} entry={entry} rowKey={`${key}:${entryKey}`} />
                );
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
