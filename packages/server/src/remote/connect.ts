import { SocketProtocol, ChannelClient, ChannelServer, type IServerChannel } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  formatLogPrefix,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { wrapStdioStream } from "./stdio-socket.js";
import { performHandshake } from "./handshake.js";
import { deployServer } from "./deploy.js";
import type { DeployOptions } from "./deploy.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { formatWslProxyForLog } from "./wslProxy.js";
import { launchResidentBridge } from "./resident-connect.js";
import {
  buildRemoteRuntimeEnvPrefix,
  buildRemoteServerCommand,
  type RemoteRuntimeEnv,
  type RemoteRuntimeEnvKey,
  type RemoteRuntimeNetworkOptions,
} from "./server-command.js";

// 公开类型原从 connect.ts 导出（remote/index.ts 与桌面 host 依赖），拆分后原位再导出保持兼容。
export type { RemoteRuntimeEnv, RemoteRuntimeEnvKey, RemoteRuntimeNetworkOptions };
// 公开函数原从 connect.ts 导出；拆分后原位再导出保持兼容。
export { pickRemoteRuntimeEnv } from "./server-command.js";

const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** 仅 Desktop Host 注入，复用当前 stdio 的私有反向资源频道。 */
  topicResourceChannel?: IServerChannel;
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** 桌面 app 版本；用于透传给远端 agent，让模型请求 header 能标识发起方版本 */
  appVersion?: string;
  /** 远端 server/agent 需要继承的非敏感产品环境变量；调用方可传较宽的 env，server 侧会按白名单过滤。 */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Desktop Host 为 desktop-attached WSL server 提供的显式 Agent 网络配置。 */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** 远端 stdio 关闭后的回调（用于上层感知断连并触发回收） */
  onDidRemoteClose?: (event: { code: number }) => void;
  /**
   * 常驻模式：远端 server 以独立 daemon 运行（规格见 ./specs/remote-resident-server.md）。
   * 桌面断开只释放连接与订阅，远端任务继续执行；重连经 --resident-start 幂等接回。
   * 缺省 false = 既有 stdio 会话模式，行为零变化。
   */
  resident?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
  /** 常驻模式连接：断开 ≠ 远端任务终止，桌面侧据此区分离离线与失败。 */
  resident: boolean;
}

function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}

/**
 * Connect to a remote zcode server via an IRemoteBackend.
 *
 * Steps:
 * 1. detect() → { platform, arch }
 * 2. Deploy if needed (upload node + server bundle + node-pty)
 * 3. exec server command
 * 4. Handshake (read hello, send ack)
 * 5. Wrap stdio → ISocket → SocketProtocol → ChannelClient → RemoteServiceAccess
 */
