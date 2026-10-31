import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  createWorkspaceId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";

import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  diffMemorySnapshots,
  runProjectMemoryDream,
  selectProjectDreamSessions,
} from "../src/runtime/helpers/project-memory-dream.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const WORKSPACE_PATH = "/workspace/project";
const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const MEMORY_UPDATE_FIXTURE = readFileSync(
  new URL("./fixtures/memory/memory-update.md", import.meta.url),
  "utf8",
).trimEnd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Dream session selection", () => {
  it("keeps Main-equivalent sessions from the current workspace and leaves recency to transcript mtime", () => {
    const current = createSessionId("current");
    const workspaceIdentity = createWorkspaceId("remote:opaque");
    const sessions = [
      session("one", NOW, { workspaceID: workspaceIdentity }),
      session("two", NOW - 1, { taskType: "fork", workspaceID: workspaceIdentity }),
      session("child", NOW, { taskType: "subagent_child", workspaceID: workspaceIdentity }),
      session("other", NOW, { workspaceID: createWorkspaceId("remote:other") }),
      session("old", NOW - 10_000, { workspaceID: workspaceIdentity }),
      session("current", NOW, { workspaceID: workspaceIdentity }),
    ];

    expect(
      selectProjectDreamSessions({
        currentSessionId: current,
        sessions,
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity,
      }).map((item) => item.id),
    ).toEqual([createSessionId("one"), createSessionId("two"), createSessionId("old")]);
  });
});

