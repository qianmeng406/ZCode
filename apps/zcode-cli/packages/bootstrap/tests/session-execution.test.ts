import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  assertExecutionEnvironmentSwitchIdle,
  handleSessionExecutionOperation,
} from "../src/zcode-protocol/session-execution.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ProtocolRequestError } from "../src/zcode-protocol/server-types.js";

function createContext(
  requestClient: ReturnType<typeof vi.fn>,
  options: {
    sessionId?: string;
    busyTurn?: boolean;
    pendingInteraction?: boolean;
    runningBackground?: boolean;
    sessionEntries?: Array<{ id: string; data: unknown }>;
    sessionExecutionPortBinding?: {
      activateWsl: ReturnType<typeof vi.fn>;
      activateLocal: ReturnType<typeof vi.fn>;
    };
  } = {},
): ZCodeProtocolAgentServerContext {
  const sessionId = options.sessionId ?? "sess-1";
  const workspacePath = "C:\\repo";
  return {
    requestClient,
    v4Interactions: {
      hasPendingForSession: vi.fn(() => options.pendingInteraction ?? false),
    },
    sessions: new Map([
      [
        sessionId,
        {
          workspace: { workspaceKey: workspacePath, workspacePath },
          app: {
            runtime: {
              hasActiveOrQueuedTurnWork: vi.fn(() => options.busyTurn ?? false),
              hasRunningBackgroundTasks: vi.fn(() => options.runningBackground ?? false),
              notifySessionExecutionEnvironmentChanged: vi.fn(),
            },
            ...(options.sessionExecutionPortBinding
              ? { sessionExecutionPortBinding: options.sessionExecutionPortBinding }
              : {}),
          },
        },
      ],
    ]),
    deps: {
      sessionStore: {
        sessionEntries: vi.fn(async () => options.sessionEntries ?? []),
        saveSessionEntry: vi.fn(async () => undefined),
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("session-execution 控制面", () => {
  it("get 未配置时投影 idle/local", async () => {
    const context = createContext(vi.fn());
    const result = await handleSessionExecutionOperation(context, {
      operation: "getExecutionEnvironment",
      sessionId: "sess-1",
    });
    expect(result).toMatchObject({
      ok: true,
      operation: "getExecutionEnvironment",
      state: { status: "idle", environment: { kind: "local" } },
    });
  });

  it("get 从 session entry 恢复 wsl 配置", async () => {
    const context = createContext(vi.fn(), {
      sessionEntries: [
        {
          id: "sess-1:runtime:execution_environment",
          data: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
        },
      ],
    });
    const result = await handleSessionExecutionOperation(context, {
      operation: "getExecutionEnvironment",
      sessionId: "sess-1",
    });
    expect(result).toMatchObject({
      ok: true,
      state: {
        status: "idle",
        environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      },
    });
  });

  it("busy turn/阻塞交互/后台执行均拒绝切换且不发起 prepare", async () => {
    for (const flag of [
      { busyTurn: true },
      { pendingInteraction: true },
      { runningBackground: true },
    ]) {
      const requestClient = vi.fn();
      const context = createContext(requestClient, flag);
      await expect(
        handleSessionExecutionOperation(context, {
          operation: "setExecutionEnvironment",
          sessionId: "sess-1",
          environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
        }),
      ).rejects.toThrow(ProtocolRequestError);
      expect(requestClient).not.toHaveBeenCalled();
    }
  });

  it("set 切换 prepare 成功后提交配置并释放旧环境 lease", async () => {
    const requestClient = vi.fn(async (_method: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return {
          ok: true,
          operation: "prepare",
          prepare: {
            ok: true,
            lease: { leaseId: "lease-2", generation: 1 },
            resolvedCwd: "/mnt/c/repo",
            capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
          },
        };
      }
      return { ok: true, operation: "releaseSession", releasedLeases: 1 };
    });
    const context = createContext(requestClient, {
      sessionEntries: [{ id: "old", data: { kind: "wsl", distro: "Old", user: "me" } }],
    });
    const result = await handleSessionExecutionOperation(context, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
    });
    expect(result).toMatchObject({
      ok: true,
      operation: "setExecutionEnvironment",
      state: { status: "idle", environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" } },
    });
    const ops = requestClient.mock.calls.map(
      (c: unknown[]) => (c[1] as { operation: string }).operation,
    );
    expect(ops[0]).toBe("prepare");
    // 旧 lease 的释放归绑定（按 lease 身份释放，避免误删刚 prepare 的会话 lease）；
    // 未注入绑定时 CLI 不再发行会话级 releaseSession（那会把新 lease 一起删掉）。
    expect(ops).not.toContain("releaseSession");
    const save = (context.deps as { sessionStore: { saveSessionEntry: ReturnType<typeof vi.fn> } })
      .sessionStore.saveSessionEntry;
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      type: "runtime/execution_environment",
      touchSession: false,
      data: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
    });
  });

  it("set 提交后切换本会话借用端口（不重建 App）——WSL 激活 / 本地释放", async () => {
    // 本地→WSL：prepare 成功后绑定 activateWsl，lease/capabilities/distro 如实透传。
    const requestClient = vi.fn(async (_m: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return {
          ok: true,
          operation: "prepare",
          prepare: {
            ok: true,
            lease: { leaseId: "lease-w", generation: 2 },
            resolvedCwd: "/mnt/c/repo",
            capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
          },
        };
      }
      return { ok: true, operation: params.operation, releasedLeases: 1 };
    });
    const binding = { activateWsl: vi.fn(), activateLocal: vi.fn(async () => undefined) };
    const context = createContext(requestClient, { sessionExecutionPortBinding: binding });
    const result = await handleSessionExecutionOperation(context, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "wsl", distro: "Ubuntu-24.04", user: "me" },
    });
    expect(result).toMatchObject({ ok: true, operation: "setExecutionEnvironment" });
    expect(binding.activateWsl).toHaveBeenCalledWith({
      lease: { leaseId: "lease-w", generation: 2 },
      capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      distro: "Ubuntu-24.04",
      user: "me",
    });
    expect(binding.activateLocal).not.toHaveBeenCalled();
    // 提交后立刻让 runtime 重建 context prefix：提示词路由段无需等冷启动。
    const runtime = (
      context.sessions.get("sess-1") as unknown as {
        app: { runtime: { notifySessionExecutionEnvironmentChanged: ReturnType<typeof vi.fn> } };
      }
    ).app.runtime;
    expect(runtime.notifySessionExecutionEnvironmentChanged).toHaveBeenCalledTimes(1);

    // WSL→本地：无 prepare，绑定 activateLocal（释放借用 lease），保留原会话。
    const requestClient2 = vi.fn(async (_m: string, params: { operation: string }) => ({
      ok: true,
      operation: params.operation,
      releasedLeases: 1,
    }));
    const binding2 = { activateWsl: vi.fn(), activateLocal: vi.fn(async () => undefined) };
    const context2 = createContext(requestClient2, {
      sessionExecutionPortBinding: binding2,
      sessionEntries: [{ id: "old", data: { kind: "wsl", distro: "Ubuntu-24.04", user: "me" } }],
    });
    await handleSessionExecutionOperation(context2, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "local" },
    });
    expect(binding2.activateWsl).not.toHaveBeenCalled();
    expect(binding2.activateLocal).toHaveBeenCalledTimes(1);
    const runtime2 = (
      context2.sessions.get("sess-1") as unknown as {
        app: { runtime: { notifySessionExecutionEnvironmentChanged: ReturnType<typeof vi.fn> } };
      }
    ).app.runtime;
    expect(runtime2.notifySessionExecutionEnvironmentChanged).toHaveBeenCalledTimes(1);
  });

  it("取消后迟到的 prepare 成功不提交配置（spec「准备取消不提交」）", async () => {
    let resolvePrepare: (value: unknown) => void = () => undefined;
    const requestClient = vi.fn((_method: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return new Promise((resolve) => {
          resolvePrepare = resolve;
        });
      }
      return Promise.resolve({ ok: true, operation: params.operation, releasedLeases: 0 });
    });
    const cancelBinding = {
      activateWsl: vi.fn(),
      activateLocal: vi.fn(async () => undefined),
    };
    const context = createContext(requestClient, {
      sessionExecutionPortBinding: cancelBinding,
    });
    const pending = handleSessionExecutionOperation(context, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "wsl", distro: "Ubuntu-24.04", user: "me" },
    });
    // 准备在途时取消（新 operation 走 transport 旁路，可立即到达）
    const cancelled = await handleSessionExecutionOperation(context, {
      operation: "cancelExecutionEnvironmentPreparation",
      sessionId: "sess-1",
    });
    expect(cancelled).toMatchObject({
      ok: true,
      operation: "cancelExecutionEnvironmentPreparation",
    });
    // 迟到的 prepare 成功：被取消的 set 必须拒绝且不落库
    resolvePrepare({
      ok: true,
      operation: "prepare",
      prepare: {
        ok: true,
        lease: { leaseId: "l1", generation: 0 },
        resolvedCwd: "/mnt/c/repo",
        capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      },
    });
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("cancelled"),
    });
    const save = (context.deps as { sessionStore: { saveSessionEntry: ReturnType<typeof vi.fn> } })
      .sessionStore.saveSessionEntry;
    expect(save).not.toHaveBeenCalled();
    // 取消不提交：绑定不切换、提示词也不重建，保持切换前状态。
    expect(cancelBinding.activateWsl).not.toHaveBeenCalled();
    expect(cancelBinding.activateLocal).not.toHaveBeenCalled();
    const cancelRuntime = (
      context.sessions.get("sess-1") as unknown as {
        app: { runtime: { notifySessionExecutionEnvironmentChanged: ReturnType<typeof vi.fn> } };
      }
    ).app.runtime;
    expect(cancelRuntime.notifySessionExecutionEnvironmentChanged).not.toHaveBeenCalled();
    // 迟到的 lease 被回收（release 操作转发到 Host）
    const ops = requestClient.mock.calls.map(
      (c: unknown[]) => (c[1] as { operation: string }).operation,
    );
    expect(ops).toContain("release");
  });

  it("prepare 失败不提交配置并回收已分配 lease", async () => {
    const requestClient = vi.fn(async (_m: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return { ok: false, code: "environment_unavailable", message: "wsl not ready" };
      }
      return { ok: true, operation: "release", releasedLeases: 1 };
    });
    const failedBinding = {
      activateWsl: vi.fn(),
      activateLocal: vi.fn(async () => undefined),
    };
    const context = createContext(requestClient, {
      sessionExecutionPortBinding: failedBinding,
    });
    await expect(
      handleSessionExecutionOperation(context, {
        operation: "setExecutionEnvironment",
        sessionId: "sess-1",
        environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      }),
    ).rejects.toThrow(ProtocolRequestError);
    const save = (context.deps as { sessionStore: { saveSessionEntry: ReturnType<typeof vi.fn> } })
      .sessionStore.saveSessionEntry;
    expect(save).not.toHaveBeenCalled();
    // prepare 失败：不切绑定、不重建提示词，保持原环境。
    expect(failedBinding.activateWsl).not.toHaveBeenCalled();
    expect(failedBinding.activateLocal).not.toHaveBeenCalled();
    const failedRuntime = (
      context.sessions.get("sess-1") as unknown as {
        app: { runtime: { notifySessionExecutionEnvironmentChanged: ReturnType<typeof vi.fn> } };
      }
    ).app.runtime;
    expect(failedRuntime.notifySessionExecutionEnvironmentChanged).not.toHaveBeenCalled();
    const ops = requestClient.mock.calls.map(
      (c: unknown[]) => (c[1] as { operation: string }).operation,
    );
    expect(ops).not.toContain("releaseSession");
  });

  it("prepare 失败的 rejection message 携带底层 code 与 message（可诊断性）", async () => {
    const requestClient = vi.fn(async (_m: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return { ok: false, code: "environment_unavailable", message: "wsl distro not ready" };
      }
      return { ok: true, operation: "release", releasedLeases: 1 };
    });
    const context = createContext(requestClient);
    await expect(
      handleSessionExecutionOperation(context, {
        operation: "setExecutionEnvironment",
        sessionId: "sess-1",
        environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "execution environment preparation failed: environment_unavailable wsl distro not ready",
      ),
    });
  });

  it("执行面操作原样转 Host（严格 split，控制面不落 Host）", async () => {
    const requestClient = vi.fn(async () => ({
      ok: true,
      operation: "poll",
      poll: { events: [], nextCursor: 0 },
    }));
    const context = createContext(requestClient);
    await handleSessionExecutionOperation(context, {
      operation: "poll",
      sessionId: "sess-1",
      lease: { leaseId: "l1", generation: 0 },
      executionId: "e1",
      cursor: 0,
    });
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.interactionSessionExecution,
      expect.objectContaining({ operation: "poll", sessionId: "sess-1" }),
      expect.anything(),
    );
  });

  it("cancel 通知 Host 中止在途 prepare（真中断）且仍以本地 state 返回", async () => {
    const requestClient = vi.fn(async (_m: string, params: { operation: string }) => ({
      ok: true,
      operation: params.operation,
      state: { status: "idle", environment: { kind: "local" } },
    }));
    const context = createContext(requestClient);
    const result = await handleSessionExecutionOperation(context, {
      operation: "cancelExecutionEnvironmentPreparation",
      sessionId: "sess-1",
    });
    // state 权威投影在 CLI；Host 只负责中止，两者一致回 idle/local。
    expect(result).toMatchObject({
      ok: true,
      operation: "cancelExecutionEnvironmentPreparation",
      state: { status: "idle", environment: { kind: "local" } },
    });
    expect(requestClient).toHaveBeenCalledWith(
      zcodeProtocolMethods.interactionSessionExecution,
      { operation: "cancelExecutionEnvironmentPreparation", sessionId: "sess-1" },
      expect.anything(),
    );
  });
});

