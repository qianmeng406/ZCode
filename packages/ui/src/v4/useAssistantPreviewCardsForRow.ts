import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssistantTextRow,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantPreviewCard,
} from "@/lib/assistantPreviewCards.js";
import {
  resolveAssistantPreviewLoadAction,
  type AssistantPreviewLoadAction,
} from "@/lib/onDemandLoadingGuards.js";
import { logger } from "@/logger.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationFileChangesState,
} from "@/v4/conversationRowContext.js";

interface UseAssistantPreviewCardsForAssistantTextRowParams {
  row?: AssistantTextRow;
  assistantTextRows: readonly AssistantTextRow[];
  latestAssistantTextRow?: AssistantTextRow;
  workspacePath: string;
  workspaceHomePath?: string;
  compactForRemoteControl?: boolean;
  fileChangesTarget: ConversationRowTarget | null;
  fileChangesState?: ConversationFileChangesState;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  /** 自动加载偏好（缺省 true）；关闭后由「加载预览」手动触发（specs/assistant-auto-file-preview.md）。 */
  autoPreviewEnabled?: boolean;
  /** 展示可见性（缺省 true）：隐藏时不发起自动查询，恢复后重新裁决补齐。 */
  presentationVisible?: boolean;
}

export interface AssistantPreviewCardsResult {
  cards: AssistantPreviewCard[];
  loadAction: AssistantPreviewLoadAction;
  manualLoading: boolean;
  loadManually: () => void;
}

interface PreviewRequestState {
  key: string;
  status: "loaded" | "failed";
  paths: readonly string[];
}

interface StaleRetryState {
  key: string;
  attempt: number;
}

const EMPTY_CHANGED_FILE_PATHS: readonly string[] = [];
const STALE_FILE_CHANGES_MAX_RETRIES = 3;
const STALE_FILE_CHANGES_RETRY_BASE_DELAY_MS = 150;

