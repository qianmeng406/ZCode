import { ZCODE_VERSION, type WSLConnectOptions } from "@zcode/shared";
import type { ConnectOptions, IRemoteBackend, RemoteConnection } from "@zcode/server/remote";

export type SessionLinuxConnectProgress = "checking" | "deploying" | "handshaked";
export type SessionLinuxConnectTarget = WSLConnectOptions;
export type SessionLinuxRemoteConnection = Pick<
  RemoteConnection,
  "client" | "dispose" | "disposeAndWait"
>;
export type SessionLinuxRemoteAssets = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;

type RemoteLoader = () => Promise<{
  createRemoteBackend(target: WSLConnectOptions): Promise<IRemoteBackend>;
  connectRemote(backend: IRemoteBackend, options: ConnectOptions): Promise<RemoteConnection>;
}>;

function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function connectSessionLinux(
  target: SessionLinuxConnectTarget,
  options: {
    assets: SessionLinuxRemoteAssets;
    signal?: AbortSignal;
    onProgress?: (phase: SessionLinuxConnectProgress) => void;
    onClose?: () => void;
    remoteAssetNetwork?: ConnectOptions["remoteAssetNetwork"];
    remoteRuntimeNetwork?: ConnectOptions["remoteRuntimeNetwork"];
  },
  deps: { loadRemote?: RemoteLoader } = {},
): Promise<SessionLinuxRemoteConnection> {
  const { assets, signal } = options;
  checkCancelled(signal);
  if (
    !assets.mockCdnDir &&
    !(assets.remoteCacheDir && (assets.remoteCdnBaseUrl || assets.remoteCdnBaseUrls?.length))
  ) {
    throw new Error("Session Linux runtime assets unavailable");
  }
  options.onProgress?.("checking");
  // 与普通本机会话隔离加载 ssh2 等远端依赖，避免可选功能影响默认启动。
  const remote = await (deps.loadRemote?.() ?? import("@zcode/server/remote"));
  checkCancelled(signal);
  const backend = await remote.createRemoteBackend(target);
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    options.onClose?.();
  };
  options.onProgress?.("deploying");
  // connectRemote owns backend cleanup on cancellation, deploy failure and normal disposal.
  const connection = await remote.connectRemote(backend, {
    ...assets,
    signal,
    remoteAssetNetwork: options.remoteAssetNetwork,
    remoteRuntimeNetwork: options.remoteRuntimeNetwork,
    appVersion: ZCODE_VERSION,
    resident: false,
    onDidRemoteClose: onClose,
  });
  if (signal?.aborted || closed) {
    await connection.disposeAndWait();
    checkCancelled(signal);
    throw new Error("Session Linux connection closed during preparation");
  }
  options.onProgress?.("handshaked");
  return connection;
}
