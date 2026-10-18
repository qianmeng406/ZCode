// ============================================================
// 会话级执行端口绑定（session-linux-execution）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md「切换 admission」：
// "锁定 session admission 后准备新 lease，装配本会话新 App/端口，保留同一 session
// 历史、模型、权限与配置；成功后提交配置并释放旧 lease。"
//
// 事实约束：会话 App 在 create/resume 时一次性构造，工具层（Bash / Write / Read /
// 子代理 / 后台任务）在构造期捕获 ExecutionPort 与 FileSystemPort 两个稳定对象。
// 若切换环境时重建 App，会重放模型/权限/MCP/标题等装配，破坏「保留模型/权限/配置」。
// 因此这里不重建 App，而是把两个「稳定门面」交给 App，切换时只替换门面内部当前
// 生效的真实端口：
//   - WSL 目标：ExecutionPort → 借用路由端口（lease/generation 鉴权，经 Host 转发到
//     WSL 执行端），FileSystemPort → WSL UNC 适配器（POSIX 绝对路径落到真实 ext4，
//     与同一路径的 Linux Bash 是同一文件）；
//   - 本地目标：回到 App 本地解析出的 NodeExecutionAdapter / NodeFileSystemAdapter。
//
// 门面用 Proxy 逐属性转发到「当前生效端口」，可选能力（start / getBackgroundTask /
// waitForBackgroundTask / runBashWithBackgroundLifecycle …）因此在两种模式下按真实
// 实现呈现在场，core 的能力探测（typeof port.x === "function"）语义不变。
//
// 所有权：门面 close() 释放借用的 WSL lease 并关闭本地端口；切换时旧的 WSL lease
// 一并释放（尽力而为），失败由 Host 的 generation 失效兜底。

import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import type { SessionExecutionLease } from "@zcode/shared";
import { createWslFileSystemAdapter } from "@zcode/adapters/fs";
import { createSessionExecutionRoutingPort } from "./session-execution-routing-port.js";

/** 已准备并提交的 WSL 借用目标（lease 由 Host 记账，配置只落 kind/distro/user）。 */
export interface SessionExecutionBorrowedWsl {
  lease: SessionExecutionLease;
  capabilities: { bashBackgroundLifecycle: boolean; embeddedSearchNative: boolean };
  distro: string;
}

export interface SessionExecutionLocalPorts {
  executionPort: ExecutionPort;
  fileSystemPort: FileSystemPort;
}

/**
 * 会话级执行端口绑定：稳定门面 + 可切换的真实端口。
 * 一个绑定只服务一个会话，随 App 生命周期存活。
 */
export interface SessionExecutionPortBinding {
  /** 稳定执行门面（App 构造期注入，切换不换身份）。 */
  readonly executionPort: ExecutionPort;
  /** 稳定文件系统门面（同上）。 */
  readonly fileSystemPort: FileSystemPort;
  /** create-app 解析出本地端口后回填（本地目标下的真实执行/文件端口）。 */
  attachLocalPorts(ports: SessionExecutionLocalPorts): void;
  /** 切到已提交的 WSL 目标；释放上一借用 lease（尽力而为）。 */
  activateWsl(target: SessionExecutionBorrowedWsl): void;
  /** 切回本地执行；释放借用 lease（尽力而为）。 */
  activateLocal(): Promise<void>;
  /** 当前是否处于 WSL 借用目标。 */
  isWslActive(): boolean;
}

