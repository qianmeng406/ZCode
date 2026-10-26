import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseCompactBoundaryPayload,
} from "../deps.js";
import type {
  CompactBoundaryPayload,
  MessageId,
  MessageWithParts,
  SessionEvent,
  SessionId,
  DiffHunk,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  ToolExecutionResult,
} from "../deps.js";
import type { WorkspaceRewindRestoredFile } from "../types.js";
import { isPlainRecord, isRuntimeDiffHunk } from "./data.js";
import { sanitizeSystemReminderBody } from "../../system-reminder/source.js";

export const WORKSPACE_CHECKPOINT_CONTENT_TYPE = "application/vnd.zcode.workspace-checkpoint+json";

interface FileMutationCheckpointCandidate {
  /** null = 变更后该路径不存在（删除、move 的源文件）。 */
  content?: string | null;
  filePath: string;
  originalFile: string | null;
  structuredPatch: DiffHunk[];
  type?: string;
}

interface RewindEvaluationItem {
  compactBoundary?: CompactBoundaryPayload;
  id: string;
}

/**
 * 从 tool output 提取 workspace checkpoint 候选。
 *
 * 两种形状：
 *   1. 单文件工具（Edit/Write/NotebookEdit）：顶层 `filePath/originalFile/content/structuredPatch`；
 *   2. 多文件工具（ApplyPatch）：`files[]` 每项同形状，move 额外展开成「源文件消失 + 目标文件新建」
 *      两条，否则 rewind 只能恢复一半。
 *
 * 任一 file 形状不合法就整体放弃——半份 checkpoint 会让 rewind 恢复出比实际更早的状态。
 */
export function getFileMutationCheckpointCandidates(
  output: unknown,
): FileMutationCheckpointCandidate[] {
  const single = toCheckpointCandidate(output);
  if (single) return [single];
  if (!isPlainRecord(output) || !Array.isArray(output.files)) return [];

  const candidates: FileMutationCheckpointCandidate[] = [];
  for (const file of output.files) {
    const expanded = expandFileCheckpointCandidate(file);
    if (!expanded) return [];
    candidates.push(...expanded);
  }
  return candidates;
}

function expandFileCheckpointCandidate(
  value: unknown,
): FileMutationCheckpointCandidate[] | undefined {
  const candidate = toCheckpointCandidate(value);
  if (!candidate || !isPlainRecord(value)) return undefined;
  const movePath = value.movePath;
  if (typeof movePath !== "string" || movePath.length === 0) return [candidate];
  return [
    { ...candidate, content: null },
    {
      content: candidate.content,
      filePath: movePath,
      originalFile: null,
      structuredPatch: candidate.structuredPatch,
      type: "add",
    },
  ];
}

function toCheckpointCandidate(value: unknown): FileMutationCheckpointCandidate | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (typeof value.filePath !== "string" || value.filePath.length === 0) return undefined;
  if (!Array.isArray(value.structuredPatch)) return undefined;
  if (value.originalFile !== null && typeof value.originalFile !== "string") return undefined;

  const structuredPatch = value.structuredPatch.filter(isRuntimeDiffHunk);
  if (structuredPatch.length !== value.structuredPatch.length) return undefined;

  return {
    content:
      value.content === null ? null : typeof value.content === "string" ? value.content : undefined,
    filePath: value.filePath,
    originalFile: value.originalFile,
    structuredPatch,
    type: typeof value.type === "string" ? value.type : undefined,
  };
}

export function stringifyWorkspaceCheckpointArtifact(
  candidates: readonly FileMutationCheckpointCandidate[],
  result: ToolExecutionResult,
): string {
  const artifact: WorkspaceCheckpointArtifact = {
    createdAt: new Date().toISOString(),
    files: candidates.map((candidate) => ({
      ...(candidate.content !== undefined ? { afterContent: candidate.content } : {}),
      afterContentLength: candidate.content?.length,
      beforeContent: candidate.originalFile,
      existedBefore: candidate.originalFile !== null,
      path: candidate.filePath,
      structuredPatch: candidate.structuredPatch,
    })),
    kind: "workspace_file_before_change",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    version: 1,
  };

  return JSON.stringify(artifact, null, 2);
}

