// ============================================================
// Resident daemon lifecycle: idempotent start, per-connection RPC
// server and explicit stop.
// 规格见 packages/server/specs/remote-resident-server.md。
// ============================================================
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { ChannelServer, SocketProtocol } from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import type { ResidentDaemonStatus } from "./resident-protocol.js";
import {
  isPidAlive,
  isResidentDaemonAlive,
  readResidentDaemonStatus,
  removeResidentDaemonStatus,
  residentDaemonLogPath,
  residentDaemonStatusPath,
  waitResidentHelloAck,
  wrapNetSocket,
  writeResidentDaemonStatus,
  writeResidentHello,
} from "./resident-protocol.js";

const DAEMON_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_TIMEOUT_MS = 5_000;

export interface EnsureResidentDaemonOptions {
  runtimeRoot: string;
  /** daemon 可执行脚本（部署后的 zcode-server.cjs 绝对路径） */
  scriptPath: string;
  /** daemon 进程继承的完整 env（含部署流程注入的运行时变量） */
  env: NodeJS.ProcessEnv;
  log: (...args: unknown[]) => void;
  spawnImpl?: typeof spawn;
  probe?: (port: number) => Promise<boolean>;
  waitTimeoutMs?: number;
}

/**
 * 幂等确保 daemon 在跑：存活（pid + 回环探活）直接返回；否则清理陈旧
 * daemon.json，spawn 自身 --resident-serve（detached、独立进程组，SSH 会话退出
 * 不会 SIGHUP 到它），等待状态文件 + 探活成功。
 *
 * daemon 的 stdout/stderr 重定向到 runtime root 下的 daemon.log：stdio "ignore"
 * 会让启动即崩完全静默，超时只能靠猜；日志文件让 `--resident-start` 失败可诊断。
 */
export async function ensureResidentDaemonRunning(
  options: EnsureResidentDaemonOptions,
): Promise<ResidentDaemonStatus> {
  const {
    runtimeRoot,
    scriptPath,
    env,
    log,
    spawnImpl = spawn,
    probe,
    waitTimeoutMs = DEFAULT_DAEMON_READY_TIMEOUT_MS,
  } = options;
  const statusPath = residentDaemonStatusPath(runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true });

  const existing = await readResidentDaemonStatus(statusPath);
  if (existing && (await isResidentDaemonAlive(existing, probe))) {
    if (existing.version !== ZCODE_VERSION) {
      // 版本不一致的旧 daemon 不能复用：它会带着旧代码/旧环境变量继续服务
      // （PM2 重启后 env 不生效一类问题的复发通道），停掉后按新版本重拉。
      log(
        `resident daemon version mismatch (running=${existing.version} expected=${ZCODE_VERSION}); restarting`,
      );
      await stopResidentDaemon({ runtimeRoot, log }).catch(() => undefined);
    } else {
      log(`resident daemon already running (pid=${existing.pid} port=${existing.port})`);
      return existing;
    }
  }
  if (existing) {
    log(`resident daemon status is stale (pid=${existing.pid}); restarting`);
  }
  await removeResidentDaemonStatus(statusPath);

  let spawnError: Error | undefined;
  let childExit: { code: number | null } | undefined;
  const logFd = openSync(residentDaemonLogPath(runtimeRoot), "a");
  try {
    const child = spawnImpl(process.execPath, [scriptPath, "--resident-serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env,
    });
    child.unref();
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
    // 启动即崩（如端口占用、配置损坏）必须快速失败，不能烧满整个等待预算。
    child.once("exit", (code) => {
      childExit = { code };
    });

    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(`Resident daemon failed to spawn: ${spawnError.message}`);
      }
      const status = await readResidentDaemonStatus(statusPath);
      if (status && (await isResidentDaemonAlive(status, probe))) {
        log(`resident daemon ready (pid=${status.pid} port=${status.port})`);
        return status;
      }
      if (childExit) {
        throw new Error(
          `Resident daemon exited during startup (code=${childExit.code}); see ${residentDaemonLogPath(runtimeRoot)}`,
        );
      }
      await sleep(DAEMON_READY_POLL_INTERVAL_MS);
    }
  } finally {
    closeSync(logFd);
  }
  throw new Error(
    `Resident daemon did not become ready within ${waitTimeoutMs}ms (status file: ${statusPath}, log: ${residentDaemonLogPath(runtimeRoot)})`,
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ResidentServeOptions {
  runtimeRoot: string;
  /** 缺省由内核分配空闲端口并写入 daemon.json */
  port?: number;
  hostname?: string;
  services: ServiceCollection;
  log: (...args: unknown[]) => void;
}

export interface ResidentServeHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * daemon 主循环：服务只创建一次；每个 TCP 连接独立握手 + ChannelServer +
 * connection scope。连接关闭只退订本连接订阅（scope.dispose 语义），
 * 绝不退出进程——这是「桌面断开、任务继续」的核心不变量。
 */
export async function runResidentDaemonServe(
  options: ResidentServeOptions,
): Promise<ResidentServeHandle> {
  const { runtimeRoot, services, log } = options;
  const hostname = options.hostname ?? "127.0.0.1";
  let connectionCount = 0;

  const server = net.createServer((socket) => {
    connectionCount += 1;
    void handleDaemonConnection({ socket, services, log, index: connectionCount });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("Resident daemon listener did not return a TCP address"));
    });
  });

  const statusPath = residentDaemonStatusPath(runtimeRoot);
  const status: ResidentDaemonStatus = {
    pid: process.pid,
    port,
    version: ZCODE_VERSION,
    startedAt: Date.now(),
  };
  await writeResidentDaemonStatus(statusPath, status);
  log(`resident daemon listening on ${hostname}:${port} (pid=${process.pid})`);

  const close = async (): Promise<void> => {
    await removeResidentDaemonStatus(statusPath);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  return { port, close };
}

