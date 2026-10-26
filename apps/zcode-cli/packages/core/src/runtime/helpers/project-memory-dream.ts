import { basename, join, resolve } from "node:path";

import type { SessionInfo, TraceContext } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
} from "../../memory/dream.js";
import { runMemoryAgentLoop, type MemoryAgentLoopResult } from "../../memory/memory-agent-loop.js";
import { countPatchLines, createStructuredPatch } from "../../tool/diff.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  prepareProjectMemoryAgentRequest,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { invalidateProjectMemoryRecallPaths } from "./project-memory-recall.js";
import { isMainMemoryTaskType, resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 5;
const DREAM_MAX_TURNS = 50;
/** 快照只扫这么深的子目录：Memory 目录实际是平的，深扫只会被手工放的杂物拖慢。 */
const DREAM_SNAPSHOT_MAX_DEPTH = 3;

export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}

export type ProjectMemoryDreamStatus =
  | "completed"
  | "skipped"
  | "already_running"
  | "disabled"
  | "busy"
  | "failed";

export interface ProjectMemoryDreamChange {
  path: string;
  addedLines: number;
  removedLines: number;
}

export interface ProjectMemoryDreamResult {
  status: ProjectMemoryDreamStatus;
  /** status 的非完成原因：memory_disabled / remote_workspace / unsupported_workspace / … */
  reason?: string;
  summary?: string;
  turns?: number;
  touchedPaths: string[];
  changes: ProjectMemoryDreamChange[];
}

export interface ProjectMemoryDreamOptions {
  /**
   * 手动触发：跳过 24h 冷却与「≥5 条新 transcript」闸门，并把当前会话纳入整理范围。
   * 不跳过 dream lock——同一目录同时只允许一个整理进程。
   */
  force?: boolean;
  abortSignal?: AbortSignal;
}

export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
  /** 手动触发时当前会话也是素材（用户就是想让这一轮被整理进去）。 */
  includeCurrentSession?: boolean;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (!input.includeCurrentSession && session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

/**
 * 会话内手动触发整理（对应 fork 开关 memoryDreamManual）。
 *
 * 开关本身由协议层拦（bootstrap 读 appRuntimePreferences 后直接拒绝），core 只负责
 * 「force 的语义」：跳过时间/条数闸门、纳入当前会话，但绝不跳过锁。
 */
export function runMemoryDream(
  this: AgentRuntimeInternal,
  options: ProjectMemoryDreamOptions = {},
): Promise<ProjectMemoryDreamResult> {
  return runProjectMemoryDream(this, {
    abortSignal: options.abortSignal,
    force: options.force === true,
    traceContext: this.rootTraceContext,
  });
}

// 自动链路目前没有生产调用方（产品上 Dream 只在用户显式触发时运行）；保留这条
// 非 force 路径，闸门逻辑仍然可测，也不会在无人调用时产生后台开销。
export async function runProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { force?: boolean; abortSignal?: AbortSignal; traceContext: TraceContext },
): Promise<ProjectMemoryDreamResult> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return emptyDreamResult("disabled", "memory_disabled");
  if (runtime.isRemoteWorkspace()) return emptyDreamResult("disabled", "remote_workspace");
  if (!runtime.sessionStore || !runtime.fileSystemPort || !runtime.modelIoDir) {
    return emptyDreamResult("disabled", "unsupported_workspace");
  }
  // 自动 Extraction 与 Dream 写同一个 Memory 目录：前者有待处理任务时不让用户并发触发，
  // 否则两边都基于旧快照算 diff/索引，后写的一方会覆盖前者的行。
  if (runtime.memoryExtractionScheduler?.hasPendingWork() === true) {
    return emptyDreamResult("busy", "extraction_pending");
  }

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  return executeProjectMemoryDream(runtime, context, {
    abortSignal: input.abortSignal,
    force: input.force === true,
  });
}

export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

