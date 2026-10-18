import { describe, expect, it, vi } from "vitest";
import type { ZCodeSessionExecutionParams, ZCodeSessionExecutionResult } from "@zcode/shared";
import {
  createSessionLinuxExecutionManager,
  type SessionExecutionWorkspace,
  type SessionLinuxManagerConnect,
} from "../src/host/sessionLinuxExecutionManager.js";

const WORKSPACE: SessionExecutionWorkspace = {
  workspaceKey: "ws-1",
  workspacePath: "C:\\proj",
};

function fakeConnection(overrides?: {
  call?: (command: string, args: unknown) => Promise<unknown>;
  onChannelCall?: (command: string, args: unknown) => void;
  disposeAndWait?: () => Promise<void>;
}) {
  const channels = new Map<
    string,
    { call: (command: string, args: unknown) => Promise<unknown> }
  >();
  channels.set("session-linux-execution", {
    call: async (command: string, args: unknown) => {
      overrides?.onChannelCall?.(command, args);
      if (overrides?.call) {
        return overrides.call(command, args);
      }
      if (command === "prepare") {
        return {
          ok: true,
          operation: "prepare",
          prepare: {
            ok: true,
            lease: { leaseId: "lease-1", generation: 0 },
            resolvedCwd: "/mnt/c/proj",
            capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
          },
        };
      }
      if (command === "run") {
        return {
          ok: true,
          operation: "run",
          result: {
            status: "completed",
            stdout: { text: "hi", bytes: 2, truncated: false },
            stderr: { text: "", bytes: 0, truncated: false },
            durationMs: 1,
            timedOut: false,
            cancelled: false,
            startedAtMs: 1,
            completedAtMs: 2,
          },
        };
      }
      return { ok: true, operation: command };
    },
  });
  return {
    client: {
      getChannel: (name: string) => {
        const channel = channels.get(name);
        if (!channel) throw new Error(`unknown channel ${name}`);
        return channel;
      },
    },
    dispose: vi.fn(),
    disposeAndWait: overrides?.disposeAndWait ?? vi.fn(async () => undefined),
  };
}

function prepareParams(
  overrides?: Partial<Extract<ZCodeSessionExecutionParams, { operation: "prepare" }>>,
): ZCodeSessionExecutionParams {
  return {
    operation: "prepare",
    sessionId: "s1",
    environment: { kind: "wsl", distro: "Ubuntu-24.04", user: "me" },
    workspacePath: "C:\\proj",
    ...overrides,
  } as ZCodeSessionExecutionParams;
}

function createConnectSpy(connection = fakeConnection()) {
  const connect = vi.fn(async () => connection) as unknown as SessionLinuxManagerConnect & {
    mock: { calls: Array<[unknown, unknown]> };
  };
  return { connect, connection };
}

