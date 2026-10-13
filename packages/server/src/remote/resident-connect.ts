// ============================================================
// Resident connect helpers: 远端命令构造、短命命令等待与常驻连接发起。
// 与 stdio 会话模式共用同一运行时 env 前缀（由 connect.ts 传入）。
// 规格见 ../specs/remote-resident-server.md。
// ============================================================
import type { IRemoteBackend } from "./backend.js";

const RESIDENT_SERVER_ENTRY = "~/.zcode/server/node ~/.zcode/server/zcode-server.cjs";

/** 导出仅供单测：env 前缀与 stdio 模式共用的回归防线。 */
export function buildResidentDaemonStartCommand(remoteRuntimeEnvPrefix: string): string {
  return `${remoteRuntimeEnvPrefix} ${RESIDENT_SERVER_ENTRY} --resident-start`;
}

/** 导出仅供单测：bridge 命令不得携带 env 前缀（bridge 不创建 services）。 */
export function buildResidentBridgeCommand(): string {
  return `${RESIDENT_SERVER_ENTRY} --resident-bridge`;
}

const DEFAULT_REMOTE_COMMAND_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 20;

/** 导出仅供单测：短命远端命令的等待/失败语义（非 0 退出或超时都按失败收口）。 */
export async function execRemoteCommandAndWait(
  backend: IRemoteBackend,
  command: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REMOTE_COMMAND_TIMEOUT_MS;
  const stream = await backend.exec(command);
  const stderrTail: string[] = [];
  stream.stderr.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString("utf-8"));
    if (stderrTail.length > STDERR_TAIL_LINES) {
      stderrTail.shift();
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      closeDisposable.dispose();
    };
    const closeDisposable = stream.onClose((code) => {
      cleanup();
      if (code !== 0) {
        reject(
          new Error(
            `Remote command failed (code ${code}): ${command}${stderrTail.length ? ` — ${stderrTail.join("").trimEnd()}` : ""}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

const RESIDENT_DAEMON_START_TIMEOUT_MS = 30_000;

/**
 * 常驻模式发起：先幂等确保 daemon 就绪（失败即连接失败，不存在半可用状态），
 * 再 exec bridge 作为 RPC 流。bridge 不携带 env 前缀——它不创建 services。
 */
export async function launchResidentBridge(
  backend: IRemoteBackend,
  remoteRuntimeEnvPrefix: string,
  log: (...args: unknown[]) => void,
): Promise<Awaited<ReturnType<IRemoteBackend["exec"]>>> {
  log("ensuring resident daemon...");
  await execRemoteCommandAndWait(backend, buildResidentDaemonStartCommand(remoteRuntimeEnvPrefix), {
    timeoutMs: RESIDENT_DAEMON_START_TIMEOUT_MS,
  });
  log("resident daemon ready; launching stdio bridge...");
  return await backend.exec(buildResidentBridgeCommand());
}