async function executeProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  options: { abortSignal?: AbortSignal; force: boolean },
): Promise<ProjectMemoryDreamResult> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: context.causation,
    executionKind: "background",
    operation: "project_memory_dream",
    targetKind: "project_memory",
    traceContext: context.traceContext,
    trigger: options.force ? "user" : "scheduler",
  });

  return telemetry.run(async () => {
    let acquiredPriorMtimeMs: number | undefined;
    try {
      const nowMs = runtime.now().getTime();
      const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(context.memoryRoot);
      if (!options.force) {
        const timing = evaluateAutoDreamTiming({
          lastConsolidatedAtMs,
          lastScanAtMs: runtime.memoryDreamLastScanAtMs,
          nowMs,
        });
        if (timing.decision === "skip") {
          telemetry.setResultType("metadata");
          telemetry.finishCompleted();
          return emptyDreamResult("skipped", "not_due");
        }
      }

      runtime.memoryDreamLastScanAtMs = nowMs;
      const sessions = selectProjectDreamSessions({
        currentSessionId: runtime.sessionId,
        includeCurrentSession: options.force,
        sessions: await runtime.sessionStore!.listSessions(),
        workspacePath: context.workspaceRoot,
        workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      });
      const transcriptSessionIds = await recentModelIoSessionIds(
        runtime,
        sessions,
        context,
        lastConsolidatedAtMs,
      );
      // force：手动触发不看条数门槛——只要该工作区还有 transcript 就整理，
      // 一条都没有时仍然跳过（没有素材可整理）。
      if (
        transcriptSessionIds.length === 0 ||
        (!options.force && transcriptSessionIds.length < DREAM_MINIMUM_TRANSCRIPT_SESSIONS)
      ) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return emptyDreamResult("skipped", "insufficient_transcripts");
      }

      const priorMtimeMs = await acquireDreamLock({ memoryRoot: context.memoryRoot, nowMs });
      if (priorMtimeMs === null) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return emptyDreamResult("already_running", "dream_lock_held");
      }
      acquiredPriorMtimeMs = priorMtimeMs;

      const before = await snapshotMemoryFiles(runtime, context.memoryRoot);
      const prompt = buildMemoryDreamPrompt({
        memoryRoot: context.memoryRoot,
        sessionIds: transcriptSessionIds,
        transcriptRoot: runtime.modelIoDir!,
      });
      const request = prepareProjectMemoryAgentRequest(context, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, context);
      const touchedPaths = new Set<string>();

      const loopResult = await runMemoryAgentLoop({
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        executeTool: (toolCall, toolOptions) => {
          collectDreamTouchedPaths(touchedPaths, {
            rootDir: context.memoryRoot,
            toolCall,
            workingDirectory: context.workingDirectory,
            workspaceRoot: context.workspaceRoot,
          });
          return executor.execute(toolCall, {
            signal: toolOptions.abortSignal,
            traceContext: context.traceContext,
          });
        },
        maxTurns: DREAM_MAX_TURNS,
        request,
        model: context.model,
        rootDir: context.memoryRoot,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

      const paths = [...touchedPaths];
      if (paths.length > 0) {
        runtime.pendingMemoryUpdate = createProjectMemoryUpdate(runtime, paths);
        invalidateProjectMemoryRecallPaths(runtime, paths);
      }
      const after = await snapshotMemoryFiles(runtime, context.memoryRoot);
      const changes = diffMemorySnapshots(before, after);
      telemetry.finishCompleted();
      return {
        status: "completed" as const,
        summary: lastAssistantText(loopResult),
        turns: loopResult.turns,
        touchedPaths: paths,
        changes,
      };
    } catch (error) {
      telemetry.finishFailed("execute", "internal", error);
      if (acquiredPriorMtimeMs !== undefined) {
        try {
          await restoreDreamLockAfterFailure({
            memoryRoot: context.memoryRoot,
            priorMtimeMs: acquiredPriorMtimeMs,
          });
        } catch {
          // Dream 已失败；lock 恢复失败不改变前台 turn，也不追加第二套恢复机制。
        }
      }
      return emptyDreamResult("failed", error instanceof Error ? error.message : String(error));
    }
  });
}

function createProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
  paths: string[],
): ProjectMemoryUpdate {
  const inContextPaths = paths.filter(
    (path) =>
      basename(path) === "MEMORY.md" ||
      runtime.memoryRecallState.recalledPaths.has(path) ||
      findLatestReadFileState(runtime.readFileState, path) !== undefined,
  );
  return {
    inContextPaths,
    paths,
    source: "dream",
    summary: `consolidated ${paths.length} memory file${paths.length === 1 ? "" : "s"}`,
  };
}

function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}

function emptyDreamResult(
  status: ProjectMemoryDreamStatus,
  reason: string,
): ProjectMemoryDreamResult {
  return { status, reason, touchedPaths: [], changes: [] };
}

async function recentModelIoSessionIds(
  runtime: AgentRuntimeInternal,
  sessions: readonly SessionInfo[],
  context: ProjectMemoryAgentContext,
  lastConsolidatedAtMs: number,
): Promise<string[]> {
  const sessionIds = await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await runtime.fileSystemPort!.stat({
          path: join(runtime.modelIoDir!, `model-io-${session.id}.jsonl`),
          trace: context.traceContext,
        });
        // 修复原因：gate 以真实 transcript mtime 为准；SessionStore.updated 只描述
        // durable session，不能代替 transcript 是否在上次 consolidation 后发生变化。
        return result.kind === "file" &&
          result.mtimeMs !== undefined &&
          result.mtimeMs > lastConsolidatedAtMs
          ? String(session.id)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return sessionIds.filter((sessionId): sessionId is string => sessionId !== undefined);
}

async function snapshotMemoryFiles(
  runtime: AgentRuntimeInternal,
  memoryRoot: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > DREAM_SNAPSHOT_MAX_DEPTH) return;
    let listing: Awaited<
      ReturnType<NonNullable<AgentRuntimeInternal["fileSystemPort"]>["listDirectory"]>
    >;
    try {
      listing = await runtime.fileSystemPort!.listDirectory({ path: directory });
    } catch {
      return;
    }
    for (const entry of listing.entries) {
      if (entry.kind === "directory") {
        await walk(entry.path, depth + 1);
        continue;
      }
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
      try {
        const read = await runtime.fileSystemPort!.readTextFile({ path: entry.path });
        files.set(entry.path, read.content);
      } catch {
        // 并发删除/无权限：该文件不进入本次快照，也就不产生 diff。
      }
    }
  };
  await walk(memoryRoot, 0);
  return files;
}

/** 逐文件行级增删：新增文件全是 +，删除文件全是 -，两者都在时用结构化 patch 计数。 */
export function diffMemorySnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ProjectMemoryDreamChange[] {
  const changes: ProjectMemoryDreamChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const beforeContent = before.get(path);
    const afterContent = after.get(path);
    if (beforeContent === afterContent) continue;
    if (beforeContent === undefined) {
      changes.push({ path, addedLines: countLines(afterContent ?? ""), removedLines: 0 });
      continue;
    }
    if (afterContent === undefined) {
      changes.push({ path, addedLines: 0, removedLines: countLines(beforeContent) });
      continue;
    }
    const hunks = createStructuredPatch({
      filePath: path,
      oldContent: beforeContent,
      newContent: afterContent,
    });
    const { additions, deletions } = countPatchLines(hunks);
    changes.push({ path, addedLines: additions, removedLines: deletions });
  }
  return changes;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function lastAssistantText(result: MemoryAgentLoopResult): string | undefined {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index]!;
    if (message.role !== "assistant") continue;
    const text = messageContentText(message.content);
    if (text.length > 0) return text.slice(0, 2_000);
  }
  return undefined;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part === "object" && part !== null && "text" in part) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}