interface DaemonConnectionOptions {
  socket: net.Socket;
  services: ServiceCollection;
  log: (...args: unknown[]) => void;
  index: number;
}

async function handleDaemonConnection(options: DaemonConnectionOptions): Promise<void> {
  const { socket, services, log, index } = options;
  // 任何 socket 错误只影响本连接：探活探测、半开连接等会触发 ECONNRESET，
  // 没有 error 监听的未处理异常会让整个 daemon 崩溃（状态文件还在、进程已死）。
  socket.on("error", (error) => {
    log(`resident connection #${index} socket error: ${describeError(error)}`);
    socket.destroy();
  });
  try {
    writeResidentHello(socket);
    const { ack, remaining } = await waitResidentHelloAck(socket);
    if (remaining && remaining.length > 0) {
      // RPC 首帧可能紧随 ack；推回流，保证 SocketProtocol 不丢首帧。
      socket.unshift(remaining);
    }
    const protocol = new SocketProtocol(wrapNetSocket(socket));
    const channelServer = new ChannelServer(protocol, `resident-${index}`);
    const agentService = services.getOptional(IZCodeAgentService);
    // ack 可选声明的 clientMode 决定 v4 投递档（远端客户端声明 web-remote-replayable；
    // 不带该字段 → 维持 desktop-continuous）。
    const clientMode = ack.clientMode ?? "desktop-continuous";
    const connectionScope = agentService
      ? createZCodeAgentConnectionScope(agentService, {
          connectionId: `server-resident-${randomUUID()}`,
          clientMode,
          role: "trusted-host-relay",
        })
      : undefined;
    services.exposeOnChannelServer(
      channelServer,
      connectionScope
        ? new Map([[IZCodeAgentService.channelName, connectionScope.service]])
        : new Map(),
    );
    log(`resident connection #${index} established (clientMode=${clientMode})`);
    const teardown = (): void => {
      channelServer.dispose();
      // scope.dispose 只退订本连接的 V4 订阅；Agent runtime 与任务继续由 daemon 持有。
      void connectionScope?.dispose().catch((error: unknown) => {
        log(`resident connection #${index} scope dispose failed: ${describeError(error)}`);
      });
    };
    socket.once("close", teardown);
    socket.once("error", teardown);
  } catch (error) {
    log(`resident connection #${index} handshake failed: ${describeError(error)}`);
    socket.destroy();
    return;
  }
}

/** 读状态 → SIGTERM → 宽限后 SIGKILL → 删状态文件。供显式「停止远端运行时」使用。 */
export async function stopResidentDaemon(options: {
  runtimeRoot: string;
  log: (...args: unknown[]) => void;
  signalImpl?: (pid: number, signal: NodeJS.Signals) => unknown;
  isAliveImpl?: (pid: number) => boolean;
}): Promise<boolean> {
  const { runtimeRoot, log } = options;
  const signalImpl = options.signalImpl ?? ((pid, signal) => process.kill(pid, signal));
  const isAliveImpl = options.isAliveImpl ?? isPidAlive;
  const statusPath = residentDaemonStatusPath(runtimeRoot);
  const status = await readResidentDaemonStatus(statusPath);
  if (!status) {
    return false;
  }
  const terminate = async (signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> => {
    try {
      signalImpl(status.pid, signal);
    } catch {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAliveImpl(status.pid)) return true;
      await sleep(DAEMON_READY_POLL_INTERVAL_MS);
    }
    return !isAliveImpl(status.pid);
  };

  log(`stopping resident daemon (pid=${status.pid})`);
  const graceful = await terminate("SIGTERM", STOP_GRACE_TIMEOUT_MS);
  if (!graceful) {
    await terminate("SIGKILL", STOP_GRACE_TIMEOUT_MS);
  }
  await removeResidentDaemonStatus(statusPath);
  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