describe("assertExecutionEnvironmentSwitchIdle", () => {
  it("空闲会话不抛", () => {
    const context = createContext(vi.fn());
    expect(() => assertExecutionEnvironmentSwitchIdle(context, "sess-1")).not.toThrow();
  });
});

describe("切换 admission 锁（record 级 in-flight）", () => {
  it("prepare 进行中拒绝第二个 set，完成后恢复", async () => {
    let resolvePrepare: (value: unknown) => void = () => undefined;
    const requestClient = vi.fn(
      (_method: string, params: { operation: string }) =>
        new Promise((resolve) => {
          if (params.operation === "prepare") {
            resolvePrepare = (value) => resolve(value);
          } else {
            resolve({ ok: true, operation: params.operation, releasedLeases: 0 });
          }
        }),
    );
    const context = createContext(requestClient);
    const pending = handleSessionExecutionOperation(context, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
    });
    // 第一个 set 卡在 prepare；此时第二个 set 必须被拒绝且不发 prepare
    await expect(
      handleSessionExecutionOperation(context, {
        operation: "setExecutionEnvironment",
        sessionId: "sess-1",
        environment: { kind: "wsl", distro: "Other", user: "me" },
      }),
    ).rejects.toThrow(ProtocolRequestError);
    const prepareCalls = requestClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { operation: string }).operation === "prepare",
    );
    expect(prepareCalls).toHaveLength(1);

    // 放行第一个 prepare，切换完成
    resolvePrepare({
      ok: true,
      operation: "prepare",
      prepare: {
        ok: true,
        lease: { leaseId: "l1", generation: 0 },
        resolvedCwd: "/mnt/c/repo",
        capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      },
    });
    const result = await pending;
    expect(result).toMatchObject({ ok: true, operation: "setExecutionEnvironment" });

    // 完成后锁已释放：新的 set 可重新走 admission（busy 之前通过，说明锁不是永久卡死）
    const requestClient2 = vi.fn(async () => ({
      ok: true,
      operation: "prepare",
      prepare: {
        ok: true,
        lease: { leaseId: "l2", generation: 1 },
        resolvedCwd: "/mnt/c/repo",
        capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      },
    }));
    const context2 = createContext(requestClient2);
    const result2 = await handleSessionExecutionOperation(context2, {
      operation: "setExecutionEnvironment",
      sessionId: "sess-1",
      environment: { kind: "local" },
    });
    expect(result2).toMatchObject({ ok: true });
  });

  it("prepare 失败后锁释放（finally），下一切换可进行", async () => {
    const requestClient = vi.fn(async (_m: string, params: { operation: string }) => {
      if (params.operation === "prepare") {
        return { ok: false, code: "environment_unavailable", message: "wsl not ready" };
      }
      return { ok: true, operation: params.operation, releasedLeases: 0 };
    });
    const context = createContext(requestClient);
    await expect(
      handleSessionExecutionOperation(context, {
        operation: "setExecutionEnvironment",
        sessionId: "sess-1",
        environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      }),
    ).rejects.toThrow(ProtocolRequestError);

    // 失败后锁必须已释放：再次 set 会再次走到 prepare（否则会抛 in-flight 拒绝）
    const prepareCount = requestClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { operation: string }).operation === "prepare",
    ).length;
    await expect(
      handleSessionExecutionOperation(context, {
        operation: "setExecutionEnvironment",
        sessionId: "sess-1",
        environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      }),
    ).rejects.toThrow(ProtocolRequestError);
    const prepareCountAfter = requestClient.mock.calls.filter(
      (c: unknown[]) => (c[1] as { operation: string }).operation === "prepare",
    ).length;
    // 第二次也走到了 prepare（锁没有卡死）才失败
    expect(prepareCountAfter).toBe(prepareCount + 1);
  });
});
