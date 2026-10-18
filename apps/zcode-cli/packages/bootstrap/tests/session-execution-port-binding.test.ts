import { describe, expect, it, vi } from "vitest";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { createSessionExecutionPortBinding } from "../src/app/session-execution-port-binding.js";

/**
 * 会话执行端口绑定：会话内环境切换（本地↔WSL）不重建 App，只切换稳定门面内部端口。
 * 本测试锁定该语义：门面身份稳定、可选能力按当前端口呈现在场、切换释放借用 lease。
 */

function createLocalExecutionPort() {
  const run = vi.fn(async () => ({ status: "completed", exitCode: 0 }));
  const runBashWithBackgroundLifecycle = vi.fn(async () => ({ status: "completed", exitCode: 0 }));
  const close = vi.fn(async () => undefined);
  const port = {
    run,
    runBashWithBackgroundLifecycle,
    close,
  } as unknown as ExecutionPort;
  return { port, run, runBashWithBackgroundLifecycle, close };
}

function createLocalFileSystemPort() {
  const readTextFile = vi.fn(async (request: { path: string }) => ({
    path: request.path,
    content: "local",
    encoding: "utf8" as const,
    lineEndings: "lf" as const,
    revision: "1",
  }));
  const port = { readTextFile } as unknown as FileSystemPort;
  return { port, readTextFile };
}

function createWslFileSystemPort() {
  const readTextFile = vi.fn(async (request: { path: string }) => ({
    path: request.path,
    content: "wsl",
    encoding: "utf8" as const,
    lineEndings: "lf" as const,
    revision: "2",
  }));
  const port = { readTextFile } as unknown as FileSystemPort;
  return { port, readTextFile };
}

function setup(options: { wslStdout?: string; wslFailed?: boolean; rejectRun?: boolean } = {}) {
  // 最小合法的执行 wire 结果：routing port 的 run 会过 executionWireResultSchema。
  const wireResult = {
    status: options.wslFailed ? ("failed" as const) : ("completed" as const),
    exitCode: options.wslFailed ? 1 : 0,
    stdout: {
      text: options.wslStdout ?? "",
      bytes: (options.wslStdout ?? "").length,
      truncated: false,
    },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAtMs: 1,
    completedAtMs: 2,
  };
  const send = vi.fn(async (params: { operation?: string }) => {
    if (options.rejectRun && params.operation === "run") {
      throw new Error("channel unavailable");
    }
    return params.operation === "release" ? { ok: true } : { ok: true, result: wireResult };
  });
  const local = createLocalExecutionPort();
  const localFs = createLocalFileSystemPort();
  const wslFs = createWslFileSystemPort();
  const binding = createSessionExecutionPortBinding({
    sessionId: "sess-1",
    send,
    createWslFileSystemPort: () => wslFs.port,
  });
  binding.attachLocalPorts({ executionPort: local.port, fileSystemPort: localFs.port });
  return { binding, send, local, localFs, wslFs };
}