export function selectCheckpointForRewind(
  events: readonly SessionEvent[],
  checkpointId?: string,
): CheckpointCreatedPayload | undefined {
  const checkpoints = events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => parseCheckpointCreatedPayload(event.payload))
    .filter(
      (checkpoint) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    );

  if (checkpointId) {
    return checkpoints.find((checkpoint) => checkpoint.checkpointId === checkpointId);
  }

  return checkpoints.at(-1);
}

export function selectCheckpointForMessage(
  events: readonly SessionEvent[],
  targetMessageId: MessageId,
): CheckpointCreatedPayload | undefined {
  return selectCheckpointForMessages(events, [targetMessageId]);
}

export function selectCheckpointsForMessages(
  events: readonly SessionEvent[],
  targetMessageIds: Iterable<MessageId>,
): CheckpointCreatedPayload[] {
  const targetMessageIdSet = new Set(targetMessageIds);
  if (targetMessageIdSet.size === 0) return [];

  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => parseCheckpointCreatedPayload(event.payload))
    .filter(
      (checkpoint) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    )
    .filter((checkpoint) =>
      Array.from(targetMessageIdSet).some((targetMessageId) =>
        checkpointMatchesMessage(checkpoint, targetMessageId),
      ),
    );
}

export function selectCheckpointForMessages(
  events: readonly SessionEvent[],
  targetMessageIds: Iterable<MessageId>,
): CheckpointCreatedPayload | undefined {
  return selectCheckpointsForMessages(events, targetMessageIds).at(-1);
}

export function activeSuffixMessageIdsForRewind(
  messages: readonly MessageWithParts[],
  targetMessageId: MessageId,
): MessageId[] {
  const targetIndex = messages.findIndex((message) => message.info.id === targetMessageId);
  if (targetIndex < 0) return [];

  return messages.slice(targetIndex).map((message) => message.info.id as MessageId);
}

function checkpointMatchesMessage(
  checkpoint: CheckpointCreatedPayload,
  targetMessageId: MessageId,
): boolean {
  return (
    checkpoint.messageId === targetMessageId ||
    checkpoint.targetMessageId === targetMessageId ||
    checkpoint.toolMessageId === targetMessageId
  );
}