describe("sessionLinuxExecutionManager", () => {
  it("prepare connects via deps.connect, caches lease and returns channel result", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    const result = await manager.execute(prepareParams(), WORKSPACE);
    expect(result.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    const [target, options] = connect.mock.calls[0] as unknown as [
      { kind: string; distro: string; user?: string },
      { signal?: AbortSignal; onClose?: () => void; onProgress?: (p: string) => void },
    ];
    expect(target).toEqual({ kind: "wsl", distro: "Ubuntu-24.04", user: "me" });
    expect(typeof options.onClose).toBe("function");
    await manager.disposeAndWait();
  });

  it("execute reuses the pooled connection without re-connecting", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    const run = await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(run.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    await manager.disposeAndWait();
  });

  it("run/start/poll/cancel inject sessionId+lease and route by lease targetKey", async () => {
    const seen: Array<{ command: string; args: Record<string, unknown> }> = [];
    const { connect } = createConnectSpy(
      fakeConnection({
        onChannelCall: (command, args) => {
          if (command !== "prepare") {
            seen.push({ command, args: args as Record<string, unknown> });
          }
        },
      }),
    );
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "stale", generation: 99 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe("run");
    // manager 注入其记录的 lease，而非调用方伪造值
    expect(seen[0].args.lease).toEqual({ leaseId: "lease-1", generation: 0 });
    expect(seen[0].args.sessionId).toBe("s1");
    await manager.disposeAndWait();
  });

  it("returns lease_rejected for non-prepare operations without an active lease", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    const result = await manager.execute(
      {
        operation: "poll",
        sessionId: "no-lease",
        lease: { leaseId: "x", generation: 0 },
        executionId: "e",
        cursor: 0,
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(result).toMatchObject({ ok: false, code: "lease_rejected" });
    expect(connect).not.toHaveBeenCalled();
    await manager.disposeAndWait();
  });

  it("returns environment_unavailable when distro is missing (no silent fallback)", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    const result = await manager.execute(
      prepareParams({ environment: { kind: "wsl" } } as never),
      WORKSPACE,
    );
    expect(result).toMatchObject({ ok: false, code: "environment_unavailable" });
    expect(connect).not.toHaveBeenCalled();
    await manager.disposeAndWait();
  });

  it("maps connect failure to environment_unavailable with the message", async () => {
    const connect = vi.fn(async () => {
      throw new Error("Session Linux runtime assets unavailable");
    }) as unknown as SessionLinuxManagerConnect;
    const manager = createSessionLinuxExecutionManager({ connect });
    const result = await manager.execute(prepareParams(), WORKSPACE);
    expect(result).toMatchObject({
      ok: false,
      code: "environment_unavailable",
      message: "Session Linux runtime assets unavailable",
    });
    await manager.disposeAndWait();
  });

  it("onClose from connect settles leases: later operations fail with environment_unavailable", async () => {
    let triggerClose: (() => void) | undefined;
    const connect = vi.fn(async (_target, options: { onClose?: () => void }) => {
      triggerClose = options.onClose;
      return fakeConnection();
    }) as unknown as SessionLinuxManagerConnect;
    const manager = createSessionLinuxExecutionManager({ connect });
    const prepared = await manager.execute(prepareParams(), WORKSPACE);
    expect(prepared.ok).toBe(true);
    triggerClose?.();
    // onClose 结算：lease 失效。后续操作 fail-closed（lease_rejected），不静默重连或回落本地。
    const result = await manager.execute(
      {
        operation: "poll",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        cursor: 0,
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(result).toMatchObject({ ok: false, code: "lease_rejected" });
    await manager.disposeAndWait();
  });

  it("release clears the session lease; afterwards operations fail closed", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    const released = await manager.execute(
      {
        operation: "release",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(released).toMatchObject({ ok: true, operation: "release" });
    const after = await manager.execute(
      {
        operation: "poll",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e",
        cursor: 0,
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(after).toMatchObject({ ok: false, code: "lease_rejected" });
    await manager.disposeAndWait();
  });

  it("releasing a superseded lease keeps the freshly prepared session lease usable", async () => {
    // 真实实例回归：取消后被取消的 set 回收其旧 lease；若 release 顺手清掉会话槽，
    // 会把新 prepare 的 lease 一起删掉 → 之后所有执行 lease_rejected。
    let prepareCount = 0;
    const dispatched: Array<{ command: string; args: Record<string, unknown> }> = [];
    const connection = fakeConnection({
      onChannelCall: (command, args) =>
        dispatched.push({ command, args: args as Record<string, unknown> }),
      call: async (command) => {
        if (command === "prepare") {
          prepareCount += 1;
          return {
            ok: true,
            operation: "prepare",
            prepare: {
              ok: true,
              lease: { leaseId: `lease-${prepareCount}`, generation: prepareCount - 1 },
              resolvedCwd: "/mnt/c/proj",
              capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
            },
          };
        }
        if (command === "run") {
          return {
            ok: true,
            operation: "run",
            result: {
              status: "completed",
              stdout: { text: "hi", bytes: 2, truncated: false },
              stderr: { text: "", bytes: 0, truncated: false },
              durationMs: 1,
              timedOut: false,
              cancelled: false,
              startedAtMs: 1,
              completedAtMs: 2,
            },
          };
        }
        return { ok: true, operation: command };
      },
    });
    const { connect } = createConnectSpy(connection);
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE); // lease-1
    await manager.execute(prepareParams(), WORKSPACE); // lease-2 覆盖会话槽
    const released = await manager.execute(
      {
        operation: "release",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(released).toMatchObject({ ok: true, operation: "release" });
    // 转发出去的 release 必须携带请求里的旧 lease（而不是槽里的新 lease）。
    const releaseCall = dispatched.find((call) => call.command === "release");
    expect((releaseCall!.args.lease as { leaseId: string }).leaseId).toBe("lease-1");
    // 会话槽仍持有 lease-2：run 不能被拒。
    const runResult = await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as unknown as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(runResult).toMatchObject({ ok: true, operation: "run" });
    await manager.disposeAndWait();
  });

  it("connection failure during operation maps to environment_unavailable and drops the lease", async () => {
    let failNext = false;
    const { connect } = createConnectSpy(
      fakeConnection({
        call: async (command) => {
          if (failNext && command === "run") {
            throw new Error("connection closed");
          }
          if (command === "run") {
            return {
              ok: true,
              operation: "run",
              result: {
                status: "completed",
                stdout: { text: "", bytes: 0, truncated: false },
                stderr: { text: "", bytes: 0, truncated: false },
                durationMs: 1,
                timedOut: false,
                cancelled: false,
                startedAtMs: 1,
                completedAtMs: 2,
              },
            };
          }
          if (command === "prepare") {
            return {
              ok: true,
              operation: "prepare",
              prepare: {
                ok: true,
                lease: { leaseId: "lease-1", generation: 0 },
                resolvedCwd: "/mnt/c/proj",
                capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
              },
            };
          }
          return { ok: true, operation: command };
        },
      }),
    );
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    failNext = true;
    const failed = await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(failed).toMatchObject({ ok: false, code: "environment_unavailable" });
    await manager.disposeAndWait();
  });

  it("cancelled signal maps to code cancelled", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    const controller = new AbortController();
    controller.abort();
    const result = await manager.execute(prepareParams(), WORKSPACE, controller.signal);
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    await manager.disposeAndWait();
  });

  it("releaseSession forwards without lease injection, clears the lease and is idempotent", async () => {
    const onChannelCall = vi.fn();
    const { connect } = createConnectSpy(fakeConnection({ onChannelCall }));
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    const first = await manager.execute(
      { operation: "releaseSession", sessionId: "s1" } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(first).toMatchObject({ ok: true, operation: "releaseSession" });
    const forwarded = onChannelCall.mock.calls.filter(([command]) => command === "releaseSession");
    expect(forwarded).toHaveLength(1);
    // strict schema 只有 operation+sessionId：绝不注入 lease 字段
    expect(forwarded[0]![1]).toEqual({ operation: "releaseSession", sessionId: "s1" });
    // lease 已清：后续执行明确拒绝，不回落本地
    const run = await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(run).toMatchObject({ ok: false, code: "lease_rejected" });
    // 无 lease 的再次回收幂等成功（agent 退出清理路径）
    const second = await manager.execute(
      { operation: "releaseSession", sessionId: "s1" } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(second).toMatchObject({ ok: true, operation: "releaseSession" });
    expect(
      onChannelCall.mock.calls.filter(([command]) => command === "releaseSession"),
    ).toHaveLength(1);
    await manager.disposeAndWait();
  });

  it("cancelExecutionEnvironmentPreparation aborts an in-flight prepare and settles it as cancelled", async () => {
    const { connect } = createConnectSpy(
      fakeConnection({
        call: (command) => {
          if (command === "prepare") {
            return new Promise(() => undefined); // 永不结算：只能被取消打断
          }
          return { ok: true, operation: command };
        },
      }),
    );
    const manager = createSessionLinuxExecutionManager({ connect });
    const preparePromise = manager.execute(prepareParams(), WORKSPACE);
    await new Promise((r) => setTimeout(r, 0));
    const cancel = await manager.execute(
      {
        operation: "cancelExecutionEnvironmentPreparation",
        sessionId: "s1",
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(cancel).toMatchObject({
      ok: true,
      operation: "cancelExecutionEnvironmentPreparation",
    });
    await expect(preparePromise).resolves.toMatchObject({ ok: false, code: "cancelled" });
    // 取消不提交 lease：后续执行明确拒绝
    const run = await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "x", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo no" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(run).toMatchObject({ ok: false, code: "lease_rejected" });
    await manager.disposeAndWait();
  });

  it("a late prepare success after cancel is released to avoid a channel-side lease leak", async () => {
    const onChannelCall = vi.fn();
    let resolvePrepare!: (value: unknown) => void;
    const { connect } = createConnectSpy(
      fakeConnection({
        onChannelCall,
        call: (command) => {
          if (command === "prepare") {
            return new Promise((resolve) => {
              resolvePrepare = resolve;
            });
          }
          return { ok: true, operation: command };
        },
      }),
    );
    const manager = createSessionLinuxExecutionManager({ connect });
    const preparePromise = manager.execute(prepareParams(), WORKSPACE);
    await new Promise((r) => setTimeout(r, 0));
    await manager.execute(
      {
        operation: "cancelExecutionEnvironmentPreparation",
        sessionId: "s1",
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    await expect(preparePromise).resolves.toMatchObject({ ok: false, code: "cancelled" });
    // 取消后 prepare 才迟到成功：必须补 release，通道侧 lease 不泄漏。
    resolvePrepare({
      ok: true,
      operation: "prepare",
      prepare: {
        ok: true,
        lease: { leaseId: "lease-late", generation: 3 },
        resolvedCwd: "/mnt/c/proj",
        capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const releases = onChannelCall.mock.calls.filter(([command]) => command === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0]![1]).toMatchObject({
      operation: "release",
      sessionId: "s1",
      lease: { leaseId: "lease-late", generation: 3 },
    });
    await manager.disposeAndWait();
  });

  it("disposeAndWait closes pooled connections exactly once and rejects later work", async () => {
    const disposeAndWait = vi.fn(async () => undefined);
    const { connect } = createConnectSpy(fakeConnection({ disposeAndWait }));
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    await manager.disposeAndWait();
    expect(disposeAndWait).toHaveBeenCalledTimes(1);
    const after = await manager.execute(prepareParams(), WORKSPACE);
    expect(after).toMatchObject({ ok: false, code: "backend_unavailable" });
  });

  it("unknown operation (exhaustive guard) returns internal error, not silent passthrough", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    const result = await manager.execute(
      { operation: "mystery", sessionId: "s1" } as unknown as ZCodeSessionExecutionParams,
      WORKSPACE,
    );
    expect(result).toMatchObject({ ok: false, code: "internal" });
    await manager.disposeAndWait();
  });

  it("returns ZCodeSessionExecutionResult-shaped run payload passthrough", async () => {
    const { connect } = createConnectSpy();
    const manager = createSessionLinuxExecutionManager({ connect });
    await manager.execute(prepareParams(), WORKSPACE);
    const run = (await manager.execute(
      {
        operation: "run",
        sessionId: "s1",
        lease: { leaseId: "lease-1", generation: 0 },
        executionId: "e1",
        request: { command: { mode: "shell", command: "echo hi" } },
      } as ZCodeSessionExecutionParams,
      WORKSPACE,
    )) as Extract<ZCodeSessionExecutionResult, { ok: true }>;
    expect(run.ok).toBe(true);
    expect(run.operation).toBe("run");
    if (run.operation === "run") {
      expect(run.result.status).toBe("completed");
    }
    await manager.disposeAndWait();
  });
});