describe("会话执行端口绑定", () => {
  it("本地目标：门面转发到本地端口，可选能力按本地实现呈现在场", async () => {
    const { binding, local } = setup();
    expect(typeof binding.executionPort.run).toBe("function");
    // 本地 NodeExecutionAdapter 有 runBashWithBackgroundLifecycle → 门面必须呈现
    expect(typeof binding.executionPort.runBashWithBackgroundLifecycle).toBe("function");
    await binding.executionPort.run({} as never);
    expect(local.run).toHaveBeenCalledTimes(1);
    expect(local.runBashWithBackgroundLifecycle).not.toHaveBeenCalled();
  });

  it("切到 WSL：run 经反向 RPC 携带 sessionId+lease，缺失的组合能力不再呈现", async () => {
    const { binding, send, local } = setup();
    const facadeBefore = binding.executionPort;
    binding.activateWsl({
      lease: { leaseId: "lease-2", generation: 3 },
      capabilities: { bashBackgroundLifecycle: true, embeddedSearchNative: true },
      distro: "Ubuntu-24.04",
    });
    // 门面身份稳定：切换不换对象（工具层构造期捕获的引用继续有效）
    expect(binding.executionPort).toBe(facadeBefore);
    // 借用路由端口没有 runBashWithBackgroundLifecycle → 能力探测落 false（回落 run）
    expect(binding.executionPort.runBashWithBackgroundLifecycle).toBeUndefined();
    await binding.executionPort.run({ command: { mode: "shell", command: "echo hi" } } as never);
    expect(local.run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "run",
        sessionId: "sess-1",
        lease: { leaseId: "lease-2", generation: 3 },
      }),
    );
  });

  it("WSL 目标：文件门面转发到 WSL 适配器；切回本地后回到本地端口", async () => {
    const { binding, localFs, wslFs } = setup();
    binding.activateWsl({
      lease: { leaseId: "lease-2", generation: 0 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });
    await binding.fileSystemPort.readTextFile({ path: "/home/me/a.txt" } as never);
    expect(wslFs.readTextFile).toHaveBeenCalledWith({ path: "/home/me/a.txt" });
    expect(localFs.readTextFile).not.toHaveBeenCalled();

    await binding.activateLocal();
    await binding.fileSystemPort.readTextFile({ path: "/home/me/a.txt" } as never);
    expect(localFs.readTextFile).toHaveBeenCalledWith({ path: "/home/me/a.txt" });
  });

  it("切回本地释放借用 lease（幂等：无在途目标也不抛）", async () => {
    const { binding, send } = setup();
    binding.activateWsl({
      lease: { leaseId: "lease-9", generation: 1 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });
    expect(binding.isWslActive()).toBe(true);
    await binding.activateLocal();
    expect(binding.isWslActive()).toBe(false);
    expect(send).toHaveBeenCalledWith({
      operation: "release",
      sessionId: "sess-1",
      lease: { leaseId: "lease-9", generation: 1 },
    });
    // 已在本地目标：再次 activateLocal 不应抛出，也不产生额外 release
    send.mockClear();
    await binding.activateLocal();
    expect(send).not.toHaveBeenCalled();
  });

  it("门面 close 释放借用 lease 并关闭本地端口", async () => {
    const { binding, send, local } = setup();
    binding.activateWsl({
      lease: { leaseId: "lease-close", generation: 0 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });
    await binding.executionPort.close?.();
    expect(send).toHaveBeenCalledWith({
      operation: "release",
      sessionId: "sess-1",
      lease: { leaseId: "lease-close", generation: 0 },
    });
    expect(local.close).toHaveBeenCalledTimes(1);
    expect(binding.isWslActive()).toBe(false);
  });
});

/**
 * 宿主路径翻译：hook 命令/环境/stdin 里的插件与项目路径必须先落到执行环境。
 * 现场缺陷：`python3 "${CLAUDE_PLUGIN_ROOT}/hooks/x.py"` 的 Windows 路径被原样交给
 * WSL shell（`/mnt/c/.../agent/C:\...`）→ hook 失败被当成拦阻。映射必须与 cwd 同源
 * （执行端 wslpath），不可映射时返回 null 由调用方显式失败。
 */
describe("宿主路径翻译", () => {
  it("本地目标：宿主路径即执行路径，原值返回（不猜测）", async () => {
    const { binding, send } = setup();
    await expect(binding.executionPort.translateHostPath?.("C:\\work\\a.txt")).resolves.toBe(
      "C:\\work\\a.txt",
    );
    await expect(binding.executionPort.translateHostPath?.("/home/me/a.txt")).resolves.toBe(
      "/home/me/a.txt",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("WSL 目标：经执行端 wslpath -u 翻译，返回 Linux 绝对路径", async () => {
    const { binding, send } = setup({ wslStdout: "/mnt/c/Users/me/.zcode/plugins/p\n" });
    binding.activateWsl({
      lease: { leaseId: "lease-tr", generation: 0 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });

    const windowsPath = "C:\\Users\\me\\.zcode\\plugins\\p";
    await expect(binding.executionPort.translateHostPath?.(windowsPath)).resolves.toBe(
      "/mnt/c/Users/me/.zcode/plugins/p",
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "run",
        request: expect.objectContaining({
          command: { mode: "argv", file: "wslpath", args: ["-u", windowsPath] },
        }),
      }),
    );
  });

  it("WSL 目标：执行端未给绝对路径 / 非零退出 / 抛错 → null（调用方显式失败）", async () => {
    const nonAbsolute = setup({ wslStdout: "wslpath: invalid argument\n", wslFailed: true });
    nonAbsolute.binding.activateWsl({
      lease: { leaseId: "lease-a", generation: 0 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });
    await expect(
      nonAbsolute.binding.executionPort.translateHostPath?.("\\\\net\\share\\p"),
    ).resolves.toBeNull();

    const throwing = setup({ rejectRun: true });
    throwing.binding.activateWsl({
      lease: { leaseId: "lease-b", generation: 0 },
      capabilities: { bashBackgroundLifecycle: false, embeddedSearchNative: false },
      distro: "Ubuntu-24.04",
    });
    await expect(
      throwing.binding.executionPort.translateHostPath?.("Z:\\missing\\p"),
    ).resolves.toBeNull();
  });
});