describe("AgentRuntime Dream handler", () => {
  it("consumes a Dream update at the next Main request in the same tool loop", async () => {
    const mainRequestTexts: string[] = [];
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CompleteMemoryUpdateBoundary",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "tool complete",
    });
    let runtime!: AgentRuntime;
    runtime = createTestAgentRuntime(
      createSessionId("same-turn-memory-update"),
      {
        memory: {
          cliStorageRoot: "/storage/cli",
          enabled: true,
          use: true,
        },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort: new MemoryFileSystem({}),
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: true },
          async generateText(request, observation) {
            mainRequestTexts.push(providerMessagesToText(request.messages));
            if (mainRequestTexts.length === 1) {
              (runtime as any).pendingMemoryUpdate = {
                inContextPaths: [],
                paths: ["/memory/fact.md"],
                source: "dream",
                summary: "consolidated 1 memory file",
              };
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "memory-update-boundary", input: {}, name: "CompleteMemoryUpdateBoundary" },
                ],
              };
            }
            return textResult(observation.model, "done");
          },
        }),
        toolRegistry: registry,
      },
    );

    await runtime.executeTurn("please check the updated memory");

    expect(mainRequestTexts).toHaveLength(2);
    expect(mainRequestTexts[0]).not.toContain("Background memory consolidation updated");
    expect(mainRequestTexts[1]).toContain(
      "Background memory consolidation updated your memory directory: consolidated 1 memory file",
    );
    expect((runtime as any).pendingMemoryUpdate).toBeUndefined();
  });

  it("is not auto-triggered and uses newer transcript mtimes when explicitly invoked", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const factPath = join(memoryRoot, "release-tagging-policy.md");
    const indexPath = join(memoryRoot, "MEMORY.md");
    const pastSessions = Array.from({ length: 6 }, (_, index) =>
      session(`past-${index + 1}`, NOW - index),
    );
    const transcriptFiles = Object.fromEntries(
      pastSessions.map((pastSession) => [
        join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
        "{}\n",
      ]),
    );
    const transcriptMtimes = Object.fromEntries(
      pastSessions.map((pastSession, index) => [
        join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
        index < 5 ? NOW : 0,
      ]),
    );
    const fileSystemPort = new MemoryFileSystem(transcriptFiles, transcriptMtimes);
    const dreamResponseSeen = deferred<void>();
    const mainRequests: ModelRequest["messages"][] = [];
    const mainRequestTexts: string[] = [];
    let dreamTurn = 0;
    const dreamContexts: ModelInvocationContext[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("current-dream"),
      {
        memory: {
          cliStorageRoot,
          enabled: true,
          use: true,
        },
        mode: "yolo",
        modelSelection: {
          modelId: createModelId("claude-opus-4-8-cc"),
          providerId: createModelProviderId("anthropic"),
        },
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: true },
          async generateText(request, observation) {
            const text = providerMessagesToText(request.messages);
            if (!text.includes("# Dream: Memory Consolidation")) {
              mainRequests.push(request.messages);
              mainRequestTexts.push(text);
              return textResult(observation.model, `main ${mainRequestTexts.length}`);
            }
            dreamTurn += 1;
            dreamContexts.push(observation.invocationContext!);
            if (dreamTurn === 1) {
              for (const pastSession of pastSessions.slice(0, 5)) {
                expect(text).toContain(String(pastSession.id));
              }
              expect(text).not.toContain(String(pastSessions[5]!.id));
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "write-fact",
                    name: "Write",
                    input: { file_path: factPath, content: "fact" },
                  },
                  {
                    id: "write-index",
                    name: "Write",
                    input: { file_path: indexPath, content: "- [Fact](release-tagging-policy.md)" },
                  },
                ],
              };
            }
            dreamResponseSeen.resolve();
            return textResult(observation.model, "Dream complete");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );
    const recallState = (runtime as any).memoryRecallState;
    recallState.manifest = [
      {
        filePath: "/old-memory.md",
        filename: "old-memory.md",
        mtimeMs: 1,
      },
    ];
    recallState.selectorMessages = [{ role: "user", content: "old manifest" }];
    recallState.recalledContentCharacters = 123;

    await runtime.executeTurn("start");
    expect(dreamTurn).toBe(0);
    await runProjectMemoryDream(runtime as never, {
      traceContext: createRootTraceContext({
        sessionId: createSessionId("current-dream"),
        turnId: createTurnId("explicit-dream-handler"),
      }),
    });
    await dreamResponseSeen.promise;
    await waitFor(() => (runtime as any).pendingMemoryUpdate !== undefined);
    expect(dreamContexts).toHaveLength(2);
    for (const context of dreamContexts) {
      expect(context).toMatchObject({
        modelRequestSessionType: "main",
        metadata: { querySource: "project_memory_dream", skipTranscript: true },
      });
    }

    expect(fileSystemPort.files[factPath]).toBe("fact");
    expect(fileSystemPort.files[indexPath]).toContain("[Fact]");
    expect(recallState.manifest).toBeUndefined();
    expect(recallState.selectorMessages).toBeUndefined();
    expect(recallState.recalledContentCharacters).toBe(123);

    await runtime.executeTurn("next");
    const expectedUpdate = MEMORY_UPDATE_FIXTURE.replaceAll("<MEMORY_ROOT>", memoryRoot);
    const nextRequest = mainRequests[1] ?? [];
    // provider content 现在可能是分块数组（upstream 的 meta_user 投影），按文本比较；
    // fixture 里的路径按 POSIX 写，Windows 上 join 产出反斜杠，比较前统一分隔符。
    const normalizeSeparators = (value: string) => value.split("\\").join("/");
    const updateIndex = nextRequest.findIndex(
      (message) =>
        message.role === "system" &&
        normalizeSeparators(providerMessagesToText([message])) ===
          normalizeSeparators(expectedUpdate),
    );
    expect(updateIndex).toBe(nextRequest.length - 1);
    expect(normalizeSeparators(providerMessagesToText([nextRequest[updateIndex]]))).toBe(
      normalizeSeparators(expectedUpdate),
    );
    expect((runtime as any).pendingMemoryUpdate).toBeUndefined();

    await runtime.executeTurn("again");
    // memory_update 是输入附件，写入历史后留在前缀里，不再重复产出。
    expect(mainRequestTexts[2]?.match(/Background memory consolidation updated/g)).toHaveLength(1);
    expect(dreamTurn).toBe(2);
  });

  it("keeps a memory update for the next request when persisting it fails", async () => {
    const sessionStore = createMemorySessionStore([]);
    const savePart = sessionStore.savePart!.bind(sessionStore);
    let failMemoryUpdateWrite = true;
    sessionStore.savePart = async (part) => {
      const isMemoryUpdate = JSON.stringify(part.metadata ?? {}).includes('"memory_update"');
      if (failMemoryUpdateWrite && isMemoryUpdate) {
        failMemoryUpdateWrite = false;
        throw new Error("injected memory_update write failure");
      }
      await savePart(part);
    };
    const requestTexts: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("memory-update-persist-failure"),
      { mode: "yolo", workingDirectory: WORKSPACE_PATH },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requestTexts.push(providerMessagesToText(request.messages));
            return textResult(observation.model, "ok");
          },
        }),
        now: () => new Date(NOW),
        sessionStore,
        toolRegistry: createToolRegistry(),
      },
    );
    (runtime as any).pendingMemoryUpdate = {
      inContextPaths: [],
      paths: ["/memory/fact.md"],
      source: "dream",
      summary: "Updated fact",
    };

    await runtime.executeTurn("first").catch(() => undefined);
    // 写库失败的轮次不发请求；这条一次性更新留到下一次收集。
    expect(requestTexts).toHaveLength(0);
    await runtime.executeTurn("second");
    expect(requestTexts.at(-1)).toContain(
      "Background memory consolidation updated your memory directory: Updated fact",
    );
    expect((runtime as any).pendingMemoryUpdate).toBeUndefined();
  });

  it("requires five transcript files newer than the last consolidation", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const pastSessions = Array.from({ length: 5 }, (_, index) =>
      session(`gate-${index + 1}`, NOW - index),
    );
    const fileSystemPort = new MemoryFileSystem(
      Object.fromEntries(
        pastSessions
          .slice(0, 2)
          .map((pastSession) => [join(modelIoDir, `model-io-${pastSession.id}.jsonl`), "{}\n"]),
      ),
      Object.fromEntries(
        pastSessions
          .slice(0, 2)
          .map((pastSession) => [join(modelIoDir, `model-io-${pastSession.id}.jsonl`), NOW]),
      ),
    );
    let dreamRequests = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("dream-gate"),
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            dreamRequests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );

    await runProjectMemoryDream(runtime as never, {
      traceContext: createRootTraceContext({
        sessionId: createSessionId("dream-gate"),
        turnId: createTurnId("dream-gate-check"),
      }),
    });

    expect(dreamRequests).toBe(0);
  });
});