export function previewTextFromMessage(message: MessageWithParts): string | undefined {
  const textPart =
    message.parts.find((part) => part.type === "text" && !part.synthetic) ??
    message.parts.find((part) => part.type === "text");
  if (!textPart || textPart.type !== "text") return undefined;

  const compact = textPart.text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

export function buildMessageRewindEvaluationItems(
  messages: readonly MessageWithParts[],
): RewindEvaluationItem[] {
  return messages.map((message) => {
    const compactionPart = message.parts.find(
      (part) => part.type === "compaction" && part.compactBoundary,
    );
    if (compactionPart?.type !== "compaction" || !compactionPart.compactBoundary) {
      return { id: message.info.id };
    }

    return {
      id: message.info.id,
      compactBoundary: parseCompactBoundaryPayload(compactionPart.compactBoundary),
    };
  });
}

export function buildRewindEvaluationItems(
  events: readonly SessionEvent[],
): RewindEvaluationItem[] {
  const items: RewindEvaluationItem[] = [];
  for (const event of events) {
    if (event.type === SessionEventType.CheckpointCreated) {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      items.push({ id: checkpoint.targetMessageId ?? checkpoint.messageId });
      continue;
    }

    if (event.type === SessionEventType.CompactBoundary) {
      const compactBoundary = parseCompactBoundaryPayload(event.payload);
      items.push({
        id: `compact_boundary:${compactBoundary.boundaryId}`,
        compactBoundary,
      });
    }
  }
  return items;
}

export function formatConversationRewindNoticeBody(options: {
  keptMessageCount: number;
  preview?: string;
  rewindId: string;
  targetMessageId: MessageId;
}): string {
  return sanitizeSystemReminderBody(
    [
      "Conversation rewind applied.",
      `rewindId: ${options.rewindId}`,
      `targetMessageId: ${options.targetMessageId}`,
      `keptMessageCount: ${options.keptMessageCount}`,
      options.preview ? `rewoundPromptPreview: ${options.preview}` : undefined,
      "Continue from the conversation state before the target user message. Do not assume messages after that target happened in this active branch.",
    ].filter((line): line is string => typeof line === "string" && line.length > 0),
  );
}

export function formatWorkspaceRewindNoticeBody(options: {
  checkpoint: CheckpointCreatedPayload;
  evaluation: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  rewindId: string;
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody(
    [
      "Workspace rewind applied.",
      `rewindId: ${options.rewindId}`,
      `checkpointId: ${options.checkpoint.checkpointId}`,
      `strategy: ${options.evaluation.strategy}`,
      `restoredFiles: ${options.restoredFiles.length}`,
      fileLines,
      "Conversation history was not rewritten by this file restore.",
    ].filter((line) => line.length > 0),
  );
}

export function formatWorkspaceForkNoticeBody(options: {
  checkpoint: CheckpointCreatedPayload;
  parentSessionId: SessionId;
  restoredFiles: WorkspaceRewindRestoredFile[];
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody(
    [
      "This session was forked from a previous session checkpoint.",
      `parentSessionId: ${options.parentSessionId}`,
      `checkpointId: ${options.checkpoint.checkpointId}`,
      `targetMessageId: ${options.checkpoint.messageId}`,
      `restoredSnapshotRef: ${options.checkpoint.snapshotRef}`,
      `restoredFiles: ${options.restoredFiles.length}`,
      fileLines,
      "Continue from this fork. Do not assume messages after the fork point happened in this session.",
    ].filter((line) => line.length > 0),
  );
}

export function formatWorkspaceForkAtMessageNoticeBody(options: {
  parentSessionId: SessionId;
  restoredFiles: WorkspaceRewindRestoredFile[];
  targetMessageId: MessageId;
  undoneCheckpointCount: number;
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody(
    [
      "This session was forked from a previous session message.",
      `parentSessionId: ${options.parentSessionId}`,
      `targetMessageId: ${options.targetMessageId}`,
      `undoneCheckpointCount: ${options.undoneCheckpointCount}`,
      `restoredFiles: ${options.restoredFiles.length}`,
      fileLines,
      "Workspace files changed after the fork point were restored to their state at the fork point.",
      "Continue from this fork. Do not assume messages after the fork point happened in this session.",
    ].filter((line) => line.length > 0),
  );
}

export function formatConversationForkNoticeBody(options: {
  parentSessionId: SessionId;
  targetMessageId: MessageId;
}): string {
  return sanitizeSystemReminderBody([
    "This session was forked from a previous session message.",
    `parentSessionId: ${options.parentSessionId}`,
    `targetMessageId: ${options.targetMessageId}`,
    "No workspace checkpoint was restored for this fork.",
    "Continue from this fork. Do not assume messages after the fork point happened in this session.",
  ]);
}

export function formatUnavailableRewindResponse(
  reason: string,
  checkpointId?: string,
  targetMessageId?: MessageId,
): string {
  const target = checkpointId ? ` ${checkpointId}` : "";
  const messageTarget = targetMessageId ? ` ${targetMessageId}` : "";
  switch (reason) {
    case "no_checkpoint_available":
      return "No workspace checkpoint is available yet.";
    case "target_checkpoint_not_found":
      return targetMessageId
        ? `No workspace checkpoint was found for message${messageTarget}.`
        : `Checkpoint${target} was not found.`;
    case "target_message_not_found":
      return `Message${messageTarget} is not available in the active conversation branch.`;
    case "target_message_is_not_user_prompt":
      return `Message${messageTarget} is not a rewindable user prompt.`;
    case "conversation_rewind_requires_session_store":
      return "Conversation rewind is unavailable because session storage is not configured.";
    case "artifact_store_not_configured":
      return "Workspace rewind is unavailable because artifact storage is not configured.";
    case "file_system_port_not_configured":
      return "Workspace rewind is unavailable because file-system access is not configured.";
    case "checkpoint_snapshot_unavailable":
      return `Checkpoint${target} cannot be restored because its snapshot artifact is unavailable.`;
    case "target_covered_by_compact_requires_fork":
      return `Message${messageTarget || target} is covered by compact for conversation rewind; create a fork to rewind conversation history.`;
    default:
      return `Workspace rewind is unavailable: ${reason}.`;
  }
}