function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {
  return rows
    .map((row) => row.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function useAssistantPreviewCardsForAssistantTextRow({
  row,
  assistantTextRows,
  latestAssistantTextRow,
  workspacePath,
  workspaceHomePath,
  compactForRemoteControl,
  fileChangesTarget,
  fileChangesState,
  fetchFileChanges,
  autoPreviewEnabled = true,
  presentationVisible = true,
}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCardsResult {
  const turnText = useMemo(() => joinAssistantTurnText(assistantTextRows), [assistantTextRows]);
  const canBuildCards =
    row !== undefined &&
    latestAssistantTextRow?.rowId === row.rowId &&
    (row.state === "complete" || row.state === "interrupted");
  const fileReferences = useMemo(
    () =>
      canBuildCards
        ? extractAssistantFileReferences(turnText, workspacePath, {
            homePath: workspaceHomePath,
          })
        : [],
    [canBuildCards, turnText, workspaceHomePath, workspacePath],
  );
  const needsFileChanges = fileReferences.some(
    (reference) =>
      reference.kind === "markdown" ||
      (reference.kind === "html" && compactForRemoteControl !== true),
  );
  const target = useMemo<ConversationRowTarget | null>(
    () =>
      fileChangesTarget
        ? {
            rowId: fileChangesTarget.rowId,
            entityId: fileChangesTarget.entityId,
          }
        : null,
    [fileChangesTarget?.entityId, fileChangesTarget?.rowId],
  );
  const requestKey = target
    ? `${target.rowId}:${target.entityId}:${fileChangesState ?? "unknown"}`
    : "";
  const [requestState, setRequestState] = useState<PreviewRequestState | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  // stale 恢复重试（上游 v3.17.2）：turn 刚 complete 时查询可能被判 staleRevision，稍后重查即可。
  const [staleRetry, setStaleRetry] = useState<StaleRetryState | null>(null);
  const staleRetryAttempt = staleRetry?.key === requestKey ? staleRetry.attempt : 0;
  const loadSeqRef = useRef(0);
  const staleRetryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadAction = resolveAssistantPreviewLoadAction({
    autoPreviewEnabled,
    visible: presentationVisible,
    hasMarkdownOrHtmlReference: needsFileChanges,
    hasTarget: Boolean(target),
    fileChangesState,
    isLatestCompleteTurn: canBuildCards,
    requestState: requestState?.key === requestKey ? requestState.status : ("none" as const),
  });

  // 自动与手动共用同一条权威读取路径（同一缓存策略与 builder）；
  // 回包校验请求代际与 key，隐藏/卸载/作用域变化后的迟到结果不提交。
  const runLoad = useCallback(() => {
    if (!fetchFileChanges || !target) return;
    // rewind 后 header 的 reverted 状态是权威投影；无需等待详情 RPC，立即抑制 md/html。
    if (fileChangesState === "reverted") return;

    const loadSeq = ++loadSeqRef.current;
    setManualLoading(true);
    // V4 fileChanges 只接受 turnHeader；assistantText 仅用于正文和卡片锚点。
    // 先用空门控同步投影 Office/PDF；只有确实出现 md/html 时才读取本轮明细。
    void fetchFileChanges(target, {
      cachePolicy: "terminal",
      fileChangesState,
    }).then(
      (result) => {
        if (loadSeqRef.current !== loadSeq) return;
        setManualLoading(false);
        setRequestState({
          key: requestKey,
          status: "loaded",
          paths: result.state === "reverted" ? [] : result.items.map((item) => item.path),
        });
      },
      (error: unknown) => {
        if (loadSeqRef.current !== loadSeq) return;
        setManualLoading(false);
        // Bug 根因：turn 刚 complete 时 projection revision 仍会被后续事件推进，查询带的
        // baseRevision 会被 Agent 判为 proto.staleRevision。requestKey 不含 revision，若这里
        // 记成空列表，本轮 md/html 卡片会一直被抑制；SessionPane 已删除失败缓存并触发
        // stale recovery，稍后用最新 revision 重查即可。
        if (
          shouldResyncForStaleAuthority(error) &&
          staleRetryAttempt < STALE_FILE_CHANGES_MAX_RETRIES
        ) {
          if (staleRetryTimerRef.current !== undefined) clearTimeout(staleRetryTimerRef.current);
          staleRetryTimerRef.current = setTimeout(
            () => {
              staleRetryTimerRef.current = undefined;
              setStaleRetry({ key: requestKey, attempt: staleRetryAttempt + 1 });
            },
            STALE_FILE_CHANGES_RETRY_BASE_DELAY_MS * (staleRetryAttempt + 1),
          );
          return;
        }
        logger.warn("[AssistantPreviewCards] 读取本轮文件变更失败，已抑制 Markdown/HTML 卡片", {
          error: error instanceof Error ? error.message : String(error),
          rowId: target.rowId,
        });
        setRequestState({ key: requestKey, status: "failed", paths: [] });
      },
    );
  }, [fetchFileChanges, fileChangesState, requestKey, staleRetryAttempt, target]);

  const loadManually = useCallback(() => {
    if (manualLoading) return;
    runLoad();
  }, [manualLoading, runLoad]);

  useEffect(() => {
    if (loadAction !== "auto") return;
    runLoad();
  }, [loadAction, runLoad]);

  // stale 恢复重试：attempt 递增时无条件重查（stale 只在真实失败后置位；
  // requestKey 变化后 attempt 归零，不会误触发）。
  useEffect(() => {
    if (staleRetryAttempt === 0) return;
    runLoad();
  }, [staleRetryAttempt, runLoad]);

  useEffect(
    () => () => {
      // 卸载使迟到回包失效，并撤销未触发的 stale 重试。
      loadSeqRef.current += 1;
      if (staleRetryTimerRef.current !== undefined) clearTimeout(staleRetryTimerRef.current);
    },
    [],
  );

  const changedFilePaths =
    needsFileChanges && requestState?.key === requestKey && requestState.status === "loaded"
      ? requestState.paths
      : EMPTY_CHANGED_FILE_PATHS;

  const cards = useMemo(
    () =>
      canBuildCards
        ? buildAssistantPreviewCardsFromReferences(turnText, workspacePath, fileReferences, {
            changedFilePaths,
            homePath: workspaceHomePath,
            suppressWebRemoteCards: compactForRemoteControl === true,
          })
        : [],
    [
      canBuildCards,
      changedFilePaths,
      compactForRemoteControl,
      fileReferences,
      turnText,
      workspaceHomePath,
      workspacePath,
    ],
  );

  return { cards, loadAction, manualLoading, loadManually };
}