describe("manual Dream trigger", () => {
  it("force skips the cooldown and transcript-count gates and reports per-file changes", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const factPath = join(memoryRoot, "release-tagging-policy.md");
    const indexPath = join(memoryRoot, "MEMORY.md");
    const sessionId = createSessionId("manual-dream");
    // 冷却窗口内（lock mtime = NOW-1s）但无 owner pid：非 force 会被 24h 闸门跳过，
    // force 必须照常执行。
    await mkdir(memoryRoot, { recursive: true });
    const lockPath = join(memoryRoot, ".consolidate-lock");
    await writeFile(lockPath, "", "utf8");
    await utimes(lockPath, new Date(NOW - 1_000), new Date(NOW - 1_000));
    const transcriptPath = join(modelIoDir, `model-io-${sessionId}.jsonl`);
    const fileSystemPort = new SeparatorAgnosticMemoryFileSystem(
      { [transcriptPath]: "{}\n" },
      { [transcriptPath]: NOW },
    );
    let dreamTurn = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        modelSelection: {
          modelId: createModelId("claude-opus-4-8-cc"),
          providerId: createModelProviderId("anthropic"),
        },
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: true },
          async generateText(_request, observation) {
            dreamTurn += 1;
            if (dreamTurn === 1) {
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "write-fact",
                    name: "Write",
                    input: { file_path: factPath, content: "fact\n" },
                  },
                  {
                    id: "write-index",
                    name: "Write",
                    input: {
                      file_path: indexPath,
                      content: "- [Fact](release-tagging-policy.md)\n",
                    },
                  },
                ],
              };
            }
            return textResult(observation.model, "Dream consolidated");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        // 只有当前会话本身：非 force 会被「≥5 条新 transcript」闸门挡掉。
        sessionStore: createMemorySessionStore([session("manual-dream", NOW)]),
        toolRegistry: createToolRegistry(),
      },
    );

    const result = await runProjectMemoryDream(runtime as never, {
      force: true,
      traceContext: createRootTraceContext({
        sessionId,
        turnId: createTurnId("manual-dream-check"),
      }),
    });

    expect(dreamTurn).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Dream consolidated");
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(fileSystemPort.files[indexPath]).toBe("- [Fact](release-tagging-policy.md)\n");
    expect(result.touchedPaths.map((path) => path.replaceAll("\\", "/"))).toContain(
      factPath.replaceAll("\\", "/"),
    );
    // diffMemorySnapshots 按路径排序：MEMORY.md 在 release-tagging-policy.md 之前。
    expect(result.changes).toEqual([
      { path: indexPath, addedLines: 1, removedLines: 0 },
      { path: factPath, addedLines: 1, removedLines: 0 },
    ]);
    expect(fileSystemPort.files[factPath]).toBe("fact\n");
  });

  it("keeps the dream lock: a fresh lock held by a live process yields already_running", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const sessionId = createSessionId("manual-dream-locked");
    const lockPath = join(memoryRoot, ".consolidate-lock");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(lockPath, String(process.pid), "utf8");
    // 锁仍鲜（<1h）且 pid 存活 → 任何触发都不得越过；transcript 比锁更新才走到取锁这一步。
    const lockMtime = new Date(Date.now() - 5_000);
    await utimes(lockPath, lockMtime, lockMtime);
    const transcriptPath = join(modelIoDir, `model-io-${sessionId}.jsonl`);
    let dreamRequests = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort: new MemoryFileSystem(
          { [transcriptPath]: "{}\n" },
          { [transcriptPath]: Date.now() },
        ),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            dreamRequests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir,
        sessionStore: createMemorySessionStore([session("manual-dream-locked", Date.now())]),
        toolRegistry: createToolRegistry(),
      },
    );

    const result = await runProjectMemoryDream(runtime as never, {
      force: true,
      traceContext: createRootTraceContext({
        sessionId,
        turnId: createTurnId("manual-dream-locked-check"),
      }),
    });

    expect(result).toEqual({
      status: "already_running",
      reason: "dream_lock_held",
      touchedPaths: [],
      changes: [],
    });
    expect(dreamRequests).toBe(0);
  });

  it("returns busy instead of racing a pending background Extraction", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const sessionId = createSessionId("manual-dream-busy");
    let dreamRequests = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort: new MemoryFileSystem({}),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            dreamRequests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir: join(cliStorageRoot, "rollout"),
        sessionStore: createMemorySessionStore([session("manual-dream-busy", NOW)]),
        toolRegistry: createToolRegistry(),
      },
    );
    (runtime as any).memoryExtractionScheduler = {
      hasPendingWork: () => true,
      shutdown: () => {},
    };

    const result = await runProjectMemoryDream(runtime as never, {
      force: true,
      traceContext: createRootTraceContext({
        sessionId,
        turnId: createTurnId("manual-dream-busy-check"),
      }),
    });

    expect(result).toEqual({
      status: "busy",
      reason: "extraction_pending",
      touchedPaths: [],
      changes: [],
    });
    expect(dreamRequests).toBe(0);
  });

  it("returns disabled without touching the model when project memory is off", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const sessionId = createSessionId("manual-dream-disabled");
    let requests = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        memory: { cliStorageRoot, enabled: false, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort: new MemoryFileSystem({}),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir: join(cliStorageRoot, "rollout"),
        sessionStore: createMemorySessionStore([session("manual-dream-disabled", NOW)]),
        toolRegistry: createToolRegistry(),
      },
    );

    const result = await runProjectMemoryDream(runtime as never, {
      force: true,
      traceContext: createRootTraceContext({
        sessionId,
        turnId: createTurnId("manual-dream-disabled-check"),
      }),
    });

    expect(result).toEqual({
      status: "disabled",
      reason: "memory_disabled",
      touchedPaths: [],
      changes: [],
    });
    expect(requests).toBe(0);
  });
});

