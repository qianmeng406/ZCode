// ============================================================
// Resident stdio bridge: 纯字节管道，把 SSH exec 的 stdin/stdout
// 桥接到本机回环上的常驻 daemon TCP 端口。
// 生命周期随 SSH exec 会话生灭；任何诊断只能写 stderr（stdout 是协议面）。
// ============================================================
import * as net from "node:net";
import { readResidentDaemonStatus, residentDaemonStatusPath } from "./resident-protocol.js";

export interface ResidentBridgeIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface ResidentBridgeOptions {
  runtimeRoot: string;
  io: ResidentBridgeIo;
  /** 注入用于测试；生产实现连接 127.0.0.1:<port> */
  connect?: (port: number) => Promise<net.Socket>;
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export function connectLoopbackPort(
  port: number,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connect to 127.0.0.1:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * 返回进程退出码：0 = 正常（stdin EOF 或 daemon 侧关闭），
 * 非 0 = 无法定位/连接 daemon（桌面握手会以 stream closed 收口）。
 */
export async function runResidentStdioBridge(options: ResidentBridgeOptions): Promise<number> {
  const { runtimeRoot, io, connect = connectLoopbackPort } = options;
  const status = await readResidentDaemonStatus(residentDaemonStatusPath(runtimeRoot));
  if (!status) {
    io.stderr.write("resident bridge: daemon.json not found; daemon is not running\n");
    return 1;
  }

  let socket: net.Socket;
  try {
    socket = await connect(status.port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`resident bridge: connect to 127.0.0.1:${status.port} failed: ${message}\n`);
    return 1;
  }

  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    // 双向纯字节管道：不做任何成帧/解释，协议面完全交给两端。
    io.stdin.pipe(socket);
    socket.pipe(io.stdout);

    io.stdin.on("end", () => {
      // 桌面侧 dispose：stdin EOF → 半关 TCP，让 daemon 走 scope 退订。
      socket.end();
    });
    io.stdin.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      // daemon 侧关闭或 daemon 崩溃：结束 stdout，桌面看到 stream close。
      const writable = io.stdout as NodeJS.WritableStream & { end?: (cb?: () => void) => void };
      if (typeof writable.end === "function") {
        writable.end(() => finish(0));
        // end 回调不可靠时兜底结算，避免进程挂住。
        setTimeout(() => finish(0), 250).unref?.();
        return;
      }
      finish(0);
    });
    socket.on("error", (error) => {
      io.stderr.write(`resident bridge: socket error: ${error.message}\n`);
      socket.destroy();
      finish(1);
    });
  });
}
