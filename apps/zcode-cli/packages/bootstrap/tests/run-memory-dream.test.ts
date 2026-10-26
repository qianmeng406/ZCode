// fork 定制功能：会话内手动整理记忆（session/runMemoryDream）的服务端门禁。
// Dream 的真实执行语义（force 闸门、锁、快照 diff）由 core 的
// runtime-memory-dream.test.ts 覆盖；这里只钉住 bootstrap 的三件事：
// 开关关闭不碰 runtime、记忆关闭不碰 runtime、打开时以 force 转发且原样返回结果。
import { DEFAULT_FORK_FEATURES } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";

// 模型可用性检查需要完整 app（模型目录/默认模型解析）；本文件只验证门禁，
// 直接让它返回“未补齐默认模型”，不触发 stateRevision 与运行时重启。
vi.mock("../src/zcode-protocol/workspace-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionModelAvailable: vi.fn(async () => false) };
});

import { runMemoryDreamForSession } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "sess_dream";

function createContext(
  options: {
    memoryDreamManual?: boolean;
    memoryEnabled?: boolean;
    /** false = 模拟冷启动后 Host 还没推过进程级偏好。 */
    pushedFromHost?: boolean;
    sessionMemoryDreamManual?: boolean;
  } = {},
) {
  const runMemoryDream = vi.fn(async () => ({
    status: "completed" as const,
    summary: "consolidated",
    turns: 2,
    touchedPaths: ["/memory/fact.md"],
    changes: [{ path: "/memory/fact.md", addedLines: 3, removedLines: 1 }],
  }));
  const context = {
    appRuntimePreferences: {
      ...(options.pushedFromHost === false
        ? {}
        : {
            forkFeatures: options.memoryDreamManual === false ? {} : { memoryDreamManual: true },
          }),
    },
    sessions: new Map([
      [
        SESSION_ID,
        {
          app: {
            runtime: {
              isProjectMemoryEnabled: () => options.memoryEnabled !== false,
              runMemoryDream,
            },
          },
          workspace: { workspacePath: "/workspace/app" },
          persistence: "immediate",
          stateRevision: 0,
          // 会话级解析结果：Host 没推送进程级缓存时门禁回退读它。
          forkFeatures: {
            ...DEFAULT_FORK_FEATURES,
            memoryDreamManual: options.sessionMemoryDreamManual === true,
          },
        },
      ],
    ]),
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, runMemoryDream };
}

describe("session/runMemoryDream", () => {
  it("returns disabled without touching the runtime when the fork switch is off", async () => {
    const { context, runMemoryDream } = createContext({ memoryDreamManual: false });

    await expect(runMemoryDreamForSession(context, { sessionId: SESSION_ID })).resolves.toEqual({
      status: "disabled",
      reason: "fork_feature_disabled",
      touchedPaths: [],
      changes: [],
    });
    expect(runMemoryDream).not.toHaveBeenCalled();
  });

  it("returns disabled when project memory is off", async () => {
    const { context, runMemoryDream } = createContext({ memoryEnabled: false });

    await expect(runMemoryDreamForSession(context, { sessionId: SESSION_ID })).resolves.toEqual({
      status: "disabled",
      reason: "memory_disabled",
      touchedPaths: [],
      changes: [],
    });
    expect(runMemoryDream).not.toHaveBeenCalled();
  });

  it("forwards force:true and returns the runtime result verbatim", async () => {
    const { context, runMemoryDream } = createContext();

    await expect(
      runMemoryDreamForSession(context, { sessionId: SESSION_ID, operationId: "op-1" }),
    ).resolves.toEqual({
      status: "completed",
      summary: "consolidated",
      turns: 2,
      touchedPaths: ["/memory/fact.md"],
      changes: [{ path: "/memory/fact.md", addedLines: 3, removedLines: 1 }],
    });
    expect(runMemoryDream).toHaveBeenCalledWith({ force: true });
  });

  it("rejects unknown sessions instead of silently succeeding", async () => {
    const { context, runMemoryDream } = createContext();

    await expect(
      runMemoryDreamForSession(context, { sessionId: "sess_missing" }),
    ).rejects.toThrow();
    expect(runMemoryDream).not.toHaveBeenCalled();
  });

  it("falls back to the session-level switch before the Host pushes preferences", async () => {
    const { context, runMemoryDream } = createContext({
      pushedFromHost: false,
      sessionMemoryDreamManual: true,
    });

    await expect(
      runMemoryDreamForSession(context, { sessionId: SESSION_ID }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(runMemoryDream).toHaveBeenCalledWith({ force: true });
  });
});