export async function connectRemote(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const signal = options?.signal;
  let backendDisposed = false;
  const disposeBackendOnce = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    backend.dispose();
  };
  if (signal?.aborted) {
    disposeBackendOnce();
    throw createRemoteConnectAbortError(signal);
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    const connecting = connectRemoteUnchecked(backend, options);
    if (!signal) {
      return await connecting;
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        // 窗口 Host 合并后不能再通过杀独立 SSH Host 进程来取消连接；如果这里只
        // 结束 logical waiter，detect/deploy/upload 会继续占用旧凭据和连接。连接初始化尚未
        // 对外发布，可以安全释放它独占的 backend，并让调用方立即结束等待。
        disposeBackendOnce();
        reject(createRemoteConnectAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const guardedConnecting = connecting.then((connection) => {
      if (signal.aborted) {
        connection.dispose();
        throw createRemoteConnectAbortError(signal);
      }
      return connection;
    });
    return await Promise.race([guardedConnecting, aborted]);
  } catch (error) {
    // detect/deploy/handshake 任一步失败时尚未返回 RemoteConnection，调用方无从 dispose backend。
    disposeBackendOnce();
    throw error;
  } finally {
    removeAbortListener();
  }
}

async function connectRemoteUnchecked(
  backend: IRemoteBackend,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const clientId = options?.clientId ?? `desktop-${Date.now()}`;

  const log = (...args: unknown[]) =>
    console.log(formatLogPrefix("connectRemote", process.pid), ...args);

  // 1. Detect remote environment
  log("detecting remote env...");
  const env = await backend.detect();
  throwIfRemoteConnectAborted(options?.signal);
  log("detected:", env);
  assertSupportedRemoteEnvironment(env);

  const remoteRuntimeNetwork = await resolveRemoteRuntimeNetwork(
    backend,
    options?.remoteRuntimeNetwork,
    log,
  );

  // 2. Deploy server if needed
  if (!options?.skipDeploy) {
    log("deploying server...");
    await deployServer(backend, env, options);
    throwIfRemoteConnectAborted(options?.signal);
    log("deploy complete");
  }

  // 3. Launch server
  log("launching remote server...");
  const resident = options?.resident === true;
  // 常驻依赖本仓库远端 server bundle 的 resident 入口；「远端服务器下载」拉取的是官方产物，
  // 没有这些改动。这里 fail-fast 并给出明确改法，而不是让远端启动到一半才报未知错误。
  if (resident && options?.assetInstallMode === "remote-download") {
    throw new Error(
      "[connect] 常驻运行不支持「远端服务器下载」资源方式：该模式拉取 ZCode 官方产物，" +
        "不含本定制版的 resident 入口。请把资源方式改为「本地上传（随包资源）」后再使用常驻运行。",
    );
  }
  const remoteRuntimeEnvPrefix = buildRemoteRuntimeEnvPrefix(options, remoteRuntimeNetwork);
  const stream = resident
    ? await launchResidentBridge(backend, remoteRuntimeEnvPrefix, log)
    : await backend.exec(buildRemoteServerCommand(remoteRuntimeEnvPrefix));
  throwIfRemoteConnectAborted(options?.signal);
  log("remote server exec started");

  // Forward stderr for debugging
  stream.stderr.on("data", (chunk: Buffer) => {
    // 远端 zcode-server 的服务日志走 stderr，直接写 host stderr 时可能被结构化日志中继吞掉。
    // 这里转成 host 的 console 日志，让 remote sqlite 初始化/锁冲突日志能稳定出现在连接日志面板和启动终端。
    console.log(`[remote] ${chunk.toString().trimEnd()}`);
  });

  // 4. Handshake
  log("performing handshake...");
  const { hello, remaining } = await performHandshake(stream, clientId, options?.handshakeTimeout);
  throwIfRemoteConnectAborted(options?.signal);
  log("handshake done, server version:", hello.version);

  // 5. Wrap into RPC channel
  // If there's remaining data from handshake, push it back to the stream
  // so it gets picked up by wrapStdioStream's data listener
  if (remaining && remaining.length > 0) {
    (stream.stdout as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(remaining);
  }

  const socket = wrapStdioStream(stream);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const reverseServer = options?.topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && options?.topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, options.topicResourceChannel);
  const services = new RemoteServiceAccess(client);
  let hasReportedRemoteClose = false;
  let hasStreamClosed = false;
  let resolveStreamClosed!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    resolveStreamClosed = resolve;
  });
  const reportRemoteClose = (code: number) => {
    if (hasReportedRemoteClose) {
      return;
    }
    hasReportedRemoteClose = true;
    options?.onDidRemoteClose?.({ code });
  };

  const backendDisconnectDisposable = backend.onDidDisconnect?.((event) => {
    // SSH keepalive 发现半开连接时，远端 server stdio channel 未必立刻 close。
    // 这里把 backend 断连并入同一条关闭上报链路，让 host/main/UI 复用既有 session-close 收口。
    const errorMessage = event.error?.message;
    log(
      errorMessage
        ? `remote backend disconnected: ${event.reason}: ${errorMessage}`
        : `remote backend disconnected: ${event.reason}`,
    );
    reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE);
  });
  const streamCloseDisposable = stream.onClose((code) => {
    hasStreamClosed = true;
    resolveStreamClosed();
    reportRemoteClose(code);
  });

  let disposalStarted = false;
  let backendDisposed = false;
  let disposeAndWaitInFlight: Promise<void> | null = null;
  const beginDisposal = () => {
    if (disposalStarted) {
      return;
    }
    disposalStarted = true;
    backendDisconnectDisposable?.dispose();
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    // stdin.end 必须在任何 await 之前同步触发，让远端 stdio server 立即收到 EOF。
    socket.dispose();
  };
  const disposeBackend = () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    backend.dispose();
  };
  const disposeBackendAndWait = async () => {
    if (backendDisposed) {
      return;
    }
    backendDisposed = true;
    streamCloseDisposable.dispose();
    if (backend.disposeAndWait) {
      await backend.disposeAndWait();
      return;
    }
    backend.dispose();
  };

  return {
    services,
    client,
    resident,
    dispose() {
      beginDisposal();
      disposeBackend();
    },
    disposeAndWait(disposeOptions) {
      if (disposeAndWaitInFlight) {
        return disposeAndWaitInFlight;
      }
      beginDisposal();
      if (backendDisposed || hasStreamClosed) {
        disposeBackend();
        return Promise.resolve();
      }

      const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
      disposeAndWaitInFlight = (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
        });
        const result = await Promise.race([streamClosed.then(() => "closed" as const), deadline]);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (result === "timed-out") {
          log(`remote stdio close timed out after ${timeoutMs}ms`);
        }
        await disposeBackendAndWait();
      })();
      return disposeAndWaitInFlight;
    },
  };
}

async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // 只有实现了远端代理解析能力的 WSL backend 才接收这条权威网络边界；
    // SSH/Docker 即使误传 options 也保持原有启动命令。
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // 代理解析只是运行时增强；解析失败时沿用设置页原值，避免把 WSL 本地工作区变成不可连接。
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}
