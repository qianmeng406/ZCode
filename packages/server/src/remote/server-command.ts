// ============================================================
// Remote server launch command construction: runtime env allowlist,
// stdio and resident daemon command builders.
// 从 connect.ts 拆出：命令构造是纯字符串装配，与连接生命周期无关；
// 常驻模式复用同一 env 前缀（规格见 ../specs/remote-resident-server.md）。
// ============================================================
import {
  ZCODE_APP_VERSION_ENV,
  SERVICE_AUTHORITY_MODE_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import { quotePosixShellArg } from "./posixShell.js";

const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  // 由 Desktop Main 计算并下发；远端 server 只消费，不重新计算。
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // 同上：本地覆盖由 Desktop Main 按构建档位写定（buildHostProcessEnv），
  // 透传后 SSH/WSL/Docker 远端 Host 与本地 Host 得到同一档位。
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** 只允许 Host 设置权威值覆盖远端自身的旧设置。 */
  authoritative?: boolean;
}

/** 供单测断言 connect.ts 的 ConnectOptions 形状约束（结构子集即可）。 */
export interface RemoteCommandOptions {
  appVersion?: string;
  remoteRuntimeEnv?: Record<string, string | undefined>;
}

/** stdio 会话模式命令：env 前缀与入口拼接，字段与顺序不变（I5 回归锚点）。 */
export function buildRemoteServerCommand(remoteRuntimeEnvPrefix: string): string {
  return `${remoteRuntimeEnvPrefix} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`;
}

/**
 * 常驻与 stdio 模式共用同一运行时 env 前缀：daemon 由该 env 启动，bridge 不需要。
 */
export function buildRemoteRuntimeEnvPrefix(
  options: RemoteCommandOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // 远端 server 是通过 SSH/WSL/Docker 单独启动的，不会继承桌面 host env。
    // 这里显式把 app 版本作为远端进程 env 注入，远端 agent 才能在模型请求 header 中带上版本。
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return envParts.join(" ");
}
