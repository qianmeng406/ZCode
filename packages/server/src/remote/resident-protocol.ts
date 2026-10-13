// ============================================================
// Resident server protocol: argv dispatch, status file, liveness,
// per-connection hello/ack framing and net.Socket → ISocket adapter.
//
// 规格见 packages/server/specs/remote-resident-server.md。
// 常驻模式把「任务所有权」与「连接生命周期」解耦：daemon 持有 services 与
// Agent runtime，桌面连接经 stdio bridge 接入，断开只释放订阅，任务继续。
// ============================================================
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { dirname } from "node:path";
import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";
import {
  ZCODE_VERSION,
  formatZodError,
  helloAckMessageSchema,
  type HelloAckMessage,
  type HelloMessage,
} from "@zcode/shared";

export const RESIDENT_START_ARG = "--resident-start";
export const RESIDENT_SERVE_ARG = "--resident-serve";
export const RESIDENT_BRIDGE_ARG = "--resident-bridge";
export const RESIDENT_STOP_ARG = "--resident-stop";

export type ResidentArgvCommand = "start" | "serve" | "bridge" | "stop";

export function resolveResidentArgvCommand(
  argv: readonly string[],
): ResidentArgvCommand | undefined {
  if (argv.includes(RESIDENT_START_ARG)) return "start";
  if (argv.includes(RESIDENT_SERVE_ARG)) return "serve";
  if (argv.includes(RESIDENT_BRIDGE_ARG)) return "bridge";
  if (argv.includes(RESIDENT_STOP_ARG)) return "stop";
  return undefined;
}

export interface ResidentDaemonStatus {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

export function residentDaemonStatusPath(runtimeRoot: string): string {
  return `${runtimeRoot}/daemon.json`;
}

/** daemon 运行日志（含启动失败诊断）；轮转不在 v1 范围。 */
export function residentDaemonLogPath(runtimeRoot: string): string {
  return `${runtimeRoot}/daemon.log`;
}

/** daemon.json 是 daemon 存活判定的唯一事实源；坏文件按缺席处理（start 会重建）。 */
export async function readResidentDaemonStatus(
  statusPath: string,
): Promise<ResidentDaemonStatus | undefined> {
  let raw: string;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ResidentDaemonStatus>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.version !== "string"
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      version: parsed.version,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export async function writeResidentDaemonStatus(
  statusPath: string,
  status: ResidentDaemonStatus,
): Promise<void> {
  // runtime root 在部署产物场景必然存在；直接以文件方式运行（冒烟/开发）时按需创建。
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function removeResidentDaemonStatus(statusPath: string): Promise<void> {
  await rm(statusPath, { force: true });
}

/** EPERM 视为存活：pid 属于别的用户但存在，不能误判为可复用。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export async function probeLoopbackPort(port: number, timeoutMs = 1_500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const settle = (result: boolean) => {
      socket.removeAllListeners();
      // 优雅半关再销毁：ECONNRESET 属于对端可恢复事件，不该让对端连接面板报错。
      socket.end();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export async function isResidentDaemonAlive(
  status: ResidentDaemonStatus,
  probe: (port: number) => Promise<boolean> = probeLoopbackPort,
): Promise<boolean> {
  if (!isPidAlive(status.pid)) return false;
  return await probe(status.port);
}

/**
 * daemon → 客户端 per-connection 握手：写 zcode-hello 行，等 zcode-hello-ack。
 * 返回 ack 之后残留在 socket 里的字节（RPC 首帧可能紧随 ack），由调用方
 * unshift 回流，保证 SocketProtocol 不丢首帧数据。
 */
export function writeResidentHello(socket: net.Socket, hello?: HelloMessage): void {
  const message: HelloMessage = hello ?? {
    type: "zcode-hello",
    version: ZCODE_VERSION,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
  };
  socket.write(`${JSON.stringify(message)}\n`);
}

export function waitResidentHelloAck(
  socket: net.Socket,
  timeoutMs = 10_000,
): Promise<{ ack: HelloAckMessage; remaining: Buffer | null }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Resident handshake timeout: no hello-ack within timeout"));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);
      cleanup();
      try {
        const rawValue: unknown = JSON.parse(line);
        const result = helloAckMessageSchema.safeParse(rawValue);
        if (!result.success) {
          settled = true;
          reject(new Error(`Invalid resident hello-ack: ${formatZodError(result.error)}`));
          return;
        }
        settled = true;
        resolve({
          ack: result.data as HelloAckMessage,
          remaining: remaining.length > 0 ? Buffer.from(remaining, "utf-8") : null,
        });
      } catch (error) {
        settled = true;
        reject(new Error(`Failed to parse resident hello-ack: ${String(error)}`));
      }
    };
    socket.on("data", onData);
  });
}

/** net.Socket → ISocket（与 stdio.ts / http.ts 的适配同构，字节面纯透传）。 */
export function wrapNetSocket(socket: net.Socket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  const handleClosed = () => {
    onClose.fire();
    onEnd.fire();
  };
  socket.once("close", handleClosed);
  socket.once("error", handleClosed);
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      socket.write(Buffer.from(buffer.buffer));
    },
    end() {
      socket.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (socket.writableNeedDrain) {
          socket.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      socket.destroy();
    },
  };
}
