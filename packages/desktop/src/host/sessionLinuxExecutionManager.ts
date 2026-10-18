/**
 * 会话级本机 Linux 执行 — window Host 管理器。
 *
 * 规格见 docs/research/session-linux-execution.spec.md：
 * - Host 管理临时连接池 + 每聊天 lease/generation；Linux 端通过标准
 *   'session-linux-execution' typed channel 提供 prepare/run/poll/cancel/... 操作。
 * - connect 依赖注入（sessionLinuxConnection helper），manager 不 import Host index，
 *   不做任何静默本地 fallback：未准备/断连一律 ok:false 明确错误码。
 * - execute 是 SessionExecutionExecutor 的实现（services/zcode-agent/sessionExecutionBridge），
 *   由 Host index 接线到 interaction/sessionExecution 反向 RPC。
 */
import type { ChannelClient } from "@zcode/rpc";
import type {
  SessionExecutionLease,
  ZCodeSessionExecutionParams,
  ZCodeSessionExecutionResult,
} from "@zcode/shared";
import type {
  SessionLinuxConnectProgress,
  SessionLinuxConnectTarget,
  SessionLinuxRemoteConnection,
} from "./sessionLinuxConnection.js";

export type { SessionLinuxConnectTarget };

/** deps.connect：Host wrapper 闭包合并 msg.sessionExecutionRemoteAssets 与 asset/runtime network。 */
export type SessionLinuxManagerConnect = (
  target: SessionLinuxConnectTarget,
  options: Omit<
    Parameters<typeof import("./sessionLinuxConnection.js").connectSessionLinux>[1],
    "assets"
  >,
) => Promise<SessionLinuxRemoteConnection>;

export interface SessionLinuxExecutionManagerDeps {
  connect: SessionLinuxManagerConnect;
}

export type SessionExecutionWorkspace = {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
};

interface PreparedLease {
  sessionId: string;
  lease: { leaseId: string; generation: number };
  targetKey: string;
}

interface PooledConnection {
  connection: SessionLinuxRemoteConnection;
  /** onClose 结算句柄：把该连接全部 pending 结算为失败。 */
  settle: () => void;
}

function operationError(
  code: Extract<ZCodeSessionExecutionResult, { ok: false }>["code"],
  message: string,
): ZCodeSessionExecutionResult {
  return { ok: false, code, message };
}

function targetKeyOf(target: SessionLinuxConnectTarget): string {
  return `${target.kind}:${target.distro ?? ""}:${target.user ?? ""}`;
}