export interface SessionExecutionPortBindingOptions {
  sessionId: string;
  /**
   * 单次 typed channel 操作：发送 params 并返回已校验结果封套内容。
   * lease 由本绑定按当前目标注入（调用方只构造业务字段）。
   */
  send(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 构造 WSL 文件系统适配器；缺省用 WSL UNC 适配器（测试可注入替身）。 */
  createWslFileSystemPort?(distro: string): FileSystemPort;
}

export function createSessionExecutionPortBinding(
  options: SessionExecutionPortBindingOptions,
): SessionExecutionPortBinding {
  const { sessionId, send } = options;
  const createWslFileSystemPort =
    options.createWslFileSystemPort ?? ((distro: string) => createWslFileSystemAdapter({ distro }));
  let localExecutionPort: ExecutionPort | undefined;
  let localFileSystemPort: FileSystemPort | undefined;
  let wslExecutionPort: ExecutionPort | undefined;
  let wslFileSystemPort: FileSystemPort | undefined;

  const requireExecution = (): ExecutionPort => {
    const port = wslExecutionPort ?? localExecutionPort;
    if (!port) throw new Error("session execution port is not assembled for this session");
    return port;
  };
  const requireFileSystem = (): FileSystemPort => {
    const port = wslFileSystemPort ?? localFileSystemPort;
    if (!port) throw new Error("session file system port is not assembled for this session");
    return port;
  };
  const releaseBorrowed = async (): Promise<void> => {
    const port = wslExecutionPort;
    wslExecutionPort = undefined;
    wslFileSystemPort = undefined;
    if (port?.close) await port.close().catch(() => undefined);
  };

  /**
   * 宿主路径 → 当前目标可用路径。本地目标：原值（执行环境即宿主）。
   * WSL 目标：交执行端 `wslpath -u`（与 channel 的 cwd 映射同一权威来源）；
   * 执行端返回非绝对路径或调用失败时返回 null——调用方必须显式失败，不回落宿主路径。
   */
  const translateHostPathForActiveTarget = async (path: string): Promise<string | null> => {
    const port = wslExecutionPort;
    if (!port) {
      return path;
    }
    try {
      const probe = await port.run({
        command: { mode: "argv", file: "wslpath", args: ["-u", path] },
      });
      const mapped = probe.stdout?.text?.trim() ?? "";
      if (probe.status !== "completed" || !mapped.startsWith("/")) {
        return null;
      }
      return mapped;
    } catch {
      return null;
    }
  };

  // 执行门面：逐属性转发到当前生效端口；close 归本绑定（释放借用 lease + 关本地端口）。
  // translateHostPath 由门面自己实现：本地目标下宿主路径就是执行路径（原值），
  // WSL 目标下必须走执行端 wslpath——不做字符串猜测，映射失败返回 null 由调用方显式失败。
  const executionPort = new Proxy({} as ExecutionPort, {
    get: (_target, property) => {
      if (property === "close") {
        return async () => {
          await releaseBorrowed();
          await localExecutionPort?.close?.().catch(() => undefined);
        };
      }
      if (property === "translateHostPath") {
        return async (path: string) => translateHostPathForActiveTarget(path);
      }
      const source = requireExecution() as unknown as Record<PropertyKey, unknown>;
      const value = source[property];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(source)
        : value;
    },
  });

  // 文件系统门面：逐属性转发到当前生效的 FS 适配器。
  const fileSystemPort = new Proxy({} as FileSystemPort, {
    get: (_target, property) => {
      const source = requireFileSystem() as unknown as Record<PropertyKey, unknown>;
      const value = source[property];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(source)
        : value;
    },
  });

  return {
    executionPort,
    fileSystemPort,
    attachLocalPorts(ports) {
      localExecutionPort = ports.executionPort;
      localFileSystemPort = ports.fileSystemPort;
    },
    activateWsl(target) {
      const previous = wslExecutionPort;
      wslExecutionPort = createSessionExecutionRoutingPort({
        sessionId,
        lease: target.lease,
        capabilities: target.capabilities,
        channel: {
          execute: (params) => send(params),
          release: async () => {
            await send({ operation: "release", sessionId, lease: target.lease }).catch(
              () => undefined,
            );
          },
        },
      });
      wslFileSystemPort = createWslFileSystemPort(target.distro);
      // 释放上一借用 lease：Host manager 的 release 只按请求携带的 lease 释放端口，
      // 仅当它就是会话当前 lease 时才清槽——因此释放旧代不会误删新 prepare 的 lease
      // （manager 侧已按 lease 身份收窄；见 sessionLinuxExecutionManager.release 分支）。
      if (previous && previous !== wslExecutionPort) {
        void previous.close?.().catch(() => undefined);
      }
    },
    async activateLocal() {
      await releaseBorrowed();
    },
    isWslActive() {
      return wslExecutionPort !== undefined;
    },
  };
}
