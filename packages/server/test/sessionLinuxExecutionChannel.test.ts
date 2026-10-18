import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelClient, ChannelServer, CancellationTokenSource, createQueuePair } from "@zcode/rpc";
import type { ExecutionPort } from "@zcode/contracts";
import {
  createSessionLinuxExecutionChannel,
  SESSION_LINUX_EXECUTION_CHANNEL,
} from "../src/sessionLinuxExecution/sessionLinuxExecutionChannel.js";

const mocks = vi.hoisted(() => ({
  createNodeExecutionAdapter: vi.fn(),
}));

vi.mock("@zcode/adapters/exec", () => ({
  createNodeExecutionAdapter: mocks.createNodeExecutionAdapter,
}));

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "session-linux-channel-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

/** 可编程 fake ExecutionPort：按 file 分发预置响应，并记录调用。 */
function createFakeAdapter(
  handlers: Record<
    string,
    (request: { command: { file: string; args?: string[] } }) => unknown
  > = {},
) {
  const calls: Array<{
    command: { mode: string; file: string; args?: string[] };
    options: unknown;
  }> = [];
  const adapter = {
    run: async (
      request: { command: { mode: string; file: string; args?: string[] } },
      options: unknown,
    ) => {
      calls.push({
        command: request.command,
        options,
        trace: (request as { trace?: unknown }).trace,
      });
      const handler = handlers[request.command.file];
      if (handler) {
        return handler(request);
      }
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      };
    },
    close: async () => undefined,
    // 与真实 NodeExecutionAdapter 同名接口；缺省 foreground，测试可用 __lifecycle handler 覆盖。
    runBashWithBackgroundLifecycle: async (
      request: { command: { mode: string; file: string; args?: string[] } },
      lifecycle: unknown,
      options: unknown,
    ) => {
      calls.push({
        command: request.command,
        options,
        trace: (request as { trace?: unknown }).trace,
      });
      const custom = handlers["__lifecycle"];
      if (custom) return custom(request, lifecycle);
      return {
        kind: "foreground",
        result: {
          status: "completed",
          exitCode: 0,
          stdout: { text: "lifecycle", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      };
    },
    calls,
  } as unknown as ExecutionPort & {
    calls: Array<{
      command: { mode: string; file: string; args?: string[] };
      options: unknown;
      trace?: unknown;
    }>;
  };
  return adapter;
}

function linuxPathSequenceAdapter(adapter: ReturnType<typeof createFakeAdapter>) {
  // wslpath -u → realpath → wslpath -w → test -d 序列（按调用序返回）
  let wslpathCalls = 0;
  const originalRun = adapter.run.bind(adapter);
  (adapter as unknown as { run: typeof adapter.run }).run = async (request, options) => {
    const file = request.command.file;
    const args = request.command.args ?? [];
    if (file === "wslpath") {
      wslpathCalls += 1;
      if (args[0] === "-u") {
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "/mnt/c/proj\n", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        } as never;
      }
      if (args[0] === "-w") {
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "C:\\proj", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(),
          completedAt: new Date(),
        } as never;
      }
    }
    return originalRun(request, options);
  };
  void wslpathCalls;
  return adapter;
}