/** abort 时抢先拒绝（原 promise 的迟到结果由调用方补 release，见 prepare 分支）。 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "aborted")),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function createSessionLinuxExecutionManager(deps: SessionLinuxExecutionManagerDeps): {
  execute: (
    params: ZCodeSessionExecutionParams,
    workspace: SessionExecutionWorkspace,
    signal?: AbortSignal,
  ) => Promise<ZCodeSessionExecutionResult>;
  disposeAndWait: (timeoutMs?: number) => Promise<void>;
} {
  const connections = new Map<string, PooledConnection>();
  const leases = new Map<string, PreparedLease>(); // sessionId → lease
  const pending = new Set<Promise<unknown>>();
  const leasesByConnection = new Map<string, Set<string>>(); // targetKey → sessionIds
  /** 在途 prepare 的取消句柄：cancelExecutionEnvironmentPreparation 中止部署/抢先结算。 */
  const prepareControllers = new Map<string, AbortController>();
  let disposed = false;

  const ensureConnection = async (
    target: SessionLinuxConnectTarget,
    signal: AbortSignal | undefined,
  ): Promise<PooledConnection> => {
    const key = targetKeyOf(target);
    const existing = connections.get(key);
    if (existing && !disposed) {
      return existing;
    }
    if (disposed) {
      throw new Error("Session Linux execution manager is disposed");
    }
    let settle!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const connection = await deps.connect(target, {
      signal,
      onProgress: (_phase: SessionLinuxConnectProgress) => {
        // 进度由 Host wrapper/UI 订阅；manager 只透传，不做展示。
      },
      onClose: () => {
        connections.delete(key);
        // 断连结算：该连接的全部 lease 失效（execute 立即失败，不回落）。
        for (const sessionId of leasesByConnection.get(key) ?? []) {
          leases.delete(sessionId);
        }
        leasesByConnection.delete(key);
        settle();
      },
    });
    const pooled: PooledConnection = { connection, settle };
    connections.set(key, pooled);
    void closedPromise;
    return pooled;
  };

  const trackPending = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise
      .catch(() => undefined) // 结算侧已有 try/catch；这里仅防 unhandled rejection。
      .finally(() => pending.delete(promise));
    return promise;
  };

  const callChannelByTarget = async <T>(
    target: SessionLinuxConnectTarget,
    signal: AbortSignal | undefined,
    command: string,
    args: unknown,
  ): Promise<T> => {
    const pooled = await ensureConnection(target, signal);
    if (disposed) {
      throw new Error("Session Linux execution manager is disposed");
    }
    if (signal?.aborted) {
      throw new Error("Session Linux execution aborted");
    }
    const client: ChannelClient = pooled.connection.client;
    const channel = client.getChannel("session-linux-execution");
    return channel.call<T>(command, args);
  };

  /** 已有连接上的调用：按 targetKey 寻址，绝不隐式新建连接。 */
  const callExisting = async <T>(
    targetKey: string,
    signal: AbortSignal | undefined,
    command: string,
    args: unknown,
  ): Promise<T> => {
    const pooled = connections.get(targetKey);
    if (!pooled) {
      throw new Error(`connection closed: ${targetKey}`);
    }
    if (disposed) {
      throw new Error("Session Linux execution manager is disposed");
    }
    if (signal?.aborted) {
      throw new Error("Session Linux execution aborted");
    }
    const client: ChannelClient = pooled.connection.client;
    const channel = client.getChannel("session-linux-execution");
    return channel.call<T>(command, args);
  };

  const environmentUnavailable = (message: string): ZCodeSessionExecutionResult =>
    operationError("environment_unavailable", message);

  const execute = async (
    params: ZCodeSessionExecutionParams,
    workspace: SessionExecutionWorkspace,
    signal?: AbortSignal,
  ): Promise<ZCodeSessionExecutionResult> => {
    if (disposed) {
      return operationError("backend_unavailable", "Session Linux execution manager is disposed");
    }
    // prepare 是 lease 生命周期入口：workspacePath 是 Windows 真源。
    if (params.operation === "prepare") {
      const target: SessionLinuxConnectTarget =
        params.environment.kind === "wsl"
          ? { kind: "wsl", distro: params.environment.distro ?? "", user: params.environment.user }
          : { kind: "wsl", distro: "", user: undefined };
      if (!target.distro) {
        return environmentUnavailable("WSL distro is not configured for this session");
      }
      // 反向 RPC 不携带 AbortSignal；取消经 cancelExecutionEnvironmentPreparation 操作
      // 中止本 controller（部署阶段由 connect 的 signal 真正打断，通道调用阶段由 race 抢先结算）。
      const controller = new AbortController();
      if (signal) {
        if (signal.aborted) {
          controller.abort(signal.reason);
        } else {
          signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
        }
      }
      const prior = prepareControllers.get(params.sessionId);
      if (prior) {
        prior.abort(new Error("superseded by a newer preparation"));
      }
      prepareControllers.set(params.sessionId, controller);
      const callPromise = trackPending(
        callChannelByTarget<Extract<ZCodeSessionExecutionResult, { ok: true }>>(
          target,
          controller.signal,
          "prepare",
          params,
        ),
      );
      // 取消后迟到的 prepare 成功必须补 release，否则通道侧 lease 泄漏。
      void callPromise
        .then((late) => {
          if (
            !controller.signal.aborted ||
            !late ||
            late.ok !== true ||
            late.operation !== "prepare"
          ) {
            return;
          }
          return trackPending(
            callChannelByTarget<unknown>(target, undefined, "release", {
              operation: "release",
              sessionId: params.sessionId,
              lease: late.prepare.lease,
            }),
          ).catch(() => undefined);
        })
        .catch(() => undefined);
      try {
        const result = await raceWithAbort(callPromise, controller.signal);
        if (!result || result.ok !== true || result.operation !== "prepare") {
          return environmentUnavailable("prepare returned an unexpected payload");
        }
        const key = targetKeyOf(target);
        leases.set(params.sessionId, {
          sessionId: params.sessionId,
          lease: result.prepare.lease,
          targetKey: key,
        });
        const sessions = leasesByConnection.get(key) ?? new Set<string>();
        sessions.add(params.sessionId);
        leasesByConnection.set(key, sessions);
        return result;
      } catch (error) {
        if (
          controller.signal.aborted ||
          signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return operationError(
            "cancelled",
            error instanceof Error ? error.message : String(error),
          );
        }
        return environmentUnavailable(
          error instanceof Error ? error.message : "WSL execution environment is unavailable",
        );
      } finally {
        if (prepareControllers.get(params.sessionId) === controller) {
          prepareControllers.delete(params.sessionId);
        }
      }
    }

    // 取消进行中的 prepare：中止部署/抢先结算，不提交任何 lease。幂等（无在途准备也成功）。
    if (params.operation === "cancelExecutionEnvironmentPreparation") {
      prepareControllers
        .get(params.sessionId)
        ?.abort(new Error("execution environment preparation cancelled"));
      // state 的权威投影在 CLI（配置 owner）；manager 仅确认中断，回显占位 idle，CLI 侧丢弃该字段。
      return {
        ok: true,
        operation: "cancelExecutionEnvironmentPreparation",
        state: { status: "idle", environment: { kind: "local" } },
      };
    }

    // releaseSession 是会话级回收（agent 退出/切换提交后）：不要求现存 lease，幂等成功；
    // 不注入 lease 字段（strict schema 仅 operation+sessionId）。
    if (params.operation === "releaseSession") {
      const record = leases.get(params.sessionId);
      try {
        if (record && connections.has(record.targetKey)) {
          await trackPending(
            callExisting<unknown>(record.targetKey, signal, "releaseSession", {
              operation: "releaseSession",
              sessionId: params.sessionId,
            }),
          );
        }
        leases.delete(params.sessionId);
        if (record) {
          leasesByConnection.get(record.targetKey)?.delete(params.sessionId);
        }
        return { ok: true, operation: "releaseSession" };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          return operationError(
            "cancelled",
            error instanceof Error ? error.message : String(error),
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("disposed") || message.includes("closed")) {
          leases.delete(params.sessionId);
          return operationError("environment_unavailable", message);
        }
        return operationError("internal", message);
      }
    }

    // 其余操作需要有效 lease（旧代/断连后失效）。
    const lease = leases.get(params.sessionId);
    if (!lease) {
      return operationError(
        "lease_rejected",
        "no active WSL lease for this session; run prepare first",
      );
    }
    if (!connections.has(lease.targetKey)) {
      leases.delete(params.sessionId);
      return operationError(
        "environment_unavailable",
        "WSL execution connection is closed; run prepare again",
      );
    }

    // 注入 lease 到需要它的操作。
    const withLease = (): Record<string, unknown> => {
      const payload = params as unknown as Record<string, unknown>;
      return { ...payload, sessionId: params.sessionId, lease: lease.lease };
    };

    try {
      switch (params.operation) {
        case "release": {
          // release 必须尊重请求里携带的 lease：会话槽里可能已经换成新代 lease（prepare 覆盖），
          // 释放旧代 lease 绝不能把新 lease 从槽里删掉，否则后续执行全 lease_rejected
          // （真实实例实测：取消后被取消的 set 回收旧 lease → 新 lease 被误删 → Bash 全失败）。
          const requestedLease = (params as unknown as { lease?: SessionExecutionLease }).lease;
          const releaseLease = requestedLease ?? lease.lease;
          await trackPending(
            callExisting<unknown>(lease.targetKey, signal, "release", {
              ...(params as unknown as Record<string, unknown>),
              sessionId: params.sessionId,
              lease: releaseLease,
            }),
          );
          if (requestedLease === undefined || requestedLease.leaseId === lease.lease.leaseId) {
            leases.delete(params.sessionId);
            leasesByConnection.get(lease.targetKey)?.delete(params.sessionId);
          }
          return { ok: true, operation: "release" };
        }
        case "run":
        case "start":
        case "poll":
        case "cancel":
        case "readBackground":
        case "getBackgroundTask":
        case "cancelBackgroundTask":
        case "bashBackgroundLifecycle": {
          const result = await trackPending(
            callExisting<Extract<ZCodeSessionExecutionResult, { ok: true }>>(
              lease.targetKey,
              signal,
              params.operation,
              withLease(),
            ),
          );
          return result;
        }
        default: {
          // exhaustiveness guard：新操作必须显式处理，不允许静默透传。
          return operationError(
            "internal",
            `unsupported session execution operation: ${String((params as { operation?: string }).operation)}`,
          );
        }
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return operationError("cancelled", error instanceof Error ? error.message : String(error));
      }
      const message = error instanceof Error ? error.message : String(error);
      // 断连/lease 失效按码映射；其余为 internal。
      if (message.includes("disposed") || message.includes("closed")) {
        leases.delete(params.sessionId);
        connections.delete(lease.targetKey);
        return operationError("environment_unavailable", message);
      }
      return operationError("internal", message);
    }
  };

  const disposeAndWait = async (timeoutMs = 10_000): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const controller of prepareControllers.values()) {
      controller.abort(new Error("Session Linux execution manager is disposed"));
    }
    prepareControllers.clear();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    const drain = (async () => {
      while (pending.size > 0) {
        await Promise.allSettled(pending);
      }
    })();
    await Promise.race([drain, timeout]);
    const closing = [...connections.values()].map((pooled) =>
      pooled.connection.disposeAndWait?.().catch(() => undefined),
    );
    connections.clear();
    leases.clear();
    leasesByConnection.clear();
    await Promise.race([Promise.all(closing), timeout]);
  };

  return { execute, disposeAndWait };
}
