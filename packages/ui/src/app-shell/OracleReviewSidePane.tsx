import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ZCodeOracleReviewRecord } from "@zcode/shared";
import { Loader2Icon, OctagonAlertIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import type { OracleReviewSidePaneTab } from "@/lib/workspaceSidePane.js";
import { formatOracleModelLabel } from "@/v4/oracleReview/oracleReviewModelLabel.js";
import {
  getOracleReviewHistory,
  getOracleReviewState,
  subscribeOracleReviewHistory,
  subscribeOracleReviewState,
} from "@/v4/oracleReview/oracleReviewStore.js";
import {
  ORACLE_REVIEW_TRACE_TEXT_CAP,
  resolveOracleReviewPaneAutoClose,
  type OracleReviewState,
  type OracleReviewTraceEntry,
} from "@/v4/oracleReview/oracleReviewSupport.js";
import {
  STAGE_LABEL_KEYS,
  VERDICT_PRESETS,
  failureDetail,
  ResultSection,
} from "@/v4/oracleReview/OracleReviewBannerParts.js";
import { OracleReviewTraceToolRow } from "@/v4/oracleReview/OracleReviewTraceToolRow.js";

/**
 * Oracle 审查面板：把输入框上方卡片里的「完整结论 + 审查过程」搬到右侧栏。
 *
 * 数据源是模块级审查 store（按 sessionId 键控），因此切换 tab / 切会话 / 面板
 * 隐藏期间轨迹都会继续累积；这里只做订阅与渲染，不持有审查状态。
 * 轨迹条目由 runner（阶段）与进度订阅（正文/工具）写入，与子智能体会话流同构：
 * 阶段分隔行 + 工具调用行 + 逐轮模型输出块。
 */

const EMPTY_TRACE: readonly OracleReviewTraceEntry[] = [];

export function OracleReviewSidePane({
  tab,
  onClose,
}: {
  tab: OracleReviewSidePaneTab;
  /** 关闭面板 tab（审查卡片被 dismiss / 会话已无审查时自动调用）。 */
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const sessionId = tab.sessionId;
  const subscribe = useCallback(
    (listener: () => void) => subscribeOracleReviewState(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(() => getOracleReviewState(sessionId), [sessionId]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  // 持久审查历史（会话加载时由 CLI 记录种入）：卡片关闭后仍能在这里查看历次结论。
  const subscribeHistory = useCallback(
    (listener: () => void) => subscribeOracleReviewHistory(sessionId, listener),
    [sessionId],
  );
  const getHistorySnapshot = useCallback(() => getOracleReviewHistory(sessionId), [sessionId]);
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistorySnapshot);
  const modelSelectionView = useModelSelectionView(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
  );
  const providers =
    modelSelectionView.state.status === "ready"
      ? modelSelectionView.state.view.providers
      : modelSelectionView.state.status === "loading"
        ? (modelSelectionView.state.catalog?.providers ?? [])
        : [];
  const modelLabelOf = (label: string | undefined): string | undefined =>
    formatOracleModelLabel(label, providers);

  // 审查卡片被关闭（store 回到 idle）时面板随之关闭；但有持久历史时保留面板，
  // 让用户关闭卡片后仍能回看历次结论。副作用：本会话审查过一次后，面板就不再
  // 自行消失，只能由用户点 ✕（裁决集中在 resolveOracleReviewPaneAutoClose）。
  // onClose 是宿主内联函数，每次渲染身份都会变；用 ref 保证只请求关闭一次。
  const closeRequestedRef = useRef(false);
  useEffect(() => {
    if (closeRequestedRef.current) return;
    if (!resolveOracleReviewPaneAutoClose({ status: state.status, historyCount: history.length }))
      return;
    closeRequestedRef.current = true;
    onClose();
  }, [state.status, history.length, onClose]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previousStatusRef = useRef<OracleReviewState["status"]>(state.status);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (state.status === "pending") {
      // 运行中贴底跟随，看到最新一轮输出。
      viewport.scrollTop = viewport.scrollHeight;
    } else if (previousStatusRef.current === "pending") {
      // 出结果时回到顶部：先读结论，再往下看过程。
      viewport.scrollTop = 0;
    }
    previousStatusRef.current = state.status;
  }, [state]);

  const trace = state.status === "idle" ? EMPTY_TRACE : (state.trace ?? EMPTY_TRACE);
  const pending = state.status === "pending";
  const result = state.status === "result" ? state : null;
  const error = state.status === "error" ? state : null;
  const verdictPreset = result ? VERDICT_PRESETS[result.verdict] : null;
  const failure = error ? failureDetail(error) : null;
  const modelLabel = result?.modelLabel ?? (state.status === "idle" ? undefined : state.modelLabel);
  const restored = result?.restored === true;
  // 历史列表不含当前正在展示的这条结果，避免同一份结论在面板里出现两次。
  const historyRecords = history.filter((record) => record.reviewId !== result?.reviewId);
  const durationLabel = useDurationLabel(state);
  // 结果已解析出 summary/findings 等分节时，最后一轮「审查中」的原始正文就是同一份
  // 结论，再在过程里重复一遍会让面板显得冗长；只隐藏最后一条（深度审查此前的
  // 取证叙述仍保留）。
  const lastReviewingTextIndex = (() => {
    for (let index = trace.length - 1; index >= 0; index -= 1) {
      const entry = trace[index];
      if (entry?.kind === "text" && entry.stage === "reviewing") return index;
    }
    return -1;
  })();
  const hideFinalReportText = state.status === "result";
  const isHiddenTextEntry = (entry: OracleReviewTraceEntry, index: number): boolean =>
    entry.kind === "text" &&
    // 上下文分析阶段的正文是内部 JSON（写入侧已跳过，这里再兜一层旧数据）。
    (entry.stage === "analyzing" || (hideFinalReportText && index === lastReviewingTextIndex));

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="v4-oracle-review-panel"
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        {pending ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
        ) : verdictPreset ? (
          <verdictPreset.icon className={cn("size-4 shrink-0", verdictPreset.iconClassName)} />
        ) : (
          <OctagonAlertIcon className="size-4 shrink-0 text-foreground-subtle" />
        )}
        <span className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.oracleReview.panel.title" })}
        </span>
        {pending ? (
          <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: STAGE_LABEL_KEYS[state.stage] })}
          </span>
        ) : result && verdictPreset ? (
          <span className={cn("shrink-0 text-ui-sm font-medium", verdictPreset.iconClassName)}>
            {intl.formatMessage({ id: verdictPreset.labelKey })}
          </span>
        ) : failure ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: failure.titleKey }, failure.titleValues)}
          </span>
        ) : null}
        {result?.depth === "deep" ? (
          <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.oracleReview.deepBadge" })}
          </span>
        ) : null}
        {restored ? (
          <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.oracleReview.restoredBadge" })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {modelLabel ? (
          <span
            className="min-w-0 shrink-0 truncate font-mono text-ui-xs text-foreground-subtle"
            title={modelLabel}
          >
            {modelLabelOf(modelLabel) ?? modelLabel}
          </span>
        ) : null}
        {durationLabel ? (
          <span className="shrink-0 tabular-nums text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.oracleReview.panel.duration" },
              { duration: durationLabel },
            )}
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
        <div className="flex flex-col gap-3">
          {result?.summary ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "chat.oracleReview.summary" })}
              </h3>
              <MessageResponse>{result.summary}</MessageResponse>
            </section>
          ) : null}
          {failure ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "chat.oracleReview.panel.failure" })}
              </h3>
              <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground">
                {intl.formatMessage({ id: failure.titleKey }, failure.titleValues)}
                {failure.detail ? `\n${failure.detail}` : ""}
              </p>
            </section>
          ) : null}
          <section className="flex flex-col gap-1.5" data-testid="v4-oracle-review-panel-trace">
            <h3 className="text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "chat.oracleReview.panel.process" })}
            </h3>
            {trace.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {restored
                  ? intl.formatMessage({ id: "chat.oracleReview.panel.noTrace" })
                  : intl.formatMessage({ id: "chat.oracleReview.panel.empty" })}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {trace.map((entry, index) =>
                  isHiddenTextEntry(entry, index) ? null : (
                    <TraceEntry
                      key={traceKey(entry, index)}
                      entry={entry}
                      streaming={pending && index === trace.length - 1}
                      tab={tab}
                    />
                  ),
                )}
              </div>
            )}
          </section>
          {result?.findings ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "chat.oracleReview.findings" })}
              </h3>
              <MessageResponse>{result.findings}</MessageResponse>
            </section>
          ) : null}
          {result?.requirements ? (
            <ResultSection titleKey="chat.oracleReview.requirements" body={result.requirements} />
          ) : null}
          {result?.scope ? (
            <ResultSection titleKey="chat.oracleReview.scope" body={result.scope} />
          ) : null}
          {result?.limits ? (
            <ResultSection titleKey="chat.oracleReview.limits" body={result.limits} />
          ) : null}
          {historyRecords.length > 0 ? (
            <section
              className="flex flex-col gap-2 border-t border-border/60 pt-3"
              data-testid="v4-oracle-review-panel-history"
            >
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "chat.oracleReview.panel.history" })}
              </h3>
              {historyRecords.map((record) => (
                <HistoryRecordEntry
                  key={record.reviewId}
                  record={record}
                  modelLabel={modelLabelOf(record.modelLabel) ?? record.modelLabel}
                />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollFadeViewport>
    </div>
  );
}

function TraceEntry({
  entry,
  streaming,
  tab,
}: {
  entry: OracleReviewTraceEntry;
  streaming: boolean;
  tab: OracleReviewSidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  if (entry.kind === "stage") {
    return (
      <div
        className="flex items-center gap-2 pt-1 text-ui-sm font-medium text-foreground-subtle"
        data-testid="v4-oracle-review-panel-stage"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-foreground-subtle/60" />
        <span className="shrink-0">
          {intl.formatMessage({ id: STAGE_LABEL_KEYS[entry.stage] })}
        </span>
        <span className="h-px min-w-0 flex-1 bg-border/60" />
      </div>
    );
  }
  if (entry.kind === "tool") {
    // 会话同款工具行（图标 + 动作标签 + 文件 chip / 命令 + hover），不再是
    // `#1 Bash …` 的等宽清单：面板里的过程应该和主对话读起来一样。
    return (
      <div data-testid="v4-oracle-review-panel-tool" data-round={entry.round}>
        <OracleReviewTraceToolRow
          toolId={`oracle-review-tool-${entry.round}-${entry.at}`}
          toolName={entry.toolName}
          {...(entry.target !== undefined ? { target: entry.target } : {})}
          workspacePath={tab.workspacePath}
        />
      </div>
    );
  }
  if (entry.kind === "note") {
    const hasContext = entry.priorCount + entry.turnCount + entry.constraintCount > 0;
    return (
      <div className="text-ui-sm text-foreground-subtle" data-testid="v4-oracle-review-panel-note">
        {hasContext
          ? intl.formatMessage(
              { id: "chat.oracleReview.panel.contextCandidates" },
              {
                prior: String(entry.priorCount),
                turns: String(entry.turnCount),
                constraints: String(entry.constraintCount),
              },
            )
          : intl.formatMessage({ id: "chat.oracleReview.panel.contextEmpty" })}
      </div>
    );
  }
  if (entry.kind === "reasoning") {
    // 会话同款思考块：默认收起，流式时摘要行只显示最新一行；用户点开看完整过程。
    // 时长优先用轨迹时间戳：面板晚于流式结束才打开时，组件自身计时还没开始。
    const durationSeconds =
      !streaming && entry.updatedAt !== undefined
        ? Math.max(1, Math.ceil((entry.updatedAt - entry.at) / 1000))
        : undefined;
    return (
      <div data-testid="v4-oracle-review-panel-reasoning">
        <Reasoning
          className="w-full"
          isStreaming={streaming}
          autoCollapseKey={streaming ? null : `${entry.stage}:${entry.round}`}
          {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
        >
          <ReasoningTrigger streamingText={entry.text} />
          <ReasoningContent>{entry.text}</ReasoningContent>
        </Reasoning>
      </div>
    );
  }
  return (
    <div data-testid="v4-oracle-review-panel-text">
      {/* 会话正文同一个渲染器（GenUiMessageResponse → streamdown）：审查正文里的
          列表、表格、代码块与 gen-ui 引用都按会话里的样子排出。 */}
      <GenUiMessageResponse
        completed={!streaming}
        messageKey={`oracle-review:${entry.stage}:${entry.round}`}
        streaming={streaming}
        workspacePath={tab.workspacePath}
        sessionId={tab.sessionId}
        {...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {})}
        {...(tab.remoteSessionId ? { workspaceRemoteSessionId: tab.remoteSessionId } : {})}
      >
        {entry.text}
      </GenUiMessageResponse>
      {entry.truncated ? (
        <div className="mt-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "chat.oracleReview.panel.truncated" },
            { chars: String(ORACLE_REVIEW_TRACE_TEXT_CAP) },
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 面板头部的耗时：pending 每秒跳动；出结果后固定为请求到完成的墙钟时长。 */
function useDurationLabel(state: OracleReviewState): string | null {
  const pendingStartedAt = state.status === "pending" ? state.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pendingStartedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingStartedAt]);
  if (state.status === "pending") {
    const seconds = Math.max(0, Math.round((now - state.startedAt) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (state.status !== "result") return null;
  const startedAt = state.request?.createdAt;
  if (startedAt === undefined) return null;
  const seconds = Math.max(0, Math.round((state.completedAt - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function traceKey(entry: OracleReviewTraceEntry, index: number): string {
  if (entry.kind === "stage") return `s-${entry.stage}-${entry.at}-${index}`;
  if (entry.kind === "tool") return `t-${entry.round}-${entry.at}-${index}`;
  if (entry.kind === "note") return `n-${entry.note}-${index}`;
  if (entry.kind === "reasoning") return `r-${entry.stage}-${entry.round}-${index}`;
  return `x-${entry.stage}-${entry.round}-${index}`;
}

/** 历史条目时间（月-日 时:分）：IntlInstance 只暴露 formatMessage，这里手拼以保持确定性。 */
function formatHistoryTime(completedAt: number): string {
  const date = new Date(completedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 持久审查历史条目：审查卡片关闭（acknowledged）后，结论仍可在这里回看。
 * 数据来自 CLI 持久记录（会话加载时种入 store），不是运行时状态机的投影；
 * rawOutput 存在时提供整段「完整结论」——格式解析失败时它是唯一完整原文。
 */
function HistoryRecordEntry({
  record,
  modelLabel,
}: {
  record: ZCodeOracleReviewRecord;
  modelLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const preset = VERDICT_PRESETS[record.verdict];
  return (
    <div className="flex flex-col gap-1" data-testid="v4-oracle-review-history-item">
      <div className="flex min-w-0 items-center gap-2 text-ui-sm">
        <preset.icon className={cn("size-3.5 shrink-0", preset.iconClassName)} />
        <span className={cn("shrink-0 font-medium", preset.iconClassName)}>
          {intl.formatMessage({ id: preset.labelKey })}
        </span>
        <span className="shrink-0 tabular-nums text-ui-xs text-foreground-subtle">
          {formatHistoryTime(record.completedAt)}
        </span>
        {record.depth === "deep" ? (
          <span className="shrink-0 rounded-sm bg-input px-1 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.oracleReview.deepBadge" })}
          </span>
        ) : null}
        {record.acknowledgedAt !== undefined ? (
          <span className="shrink-0 rounded-sm bg-input px-1 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.oracleReview.panel.historyAcknowledged" })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <span
          className="min-w-0 shrink-0 truncate font-mono text-ui-xs text-foreground-subtle"
          title={record.modelLabel}
        >
          {modelLabel}
        </span>
      </div>
      {record.summary ? (
        <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground">
          {record.summary}
        </p>
      ) : null}
      {record.findings ? (
        <ResultSection titleKey="chat.oracleReview.findings" body={record.findings} />
      ) : null}
      {record.rawOutput ? (
        <ResultSection titleKey="chat.oracleReview.panel.rawOutput" body={record.rawOutput} />
      ) : null}
      {record.requirements ? (
        <ResultSection titleKey="chat.oracleReview.requirements" body={record.requirements} />
      ) : null}
      {record.scope ? (
        <ResultSection titleKey="chat.oracleReview.scope" body={record.scope} />
      ) : null}
      {record.limits ? (
        <ResultSection titleKey="chat.oracleReview.limits" body={record.limits} />
      ) : null}
    </div>
  );
}