async function setupChannel(options?: { adapter?: ExecutionPort; channelServer?: ChannelServer }) {
  const adapters: Array<ExecutionPort & { calls?: unknown[] }> = [];
  const adapter =
    options?.adapter ??
    createFakeAdapter({
      realpath: () => ({
        status: "completed",
        exitCode: 0,
        stdout: { text: "/mnt/c/proj/sub", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      }),
      test: (request) => ({
        status: "completed",
        exitCode: request.command.args?.[1] === "/mnt/c/proj" ? 0 : 1,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      }),
      wslpath: () => ({
        status: "completed",
        exitCode: 0,
        stdout: { text: "/mnt/c/proj", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      }),
    });
  adapters.push(adapter as ExecutionPort & { calls?: unknown[] });
  const handle = createSessionLinuxExecutionChannel({
    managedRootOverride: tempRoot,
    createAdapter: () => adapter,
  });
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = options?.channelServer ?? new ChannelServer(serverProtocol, "test");
  const client = new ChannelClient(clientProtocol);
  server.registerChannel(SESSION_LINUX_EXECUTION_CHANNEL, handle.channel);
  const remote = client.getChannel(SESSION_LINUX_EXECUTION_CHANNEL);
  const call = <T>(command: string, args: unknown): Promise<T> =>
    remote.call<T>(command, args, new CancellationTokenSource().token);
  return { handle, call, adapter, adapters, server, client };
}

describe("session-linux-execution channel", () => {
  it("prepare maps workspace via wslpath/realpath roundtrip and returns lease", async () => {
    const { call, dispose } = await setupChannelWithMappedAdapter();
    try {
      const result = await call<{
        ok: true;
        operation: "prepare";
        prepare: {
          ok: true;
          lease: { leaseId: string; generation: number };
          resolvedCwd: string;
          capabilities: { bashBackgroundLifecycle: boolean; embeddedSearchNative: boolean };
        };
      }>("prepare", {
        operation: "prepare",
        sessionId: "s1",
        environment: { kind: "wsl", distro: "Ubuntu-24.04", user: "me" },
        workspacePath: "C:\\proj",
      });
      expect(result.ok).toBe(true);
      expect(result.operation).toBe("prepare");
      expect(result.prepare.lease.generation).toBe(0);
      expect(result.prepare.resolvedCwd).toBe("/mnt/c/proj");
      expect(result.prepare.capabilities).toEqual({
        bashBackgroundLifecycle: true,
        embeddedSearchNative: true,
      });
    } finally {
      await dispose();
    }
  });

  it("prepare fails with path_not_directory when resolved path is not a directory, and does not leak the lease", async () => {
    const adapter = createFakeAdapter({});
    // 让 wslpath 成功但 test -d 失败
    let call = 0;
    (adapter as unknown as { run: unknown }).run = async (request: {
      command: { file: string; args?: string[] };
    }) => {
      const file = request.command.file;
      if (file === "wslpath" && request.command.args?.[0] === "-u") {
        return textResult("/mnt/c/proj");
      }
      if (file === "realpath") {
        return textResult("/mnt/c/proj");
      }
      if (file === "test") {
        return statusResult(1);
      }
      if (file === "wslpath" && request.command.args?.[0] === "-w") {
        call += 1;
        return textResult("C:\\proj");
      }
      return textResult("");
    };
    const { call: channelCall, handle, dispose } = await setup({ adapter });
    try {
      await expect(
        channelCall("prepare", {
          operation: "prepare",
          sessionId: "s1",
          environment: { kind: "wsl", distro: "d", user: "u" },
          workspacePath: "C:\\proj",
        }),
      ).rejects.toMatchObject({ code: "path_not_directory" });
      expect(handle.registry.size()).toBe(0);
      void call;
    } finally {
      await dispose();
    }
  });

  it("run executes with default generic sandbox policy (enabled:true) passthrough", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      const result = await call<{ ok: true; result: { status: string } }>("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e1",
        request: {
          command: { mode: "shell", command: "echo hi", shellProfile: "posix-bash" },
          cwd: "C:\\proj\\sub",
          sandbox: { enabled: true },
        },
      });
      expect(result.ok).toBe(true);
      expect(result.result.status).toBe("completed");
    } finally {
      await dispose();
    }
  });

  it("run drops control-side Windows shell selection so the session env resolves its own bash", async () => {
    // 真实实例实测：控制端把 auto-detected 的 git-bash 选择（S:\Git\bin\bash.exe）随 run 下沉，
    // Linux 执行端 spawn 该 Windows 路径 → `spawn S:\Git\bin\bash.exe ENOENT`，会话内 Bash 全数失败。
    const adapter = mappedShellAdapter();
    const { call, dispose } = await setup({ adapter });
    const prepared = await prepareWorkspace(call);
    try {
      const result = await call<{ ok: true; result: { status: string } }>("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e-shell",
        request: {
          command: {
            mode: "shell",
            command: "echo hi",
            shellProfile: "posix-bash",
            shell: "S:\\Git\\bin\\bash.exe",
            shellOverride: {
              id: "auto-git-bash",
              label: "Git Bash",
              path: "S:\\Git\\bin\\bash.exe",
              dialect: "git-bash",
              source: "auto-detected",
              display: { name: "Git Bash" },
            },
          },
        },
      });
      expect(result.ok).toBe(true);
      const calls = (adapter as unknown as { calls: Array<{ command: Record<string, unknown> }> })
        .calls;
      const last = calls.at(-1);
      expect(last?.command.mode).toBe("shell");
      expect(last?.command.shellProfile).toBe("posix-bash");
      expect(last?.command.shellOverride).toBeUndefined();
      expect(last?.command.shell).toBeUndefined();
    } finally {
      await dispose();
    }
  });

  it("run keeps a POSIX shell override (session-env path stays usable)", async () => {
    const adapter = mappedShellAdapter();
    const { call, dispose } = await setup({ adapter });
    const prepared = await prepareWorkspace(call);
    try {
      await call("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e-shell-posix",
        request: {
          command: {
            mode: "shell",
            command: "echo hi",
            shellProfile: "posix-bash",
            shell: "/bin/bash",
            shellOverride: {
              path: "/usr/bin/bash",
              dialect: "posix",
              source: "auto-detected",
              display: { name: "bash" },
            },
          },
        },
      });
      const calls = (adapter as unknown as { calls: Array<{ command: Record<string, unknown> }> })
        .calls;
      const last = calls.at(-1);
      expect(last?.command.shellOverride).toMatchObject({ path: "/usr/bin/bash" });
      expect(last?.command.shell).toBe("/bin/bash");
    } finally {
      await dispose();
    }
  });

  it("run 给执行端带上会话 trace：输出目录按会话归档，不再落 unknown-session", async () => {
    // 现场缺陷：通道「trace 显式不传播」导致执行端适配器拿不到 sessionId，
    // 工具输出全部写进 output/unknown-session（lease 下无法按会话区分）。
    const adapter = mappedShellAdapter();
    const { call, dispose } = await setup({ adapter });
    const prepared = await prepareWorkspace(call);
    try {
      await call("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "exec-trace",
        request: { command: { mode: "shell", command: "echo hi" } },
      });

      const last = adapter.calls.at(-1);
      const trace = last?.trace as { traceId?: string; sessionId?: string } | undefined;
      expect(trace?.sessionId).toBe("s1");
      expect(typeof trace?.traceId).toBe("string");
      expect((trace?.traceId ?? "").length).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("run fails closed on concrete sandbox policy (profile) with sandbox_unsupported", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e2",
          request: {
            command: { mode: "shell", command: "echo hi" },
            sandbox: { enabled: true, profile: "read-only" },
          },
        }),
      ).rejects.toMatchObject({ code: "sandbox_unsupported" });
    } finally {
      await dispose();
    }
  });

  it("run rejects internal-cli prelude but accepts native-binaries prelude", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e3",
          request: {
            command: { mode: "shell", command: "echo hi" },
            bashPrelude: {
              kind: "embedded-search",
              backend: { kind: "internal-cli", command: "helper.exe" },
            },
          },
        }),
      ).rejects.toMatchObject({ code: "prelude_capability_unavailable" });

      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e4",
          request: {
            command: { mode: "shell", command: "echo hi" },
            bashPrelude: {
              kind: "embedded-search",
              backend: {
                kind: "native-binaries",
                findCommand: "find",
                grepCommand: "grep",
                rgCommand: "rg",
              },
            },
          },
        }),
      ).resolves.toBeTruthy();
    } finally {
      await dispose();
    }
  });

  it("run rejects cwd outside the authorized workspace (scope check without trusting cwd)", async () => {
    // 模拟 Linux 端：Windows cwd 经 wslpath -u 映射到工作区之外（C:\other\project → /mnt/c/other/project），
    // realpath 保留该映射结果 → 越界拒绝。scope 检查不信任入参 cwd。
    const adapter = createFakeAdapter({
      realpath: (request) => {
        const target = request.command.args?.[1] ?? "";
        return textResult(target.includes("other") ? "/mnt/c/other/project" : "/mnt/c/proj/sub");
      },
      test: () => statusResult(0),
      wslpath: (request) => {
        const flag = request.command.args?.[0];
        const input = request.command.args?.[1] ?? "";
        if (flag === "-u") {
          return textResult(input.includes("other") ? "/mnt/c/other/project" : "/mnt/c/proj");
        }
        return textResult("C:\\proj");
      },
    });
    const { call, dispose } = await setup({ adapter });
    const prepared = await prepareWorkspace(call);
    try {
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e5",
          request: {
            command: { mode: "shell", command: "echo hi" },
            cwd: "C:\\other\\project",
          },
        }),
      ).rejects.toMatchObject({ code: "path_unmappable" });
    } finally {
      await dispose();
    }
  });

  it("run maps a Windows control-side cwd via wslpath -u before realpath/scope check", async () => {
    // 真实实例回归：控制端 cwd 是 Windows 路径（C:\proj）。直接 realpath -m 会把它当相对
    // 路径拼到执行端 cwd → 越界拒绝，WSL 会话 Bash 全数失败。必须先 wslpath -u 映射。
    const seen: Array<{ file: string; args?: string[] }> = [];
    const adapter = createFakeAdapter({
      // prepare 的 realpath（无 -m）→ 工作区根；run 的 realpath -m → 子目录。
      realpath: (request) =>
        textResult(request.command.args?.[0] === "-m" ? "/mnt/c/proj/sub" : "/mnt/c/proj"),
      test: () => statusResult(0),
      wslpath: (request) =>
        textResult(
          request.command.args?.[1] === "C:\\proj\\sub" ? "/mnt/c/proj/sub" : "/mnt/c/proj",
        ),
    });
    const run = adapter.run.bind(adapter);
    (adapter as unknown as { run: (request: unknown) => Promise<unknown> }).run = async (
      request: unknown,
    ) => {
      const command = (request as { command: { file: string; args?: string[] } }).command;
      seen.push({ file: command.file, args: command.args });
      return run(request as never);
    };
    const { call, dispose } = await setup({ adapter });
    try {
      const prepared = await prepareWorkspace(call);
      const result = await call<{ ok: boolean }>("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e1",
        request: { command: { mode: "shell", command: "cat x" }, cwd: "C:\\proj\\sub" },
      });
      expect(result.ok).toBe(true);
      // 运行期（run）的 wslpath -u 必须收到原样 Windows cwd，realpath -m 必须收到映射后的 Linux 路径。
      const mapped = seen.find(
        (entry) =>
          entry.file === "wslpath" &&
          entry.args?.[0] === "-u" &&
          entry.args?.[1] === "C:\\proj\\sub",
      );
      expect(mapped?.args?.[1]).toBe("C:\\proj\\sub");
      const realpath = seen.find((entry) => entry.file === "realpath" && entry.args?.[0] === "-m");
      expect(realpath?.args?.[1]).toBe("/mnt/c/proj/sub");
    } finally {
      await dispose();
    }
  });

  it("run rejects a corrupted hybrid cwd (Linux prefix + Windows segments) without probing realpath", async () => {
    // 历史缺陷现场：wire.cwd 形如 <serverCwd>/C:\Users\...（以 / 开头但含反斜杠）。
    // 若不拒绝，startsWith('/') 短路会跳过 wslpath 直接 realpath -m → 再次错拼。
    const seen: Array<{ file: string; args?: string[] }> = [];
    const adapter = createFakeAdapter({
      realpath: (request) =>
        textResult(request.command.args?.[0] === "-m" ? "/mnt/c/proj" : "/mnt/c/proj"),
      test: () => statusResult(0),
      wslpath: () => textResult("/mnt/c/proj"),
    });
    const run = adapter.run.bind(adapter);
    (adapter as unknown as { run: (request: unknown) => Promise<unknown> }).run = async (
      request: unknown,
    ) => {
      const command = (request as { command: { file: string; args?: string[] } }).command;
      seen.push({ file: command.file, args: command.args });
      return run(request as never);
    };
    const { call, dispose } = await setup({ adapter });
    try {
      const prepared = await prepareWorkspace(call);
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e1",
          request: {
            command: { mode: "shell", command: "cat x" },
            cwd: "/mnt/c/snapshot/C:\\Users\\me\\proj",
          },
        }),
      ).rejects.toMatchObject({ code: "path_unmappable" });
      // 必须在 realpath 探测之前拒绝（不给错拼路径任何落地机会）。
      expect(seen.filter((entry) => entry.file === "realpath" && entry.args?.[0] === "-m")).toEqual(
        [],
      );
    } finally {
      await dispose();
    }
  });

  it("rejects stale generation and unknown execution with typed errors", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: { leaseId: prepared.lease.leaseId, generation: 5 },
          executionId: "e6",
          request: { command: { mode: "shell", command: "echo hi" } },
        }),
      ).rejects.toMatchObject({ code: "stale_generation" });

      await expect(
        call("poll", {
          operation: "poll",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "missing",
          cursor: 0,
        }),
      ).rejects.toMatchObject({ code: "unknown_execution" });

      await expect(
        call("run", {
          operation: "run",
          sessionId: "other-session",
          lease: prepared.lease,
          executionId: "e7",
          request: { command: { mode: "shell", command: "echo hi" } },
        }),
      ).rejects.toMatchObject({ code: "stale_generation" });
    } finally {
      await dispose();
    }
  });

  it("poll returns buffered events with cursor and final result", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      await call("run", {
        operation: "run",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e8",
        request: { command: { mode: "shell", command: "echo hi" } },
      });
      const first = await call<{
        poll: { events: unknown[]; nextCursor: number; result?: unknown };
      }>("poll", {
        operation: "poll",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e8",
        cursor: 0,
      });
      expect(first.poll.nextCursor).toBeGreaterThanOrEqual(0);
      expect(first.poll.result).toBeDefined();
      // cursor 之后无更多事件
      const second = await call<{ poll: { events: unknown[]; result?: unknown } }>("poll", {
        operation: "poll",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e8",
        cursor: first.poll.nextCursor,
      });
      expect(second.poll.events).toEqual([]);
      expect(second.poll.result).toBeDefined();
    } finally {
      await dispose();
    }
  });

  it("release only frees its own lease; strict schema rejects unknown operations", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      await expect(
        call("release", {
          operation: "release",
          sessionId: "s1",
          lease: prepared.lease,
        }),
      ).resolves.toMatchObject({ ok: true });
      // release 幂等但 scope 失效后再次操作拒绝
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e9",
          request: { command: { mode: "shell", command: "echo hi" } },
        }),
      ).rejects.toMatchObject({ code: "unknown_lease" });
      await expect(call("bogus", {})).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await dispose();
    }
  });

  it("releaseSession frees every lease of that session only and is idempotent", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      const second = await call<{
        prepare: { lease: { leaseId: string; generation: number } };
      }>("prepare", {
        operation: "prepare",
        sessionId: "s2",
        environment: { kind: "wsl", distro: "d", user: "u" },
        workspacePath: "C:\\proj",
      });
      await expect(
        call("releaseSession", { operation: "releaseSession", sessionId: "s1" }),
      ).resolves.toMatchObject({ ok: true, operation: "releaseSession" });
      // s1 的 lease 已回收
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s1",
          lease: prepared.lease,
          executionId: "e1",
          request: { command: { mode: "shell", command: "echo hi" } },
        }),
      ).rejects.toMatchObject({ code: "unknown_lease" });
      // 其他会话的 lease 不受影响
      await expect(
        call("run", {
          operation: "run",
          sessionId: "s2",
          lease: second.prepare.lease,
          executionId: "e2",
          request: { command: { mode: "shell", command: "echo hi" } },
        }),
      ).resolves.toMatchObject({ ok: true, operation: "run" });
      // 幂等：再次释放仍成功
      await expect(
        call("releaseSession", { operation: "releaseSession", sessionId: "s1" }),
      ).resolves.toMatchObject({ ok: true, operation: "releaseSession" });
    } finally {
      await dispose();
    }
  });

  it("bashBackgroundLifecycle maps adapter lifecycle result to the wire envelope", async () => {
    const { call, dispose } = await setup();
    const prepared = await prepareWorkspace(call);
    try {
      const foreground = await call("bashBackgroundLifecycle", {
        operation: "bashBackgroundLifecycle",
        sessionId: "s1",
        lease: prepared.lease,
        executionId: "e-lc",
        request: { command: { mode: "shell", command: "echo lc" } },
        mode: "explicit",
      });
      expect(foreground).toMatchObject({
        ok: true,
        operation: "bashBackgroundLifecycle",
        lifecycle: { kind: "foreground", result: { status: "completed" } },
      });
    } finally {
      await dispose();
    }
  });

  it("dispose barrier terminates resources and rejects later calls", async () => {
    const { call, handle, dispose } = await setup();
    await prepareWorkspace(call);
    await handle.dispose();
    await expect(
      call("prepare", {
        operation: "prepare",
        sessionId: "s2",
        environment: { kind: "wsl", distro: "d", user: "u" },
        workspacePath: "C:\\proj",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await dispose();
  });

  // ── helpers ──

  async function setup(options?: { adapter?: ExecutionPort }) {
    const adapters: ExecutionPort[] = [];
    const adapter =
      options?.adapter ??
      createFakeAdapter({
        realpath: () => textResult("/mnt/c/proj"),
        test: () => statusResult(0),
        wslpath: (request) =>
          textResult(request.command.args?.[0] === "-w" ? "C:\proj" : "/mnt/c/proj"),
      });
    adapters.push(adapter);
    const handle = createSessionLinuxExecutionChannel({
      managedRootOverride: tempRoot,
      createAdapter: () => adapter,
    });
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(SESSION_LINUX_EXECUTION_CHANNEL, handle.channel);
    const remote = client.getChannel(SESSION_LINUX_EXECUTION_CHANNEL);
    const call = <T>(command: string, args: unknown): Promise<T> =>
      remote.call<T>(command, args, new CancellationTokenSource().token);
    return {
      handle,
      call,
      adapter,
      adapters,
      dispose: async () => {
        await handle.dispose();
        client.dispose();
        server.dispose();
      },
    };
  }

  function textResult(text: string) {
    return {
      status: "completed",
      exitCode: 0,
      stdout: { text, bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      startedAt: new Date(),
      completedAt: new Date(),
    };
  }

  function statusResult(code: number) {
    return {
      status: code === 0 ? "completed" : "failed",
      exitCode: code,
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      durationMs: 1,
      timedOut: false,
      cancelled: false,
      startedAt: new Date(),
      completedAt: new Date(),
    };
  }

  /** prepare 用可映射序列（wslpath -u /m/c/proj, realpath, test -d ok, wslpath -w）。 */
  function createMappedAdapter() {
    return createFakeAdapter({});
  }

  /** 可映射序列 + 记录 run 调用的 fake adapter（shell 选择归一化的断言用）。 */
  function mappedShellAdapter() {
    return linuxPathSequenceAdapter(
      createFakeAdapter({
        realpath: () => textResult("/mnt/c/proj"),
        test: () => statusResult(0),
      }),
    );
  }

  async function setupChannelWithMappedAdapter() {
    const adapter = linuxPathSequenceAdapter(
      createFakeAdapter({
        realpath: () => textResult("/mnt/c/proj"),
        test: () => statusResult(0),
      }),
    );
    const { handle, call, dispose } = await setup({ adapter });
    return { handle, call, dispose };
  }

  async function prepareWorkspace(call: <T>(command: string, args: unknown) => Promise<T>) {
    // 返回嵌套的 prepare 载荷，测试其余用例直接取 lease/resolvedCwd。
    const result = await call<{
      prepare: { lease: { leaseId: string; generation: number }; resolvedCwd: string };
    }>("prepare", {
      operation: "prepare",
      sessionId: "s1",
      environment: { kind: "wsl", distro: "d", user: "u" },
      workspacePath: "C:\\proj",
    });
    return result.prepare;
  }
});