describe("diffMemorySnapshots", () => {
  it("counts added, removed and modified files line by line", () => {
    const changes = diffMemorySnapshots(
      new Map([
        ["/m/gone.md", "old\n"],
        ["/m/same.md", "same\n"],
        ["/m/edited.md", "a\nb\nc\n"],
      ]),
      new Map([
        ["/m/new.md", "fresh\n"],
        ["/m/same.md", "same\n"],
        ["/m/edited.md", "a\nB\nc\n"],
      ]),
    );

    expect(changes).toEqual([
      { path: "/m/edited.md", addedLines: 1, removedLines: 1 },
      { path: "/m/gone.md", addedLines: 0, removedLines: 1 },
      { path: "/m/new.md", addedLines: 1, removedLines: 0 },
    ]);
  });
});

/**
 * MemoryFileSystem 的 listDirectory 用字符串前缀判断目录，Windows 上 `\` 与 `/` 混用会
 * 让 Dream 的前后快照都扫不到文件（changes 永远为空）。这里两种分隔符都认，条目路径仍按
 * 真实分隔符返回，保证后续 readTextFile 与写入 key 对得上。
 */
class SeparatorAgnosticMemoryFileSystem extends MemoryFileSystem {
  override async listDirectory(request: { path: string }) {
    const root = toPosixPath(request.path);
    const prefix = `${root}/`;
    const seen = new Set<string>();
    const entries = Object.keys(this.files).flatMap((path) => {
      const normalized = toPosixPath(path);
      if (!normalized.startsWith(prefix)) return [];
      const rest = normalized.slice(prefix.length);
      const [name] = rest.split("/");
      if (!name || seen.has(name)) return [];
      seen.add(name);
      return [
        {
          kind: rest.includes("/") ? ("directory" as const) : ("file" as const),
          name,
          path: join(request.path, name),
        },
      ];
    });
    return { durationMs: 0, entries, numEntries: entries.length, path: request.path };
  }
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function session(
  id: string,
  updated: number,
  options: Partial<Pick<SessionInfo, "directory" | "taskType" | "workspaceID">> = {},
): SessionInfo {
  return {
    id: id.startsWith("sess_") ? createSessionId(id) : createSessionId(id),
    directory: options.directory ?? WORKSPACE_PATH,
    projectID: createProjectId("project"),
    slug: id,
    taskType: options.taskType ?? "interactive",
    time: { created: updated, updated },
    title: id,
    version: "test",
    workspaceID: options.workspaceID,
  };
}

function createMemorySessionStore(seedSessions: SessionInfo[]): SessionStorePort {
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  let currentSession: SessionInfo | null = null;
  return {
    async createSession(input) {
      currentSession = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: NOW, updated: NOW },
      };
      return currentSession;
    },
    // 终态结果由 CLI 存储维护；夹具也须更新同一条会话记录。
    async updateSession(input) {
      if (!currentSession || currentSession.id !== input.id) throw new Error("Session not found");
      currentSession = {
        ...currentSession,
        ...input,
        time: { ...currentSession.time, ...input.time },
      };
      return currentSession;
    },
    async getProjectPermission() {
      return null;
    },
    async getSession() {
      return currentSession;
    },
    async listSessions() {
      return currentSession ? [currentSession, ...seedSessions] : [...seedSessions];
    },
    async messages(input): Promise<MessageWithParts[]> {
      return [...messages.values()]
        .filter((message) => message.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: [...parts.values()].filter((part) => part.messageID === info.id),
        }));
    },
    async readTarget() {
      return null;
    },
    async readTodos() {
      return [];
    },
    async saveMessage(input) {
      messages.set(input.id, input);
    },
    async savePart(input) {
      parts.set(input.id, input);
    },
  } as SessionStorePort;
}

function textResult(model: ModelSelection, text: string): ModelResult {
  return {
    finishReason: "stop",
    model,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function providerMessagesToText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return "";
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
    })
    .join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for auto Dream state");
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zcode-runtime-memory-dream-"));
  temporaryDirectories.push(path);
  return path;
}
