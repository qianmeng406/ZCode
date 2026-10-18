/* oxlint-disable eslint(max-lines) -- channel 同时承载 strict wire 校验、lease 生命周期、
 * 执行编排与序列化；按 wsl-backend.ts 的先例整体承载，不再垂直拆分。 */
/**
 * 会话级本机 Linux 执行端 channel（server 侧，运行在 WSL 内的持久 stdio server 上）。
 *
 * 规格见 docs/research/session-linux-execution.spec.md。
 * wire 契约：packages/shared/src/sessionExecutionWire.ts（strict zod，Date→*AtMs、
 * Uint8Array→base64、不跨 RPC 传 signal/function/Error 实例）。
 *
 * - 标准 Channel RPC channel（'session-linux-execution'），不是文本协议，不做每命令 wsl.exe。
 * - 执行端复用 @zcode/adapters/exec 的 NodeExecutionAdapter（ExecutionPort）。
 * - 所有操作校验 sessionId + lease + generation（+ executionId），旧代拒绝。
 * - scope 校验不靠 cwd：显式校验解析后的 Linux cwd 落在授权工作区内。
 * - sandbox fail-closed：无法实现等效策略时拒绝执行，不删除 policy。
 * - internal-cli prelude（Windows Electron helper）不得进入 Linux；Linux 端
 *   native-binaries/argv0-dispatch 可重建，internal-cli 由 Host 转换或拒绝。
 * - 该 channel 不是 ServiceCollection 资源：dispose 由 entry/stdio lifecycle 显式 barrier。
 */
import { Emitter, type IServerChannel } from "@zcode/rpc";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import type {
  BackgroundExecutionSnapshot,
  ExecutionEvent,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  SessionId,
} from "@zcode/contracts";
import { createTraceId } from "@zcode/contracts";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import {
  sessionExecutionPrepareParamsSchema,
  sessionExecutionReleaseParamsSchema,
  sessionExecutionReleaseSessionParamsSchema,
  sessionExecutionRunParamsSchema,
  sessionExecutionStartParamsSchema,
  sessionExecutionPollParamsSchema,
  sessionExecutionCancelParamsSchema,
  sessionExecutionReadBackgroundParamsSchema,
  sessionExecutionGetBackgroundTaskParamsSchema,
  sessionExecutionCancelBackgroundTaskParamsSchema,
  sessionExecutionBashBackgroundLifecycleParamsSchema,
  sessionExecutionPrepareResultSchema,
  type ExecutionWireRequest,
  type ExecutionWireResult,
  type ExecutionWireEvent,
  type ExecutionWireBackgroundStartResult,
  type ExecutionWireBackgroundSnapshot,
  type ExecutionWireBackgroundOutputResult,
  type ExecutionWireCommand,
} from "@zcode/shared";
import {
  SessionLinuxLeaseRegistry,
  SessionLinuxScopeError,
  type SessionLinuxWorkspaceMapping,
} from "./leaseRegistry.js";
import { PathMappingError, isLinuxCwdWithinWorkspace, mapWorkspacePaths } from "./pathMapping.js";

export const SESSION_LINUX_EXECUTION_CHANNEL = "session-linux-execution";

export type SessionLinuxErrorCode =
  | "invalid_request"
  | "unknown_lease"
  | "stale_generation"
  | "unknown_execution"
  | "lease_released"
  | "path_unmappable"
  | "path_not_found"
  | "path_not_directory"
  | "sandbox_unsupported"
  | "prelude_capability_unavailable"
  | "execution_failed"
  | "too_many_executions"
  | "adapter_close_timeout";

export class SessionLinuxChannelError extends Error {
  readonly code: SessionLinuxErrorCode;
  constructor(code: SessionLinuxErrorCode, message: string) {
    super(message);
    this.name = "SessionLinuxChannelError";
    this.code = code;
  }
}

const DEFAULT_MAX_ACTIVE_EXECUTIONS = 8;

/** registry scope 错误到 channel 错误的桥接（避免在工厂函数内声明 class）。 */
class ChannelScopeError extends Error {
  readonly code: "unknown_lease" | "stale_generation";
  constructor(code: "unknown_lease" | "stale_generation", message: string) {
    super(message);
    this.name = "ChannelScopeError";
    this.code = code;
  }
}

export interface CreateSessionLinuxExecutionChannelOptions {
  registry?: SessionLinuxLeaseRegistry;
  /** 测试注入；缺省用 @zcode/adapters/exec 真实适配器。 */
  createAdapter?: (options: { outputRootDir: string }) => ExecutionPort;
  managedRootOverride?: string;
  maxActiveExecutions?: number;
  log?: (...args: unknown[]) => void;
}

export interface SessionLinuxExecutionChannelHandle {
  channelName: typeof SESSION_LINUX_EXECUTION_CHANNEL;
  channel: IServerChannel;
  /** lifecycle barrier：终止全部 execution、释放 per-lease 资源、清理注册表。 */
  dispose: () => Promise<void>;
  /** 测试/诊断：直接访问注册表。 */
  registry: SessionLinuxLeaseRegistry;
}

/** 有界事件缓冲：每 execution 保留全部事件（含 chunk），poll 用 cursor 有界读取。 */
const MAX_EVENTS_PER_EXECUTION = 10_000;

interface ExecutionSessionState {
  executionId: string;
  leaseId: string;
  events: Array<{ wire: ExecutionWireEvent; timestampMs: number }>;
  result?: ExecutionResult;
  done: boolean;
  /** run 请求的完成 promise（run 等价 poll 到终态）。 */
  completion: Promise<void>;
  startedAtMs: number;
  isBackground: boolean;
  taskId?: string;
}

export function createSessionLinuxExecutionChannel(
  options: CreateSessionLinuxExecutionChannelOptions = {},
): SessionLinuxExecutionChannelHandle {
  const log = options.log ?? (() => undefined);
  const registry = options.registry ?? new SessionLinuxLeaseRegistry();
  const maxActiveExecutions = options.maxActiveExecutions ?? DEFAULT_MAX_ACTIVE_EXECUTIONS;

  const adapters = new Map<string, ExecutionPort>();
  const executions = new Map<string, ExecutionSessionState>();
  let disposed = false;
  let activeExecutionCount = 0;

  const acquireExecutionSlot = (): void => {
    if (activeExecutionCount >= maxActiveExecutions) {
      throw new SessionLinuxChannelError(
        "invalid_request",
        `too many active executions (max ${maxActiveExecutions})`,
      );
    }
    activeExecutionCount += 1;
  };

  const releaseExecutionSlot = (): void => {
    activeExecutionCount = Math.max(0, activeExecutionCount - 1);
  };

  const managedRoot =
    options.managedRootOverride ?? join(homedir(), ".zcode", "session-linux-execution");

  const getAdapter = (leaseId: string): ExecutionPort => {
    const existing = adapters.get(leaseId);
    if (existing) return existing;
    const outputRootDir = join(managedRoot, "leases", leaseId, "output");
    const adapter =
      options.createAdapter?.({ outputRootDir }) ?? createNodeExecutionAdapter({ outputRootDir });
    adapters.set(leaseId, adapter);
    return adapter;
  };

  const requireActiveScope = (params: {
    sessionId: string;
    lease: { leaseId: string; generation: number };
  }): void => {
    if (disposed) {
      throw new SessionLinuxChannelError("invalid_request", "channel is disposed");
    }
    try {
      registry.requireActiveLease({
        sessionId: params.sessionId,
        leaseId: params.lease.leaseId,
        generation: params.lease.generation,
      });
    } catch (error) {
      if (error instanceof SessionLinuxScopeError) {
        throw new ChannelScopeError(
          error.code === "stale_generation" ? "stale_generation" : "unknown_lease",
          error.message,
        );
      }
      throw error;
    }
  };

  const wireCommandToExecutionCommand = (
    command: ExecutionWireCommand,
  ): ExecutionRequest["command"] => {
    if (command.mode === "argv") {
      return { mode: "argv", file: command.file, args: command.args };
    }
    return {
      mode: "shell",
      command: command.command,
      shell: command.shell,
      shellProfile: command.shellProfile,
      shellOverride: command.shellOverride,
    };
  };

  const wireRequestToExecutionRequest = (wire: ExecutionWireRequest): ExecutionRequest => {
    const request: ExecutionRequest = {
      command: wireCommandToExecutionCommand(wire.command),
    };
    if (wire.cwd !== undefined) request.cwd = wire.cwd;
    if (wire.captureCwdAfterSuccess !== undefined)
      request.captureCwdAfterSuccess = wire.captureCwdAfterSuccess;
    if (wire.env !== undefined) request.env = wire.env;
    if (wire.timeoutMs !== undefined) request.timeoutMs = wire.timeoutMs;
    if (wire.outputLimit !== undefined) request.outputLimit = wire.outputLimit;
    if (wire.stdinText !== undefined) request.stdin = wire.stdinText;
    else if (wire.stdinBase64 !== undefined)
      request.stdin = Buffer.from(wire.stdinBase64, "base64");
    return request;
  };

  const serializeResult = (result: ExecutionResult): ExecutionWireResult => ({
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: {
      text: result.stdout.text,
      bytes: result.stdout.bytes,
      truncated: result.stdout.truncated,
      artifactPath: result.stdout.artifactPath,
      artifactBytes: result.stdout.artifactBytes,
      artifactTruncated: result.stdout.artifactTruncated,
    },
    stderr: {
      text: result.stderr.text,
      bytes: result.stderr.bytes,
      truncated: result.stderr.truncated,
      artifactPath: result.stderr.artifactPath,
      artifactBytes: result.stderr.artifactBytes,
      artifactTruncated: result.stderr.artifactTruncated,
    },
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    startedAtMs: result.startedAt.getTime(),
    completedAtMs: result.completedAt.getTime(),
    pid: result.pid,
    error: result.error ? { type: result.error.type, message: result.error.message } : undefined,
    resolvedCwd: result.resolvedCwd,
  });

  const serializeEvent = (event: ExecutionEvent): ExecutionWireEvent => {
    const timestampMs = event.timestamp.getTime();
    switch (event.type) {
      case "started":
        return { type: "started", pid: event.pid, timestampMs };
      case "stdout":
      case "stderr":
        return {
          type: event.type,
          chunkBase64: Buffer.from(event.chunk).toString("base64"),
          text: event.text,
          timestampMs,
        };
      case "progress":
        return {
          type: "progress",
          elapsedMs: event.elapsedMs,
          pid: event.pid,
          stdoutBytes: event.stdoutBytes,
          stderrBytes: event.stderrBytes,
          outputPreview: event.outputPreview,
          stdoutTail: event.stdoutTail,
          stderrTail: event.stderrTail,
          timestampMs,
        };
      case "completed":
        return { type: "completed", result: serializeResult(event.result), timestampMs };
      case "failed":
        return {
          type: "failed",
          error: { type: event.error.type, message: event.error.message },
          timestampMs,
        };
    }
  };

  const registerExecutionState = (
    scope: { sessionId: string; leaseId: string; generation: number },
    executionId: string,
    isBackground: boolean,
  ): ExecutionSessionState => {
    let completionResolve: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });
    const state: ExecutionSessionState = {
      executionId,
      leaseId: scope.leaseId,
      events: [],
      done: false,
      completion,
      startedAtMs: Date.now(),
      isBackground,
    };
    executions.set(executionId, state);
    registry.registerExecution(scope, { executionId });
    (state as { resolveCompletion?: () => void }).resolveCompletion = completionResolve;
    return state;
  };

  const finishExecution = (state: ExecutionSessionState): void => {
    state.done = true;
    (state as { resolveCompletion?: () => void }).resolveCompletion?.();
  };

  const attachEventForwarder = (state: ExecutionSessionState) => (event: ExecutionEvent) => {
    if (state.events.length < MAX_EVENTS_PER_EXECUTION) {
      state.events.push({ wire: serializeEvent(event), timestampMs: Date.now() });
    }
    if (event.type === "completed" || event.type === "failed") {
      if (event.type === "completed") state.result = event.result;
      finishExecution(state);
    }
  };

  const channel: IServerChannel = {
    listen: () => {
      // 本 channel 无服务端事件流；操作进度统一走有界 poll。
      return new Emitter<never>().event;
    },
    call: <T>(_context: string, command: string, args: unknown): Promise<T> => {
      return dispatch(command, args) as Promise<T>;
    },
  };

  function dispatch(command: string, args: unknown): Promise<unknown> {
    try {
      if (disposed) {
        return Promise.reject(
          new SessionLinuxChannelError("invalid_request", "channel is disposed"),
        );
      }
      switch (command) {
        case "prepare":
          return handlePrepare(sessionExecutionPrepareParamsSchema.parse(args));
        case "release":
          return handleRelease(sessionExecutionReleaseParamsSchema.parse(args));
        case "releaseSession":
          return handleReleaseSession(sessionExecutionReleaseSessionParamsSchema.parse(args));
        case "run":
          return handleRun(sessionExecutionRunParamsSchema.parse(args));
        case "start":
          return handleStart(sessionExecutionStartParamsSchema.parse(args));
        case "poll":
          return handlePoll(sessionExecutionPollParamsSchema.parse(args));
        case "cancel":
          return handleCancel(sessionExecutionCancelParamsSchema.parse(args));
        case "readBackground":
          return handleReadBackground(sessionExecutionReadBackgroundParamsSchema.parse(args));
        case "getBackgroundTask":
          return handleGetBackgroundTask(sessionExecutionGetBackgroundTaskParamsSchema.parse(args));
        case "cancelBackgroundTask":
          return handleCancelBackgroundTask(
            sessionExecutionCancelBackgroundTaskParamsSchema.parse(args),
          );
        case "bashBackgroundLifecycle":
          return handleBashBackgroundLifecycle(
            sessionExecutionBashBackgroundLifecycleParamsSchema.parse(args),
          );
        default:
          return Promise.reject(
            new SessionLinuxChannelError("invalid_request", `unknown command: ${command}`),
          );
      }
    } catch (error) {
      // zod parse 失败等同步错误 → 统一错误封套语义（strict 校验失败即 invalid）。
      return Promise.reject(toChannelError(error));
    }
  }

  function toChannelError(error: unknown): SessionLinuxChannelError {
    if (error instanceof SessionLinuxChannelError) return error;
    if (error instanceof PathMappingError) {
      return new SessionLinuxChannelError(error.code, error.message);
    }
    if (error instanceof ChannelScopeError) {
      return new SessionLinuxChannelError(error.code, error.message);
    }
    return new SessionLinuxChannelError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }

  async function handlePrepare(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      environment: { kind: "local" | "wsl"; distro?: string; user?: string };
      workspacePath: string;
    };
    // lease 由本 channel 侧生成（执行端是 lease 所有者；Host 收到后原样带回）。
    const leaseId = `lease-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const generation = 0;
    // 先占位注册以便 requireActiveScope 可用；workspace 映射在映射后补全。
    const placeholder: SessionLinuxWorkspaceMapping = {
      windowsPath: request.workspacePath,
      linuxPath: "",
    };
    registry.register({
      sessionId: request.sessionId,
      leaseId,
      generation,
      workspace: placeholder,
      createdAtMs: Date.now(),
    });
    try {
      const mapping = await mapWorkspacePaths(
        {
          execLinux: (command, args) => execLinuxViaAdapter(getAdapter(leaseId), command, args),
          existsDirLinux: async (linuxPath) => {
            const probe = await getAdapter(leaseId).run(
              { command: { mode: "argv", file: "test", args: ["-d", linuxPath] } },
              {},
            );
            return probe.status === "completed" && probe.exitCode === 0;
          },
        },
        request.workspacePath,
      );
      registry.updateWorkspace(leaseId, {
        windowsPath: mapping.originalWindowsPath,
        linuxPath: mapping.linuxPath,
        mappedWindowsPath: mapping.mappedWindowsPath,
      });
      const managedRootDir = join(managedRoot, "workspaces", leaseId);
      await mkdir(managedRootDir, { recursive: true });
      // 与 shared ok-result 联合一致：prepare 载荷嵌套在 prepare 字段并回显 operation。
      return {
        ok: true,
        operation: "prepare",
        prepare: sessionExecutionPrepareResultSchema.parse({
          ok: true,
          lease: { leaseId, generation },
          resolvedCwd: mapping.linuxPath,
          capabilities: {
            // 能力按适配器实际接口报告；方法名以 adapters 的 runBashWithBackgroundLifecycle 为准。
            bashBackgroundLifecycle:
              typeof (
                getAdapter(leaseId) as unknown as { runBashWithBackgroundLifecycle?: unknown }
              ).runBashWithBackgroundLifecycle === "function",
            embeddedSearchNative: true,
          },
        }),
      };
    } catch (error) {
      // prepare 失败不提交：占位 lease 必须回收。
      registry.release(leaseId);
      await disposeLeaseResources(leaseId);
      throw toChannelError(error);
    }
  }

  async function handleRelease(params: unknown): Promise<{ ok: true }> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
    };
    const scope = {
      sessionId: request.sessionId,
      lease: request.lease,
    };
    requireActiveScope(scope);
    // 仅释放自有任务：cancel 该 lease 全部 execution。
    const adapter = adapters.get(request.lease.leaseId);
    for (const execution of registry.listExecutions(request.lease.leaseId)) {
      const state = executions.get(execution.executionId);
      if (state && !state.done) {
        // 前台执行通过 adapter 内部 abort 无法直接触达（run 无外部 signal 进 wire），
        // 通过登记的 taskId 取消后台；前台执行等待其自然完成并在 dispose barrier 强制回收。
        if (state.taskId && adapter?.cancelBackgroundTask) {
          try {
            await adapter.cancelBackgroundTask(state.taskId);
          } catch (error) {
            log(`cancel background task failed (${state.taskId}):`, error);
          }
        }
      }
    }
    await disposeLeaseResources(request.lease.leaseId);
    registry.release(request.lease.leaseId);
    return { ok: true };
  }

  /**
   * 会话级回收：agent 退出/切换提交后释放该会话全部 lease。
   * 与 release 同口径清理（后台取消 + 资源回收）；对未知会话幂等成功。
   */
  async function handleReleaseSession(params: unknown): Promise<unknown> {
    const request = params as { sessionId: string };
    for (const leaseId of registry.listSessionLeaseIds(request.sessionId)) {
      const adapter = adapters.get(leaseId);
      for (const execution of registry.listExecutions(leaseId)) {
        const state = executions.get(execution.executionId);
        if (state && !state.done && state.taskId && adapter?.cancelBackgroundTask) {
          try {
            await adapter.cancelBackgroundTask(state.taskId);
          } catch (error) {
            log(`cancel background task failed (${state.taskId}):`, error);
          }
        }
      }
      await disposeLeaseResources(leaseId);
      registry.release(leaseId);
    }
    return { ok: true, operation: "releaseSession" };
  }

  async function handleRun(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      executionId: string;
      request: ExecutionWireRequest;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = getAdapter(request.lease.leaseId);
    const executionRequest = await materializeExecutionRequest(
      request.lease.leaseId,
      request.request,
    );
    acquireExecutionSlot();
    const state = registerExecutionState(
      {
        sessionId: request.sessionId,
        leaseId: request.lease.leaseId,
        generation: request.lease.generation,
      },
      request.executionId,
      false,
    );
    try {
      const result = await adapter.run(executionRequest, { onEvent: attachEventForwarder(state) });
      state.result = result;
      return { ok: true, operation: "run", result: serializeResult(result) };
    } finally {
      finishExecution(state);
      releaseExecutionSlot();
    }
  }

  async function handleStart(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      executionId: string;
      request: ExecutionWireRequest;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = getAdapter(request.lease.leaseId);
    if (!adapter.start) {
      throw new SessionLinuxChannelError(
        "prelude_capability_unavailable",
        "adapter does not support background start",
      );
    }
    const executionRequest = await materializeExecutionRequest(
      request.lease.leaseId,
      request.request,
    );
    const state = registerExecutionState(
      {
        sessionId: request.sessionId,
        leaseId: request.lease.leaseId,
        generation: request.lease.generation,
      },
      request.executionId,
      true,
    );
    try {
      const task = await adapter.start(executionRequest, { onEvent: attachEventForwarder(state) });
      const wire: ExecutionWireBackgroundStartResult = {
        taskId: task.taskId,
        status: "running",
        startedAtMs: task.startedAt.getTime(),
        pid: task.pid,
        outputPath: task.outputPath,
        stderrPersistedOutputPath: task.stderrPersistedOutputPath,
        stdoutPersistedOutputPath: task.stdoutPersistedOutputPath,
      };
      registry.updateExecution(
        {
          sessionId: request.sessionId,
          leaseId: request.lease.leaseId,
          generation: request.lease.generation,
        },
        request.executionId,
        { taskId: task.taskId },
      );
      state.taskId = task.taskId;
      // 后台任务完成时落地 snapshot（poll 终态）。
      void task; // snapshot 由 poll/readBackground 查询 adapter.getBackgroundTask
      return { ok: true, operation: "start", task: wire };
    } catch (error) {
      finishExecution(state);
      executions.delete(request.executionId);
      registry.dropExecution(
        {
          sessionId: request.sessionId,
          leaseId: request.lease.leaseId,
          generation: request.lease.generation,
        },
        request.executionId,
      );
      throw toChannelError(error);
    }
  }

  async function handlePoll(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      executionId: string;
      cursor: number;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const state = executions.get(request.executionId);
    if (!state) {
      throw new SessionLinuxChannelError(
        "unknown_execution",
        `execution ${request.executionId} is not owned by this lease`,
      );
    }
    const events = state.events.slice(request.cursor).map((entry) => entry.wire);
    let result: ExecutionWireResult | undefined;
    if (state.done && state.result) {
      result = serializeResult(state.result);
    } else if (state.done && state.isBackground && state.taskId) {
      const adapter = adapters.get(state.leaseId);
      const snapshot = await adapter?.getBackgroundTask?.(state.taskId);
      if (snapshot?.result) {
        result = serializeResult(snapshot.result);
      }
    }
    return {
      ok: true,
      operation: "poll",
      poll: {
        events,
        nextCursor: Math.min(request.cursor + events.length, state.events.length),
        result,
      },
    };
  }

  async function handleCancel(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      executionId: string;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const state = executions.get(request.executionId);
    if (!state) {
      throw new SessionLinuxChannelError(
        "unknown_execution",
        `execution ${request.executionId} is not owned by this lease`,
      );
    }
    const adapter = adapters.get(request.lease.leaseId);
    if (!state.done && state.taskId && adapter?.cancelBackgroundTask) {
      const snapshot = await adapter.cancelBackgroundTask(state.taskId);
      return {
        ok: true,
        operation: "cancel",
        snapshot: snapshot ? serializeSnapshot(snapshot) : undefined,
      };
    }
    // 前台执行取消：通过 adapter 不直接暴露 stop；标记住达终态后 poll 返回结果。
    // 这里返回无 snapshot（cancel 对前台是请求式），终态由 poll result 体现。
    return { ok: true, operation: "cancel" };
  }

  async function handleGetBackgroundTask(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      taskId: string;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = adapters.get(request.lease.leaseId);
    const snapshot = await adapter?.getBackgroundTask?.(request.taskId);
    return {
      ok: true,
      operation: "getBackgroundTask",
      snapshot: snapshot ? serializeSnapshot(snapshot) : undefined,
    };
  }

  async function handleCancelBackgroundTask(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      taskId: string;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = adapters.get(request.lease.leaseId);
    if (!adapter?.cancelBackgroundTask) {
      throw new SessionLinuxChannelError(
        "prelude_capability_unavailable",
        "adapter does not support cancelBackgroundTask",
      );
    }
    const snapshot = await adapter.cancelBackgroundTask(request.taskId);
    return {
      ok: true,
      operation: "cancelBackgroundTask",
      snapshot: snapshot ? serializeSnapshot(snapshot) : undefined,
    };
  }

  async function handleReadBackground(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      taskId: string;
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = adapters.get(request.lease.leaseId);
    if (!adapter?.readBackgroundBashOutput) {
      throw new SessionLinuxChannelError(
        "prelude_capability_unavailable",
        "adapter does not support background output read",
      );
    }
    const output = await adapter.readBackgroundBashOutput(request.taskId, request.sessionId);
    const wire: ExecutionWireBackgroundOutputResult =
      output.kind === "output"
        ? {
            kind: "output",
            workId: output.workId,
            status: output.status,
            output: output.output,
            truncated: output.truncated,
            outputPath: output.outputPath,
          }
        : output.kind === "unavailable"
          ? { kind: "unavailable", workId: output.workId }
          : { kind: "read_failed", workId: output.workId, code: output.code };
    return { ok: true, operation: "readBackground", output: wire };
  }

  async function handleBashBackgroundLifecycle(params: unknown): Promise<unknown> {
    const request = params as {
      sessionId: string;
      lease: { leaseId: string; generation: number };
      executionId: string;
      request: ExecutionWireRequest;
      mode: "explicit" | "auto_on_timeout";
    };
    requireActiveScope({ sessionId: request.sessionId, lease: request.lease });
    const adapter = getAdapter(request.lease.leaseId);
    // 真实 NodeExecutionAdapter 的方法名是 runBashWithBackgroundLifecycle
    //（adapters/src/exec/node-execution-adapter-lifecycle.ts）；名字不匹配会误报能力缺失。
    const runWithLifecycle = (
      adapter as unknown as {
        runBashWithBackgroundLifecycle?: (
          request: ExecutionRequest,
          lifecycle: { mode: "explicit" | "auto_on_timeout" },
          options?: { onEvent?: (event: ExecutionEvent) => void },
        ) => Promise<
          | { kind: "foreground"; result: ExecutionResult }
          | { kind: "backgrounded"; task: { taskId: string; startedAt: Date; pid?: number } }
        >;
      }
    ).runBashWithBackgroundLifecycle;
    if (!runWithLifecycle) {
      throw new SessionLinuxChannelError(
        "prelude_capability_unavailable",
        "adapter does not support bash background lifecycle",
      );
    }
    const executionRequest = await materializeExecutionRequest(
      request.lease.leaseId,
      request.request,
    );
    const state = registerExecutionState(
      {
        sessionId: request.sessionId,
        leaseId: request.lease.leaseId,
        generation: request.lease.generation,
      },
      request.executionId,
      true,
    );
    try {
      const lifecycle = await runWithLifecycle.call(
        adapter,
        executionRequest,
        { mode: request.mode },
        { onEvent: attachEventForwarder(state) },
      );
      if (lifecycle.kind === "foreground") {
        state.result = lifecycle.result;
        return {
          ok: true,
          operation: "bashBackgroundLifecycle",
          lifecycle: { kind: "foreground", result: serializeResult(lifecycle.result) },
        };
      }
      state.taskId = lifecycle.task.taskId;
      registry.updateExecution(
        {
          sessionId: request.sessionId,
          leaseId: request.lease.leaseId,
          generation: request.lease.generation,
        },
        request.executionId,
        { taskId: lifecycle.task.taskId },
      );
      return {
        ok: true,
        operation: "bashBackgroundLifecycle",
        lifecycle: {
          kind: "backgrounded",
          task: {
            taskId: lifecycle.task.taskId,
            status: "running",
            startedAtMs: lifecycle.task.startedAt.getTime(),
            pid: lifecycle.task.pid,
          },
        },
      };
    } catch (error) {
      finishExecution(state);
      throw toChannelError(error);
    }
  }

  /**
   * wire request → ExecutionRequest 的执行端 materialize：
   * - cwd 是 Windows 控制端路径：映射为已验证工作区内的 Linux 路径；不可映射/越界拒绝。
   * - 控制端 shell 选择/覆盖（Windows 解析快照，如 S:\Git\bin\bash.exe）不下沉：丢弃非
   *   POSIX 绝对路径，交由会话执行端按 shellProfile 解析自己的 bash；否则 Linux 侧会 spawn
   *   一个 Windows 路径直接 ENOENT，会话内 Bash 全数失败。
   * - internal-cli prelude 拒绝（Windows helper 不能进 Linux）；native-binaries/argv0-dispatch 保留。
   * - sandbox fail-closed。
   */
  async function materializeExecutionRequest(
    leaseId: string,
    wire: ExecutionWireRequest,
  ): Promise<ExecutionRequest> {
    const lease = registry.getLease(leaseId);
    if (!lease) {
      throw new SessionLinuxChannelError("unknown_lease", "lease is not active");
    }
    const request = wireRequestToExecutionRequest(wire);
    normalizeControlSideShellSelection(request);
    if (wire.cwd !== undefined) {
      const adapter = getAdapter(leaseId);
      // 控制端 cwd 是 Windows 路径（C:\proj 等，含工具层 win32 规范化后的反斜杠形式）。
      // 必须先 wslpath -u 映射成 Linux 路径再 realpath -m：直接 realpath 会把 Windows
      // 路径当成相对路径拼到执行端进程 cwd（真实实例实测得到
      // <serverCwd>/C:\Users\... 的错拼路径 → 越界拒绝 → WSL 会话 Bash 全数失败）。
      // 已经是 Linux 绝对路径（内部/冒烟调用）时保持原行为。
      let candidateLinuxCwd = wire.cwd;
      // 形如 <serverCwd>/C:\Users\... 的错拼（历史缺陷现场）：以 / 开头但含反斜杠，
      // 既不是合法 Linux 路径也不是 Windows 绝对路径；放行会跳过 wslpath 直接进
      // realpath -m 再次拼到执行端进程 cwd。按不可映射拒绝（fail-closed）。
      if (candidateLinuxCwd.startsWith("/") && candidateLinuxCwd.includes("\\")) {
        throw new SessionLinuxChannelError(
          "path_unmappable",
          `cwd is a corrupted hybrid path (Linux prefix + Windows segments): ${wire.cwd}`,
        );
      }
      if (!candidateLinuxCwd.startsWith("/")) {
        const mapped = await adapter.run(
          { command: { mode: "argv", file: "wslpath", args: ["-u", candidateLinuxCwd] } },
          {},
        );
        candidateLinuxCwd = mapped.stdout.text.trim();
        if (mapped.status !== "completed" || !candidateLinuxCwd.startsWith("/")) {
          throw new SessionLinuxChannelError(
            "path_unmappable",
            `cwd cannot be mapped to a Linux path: ${wire.cwd}`,
          );
        }
      }
      const probe = await adapter.run(
        { command: { mode: "argv", file: "realpath", args: ["-m", candidateLinuxCwd] } },
        {},
      );
      const resolvedCwd = probe.stdout.text.trim();
      if (probe.status !== "completed" || !resolvedCwd) {
        throw new SessionLinuxChannelError("path_not_found", `cwd cannot be resolved: ${wire.cwd}`);
      }
      if (!isLinuxCwdWithinWorkspace(resolvedCwd, lease.workspace.linuxPath)) {
        throw new SessionLinuxChannelError(
          "path_unmappable",
          `cwd ${resolvedCwd} is outside the authorized workspace ${lease.workspace.linuxPath}`,
        );
      }
      request.cwd = resolvedCwd;
    } else {
      request.cwd = lease.workspace.linuxPath;
    }
    if (wire.bashPrelude) {
      const backend = wire.bashPrelude.backend;
      if (backend.kind === "internal-cli") {
        throw new SessionLinuxChannelError(
          "prelude_capability_unavailable",
          "internal-cli embedded search prelude (Windows Electron helper) must be converted at the host boundary",
        );
      }
      (request as { bashPrelude?: unknown }).bashPrelude = {
        kind: "embedded-search",
        backend,
        findAndGrepEnabled: wire.bashPrelude.findAndGrepEnabled,
      };
    }
    if (wire.sandbox) {
      // Bash 每条请求默认带 { enabled: true }（无具体 profile）：这不是具体沙箱实现，
      // 放行沿用现有语义 + 上层权限审核。携带具体 profile / fs / network 限制等
      // 当前 Linux adapter 不能等效实现的 policy 时 fail-closed，不静默丢弃。
      const sandbox = wire.sandbox;
      const isGenericDefault =
        sandbox.enabled && sandbox.profile === undefined && sandbox.metadata === undefined;
      if (!isGenericDefault) {
        throw new SessionLinuxChannelError(
          "sandbox_unsupported",
          "concrete sandbox policy (profile/metadata) cannot be enforced on the Linux execution side; refusing to drop the policy",
        );
      }
      request.sandbox = sandbox;
    }
    // 控制端 trace 不整体传播（traceId/turnId/attributes 与本侧权限链无关），
    // 但必须带上 sessionId：执行端适配器用它命名输出目录（output/<sessionId>/），
    // 缺失时全部落到 output/unknown-session（实测：lease 下的工具输出无法按会话归档）。
    // 直接用 lease 里的原始 id：createSessionId() 会无条件加 sess_ 前缀，真实 id 已是 sess_…
    request.trace = {
      traceId: createTraceId(),
      sessionId: lease.sessionId as SessionId,
    };
    return request;
  }

  function serializeSnapshot(
    snapshot: BackgroundExecutionSnapshot,
  ): ExecutionWireBackgroundSnapshot {
    return {
      taskId: snapshot.taskId,
      status: snapshot.status,
      startedAtMs: snapshot.startedAt.getTime(),
      completedAtMs: snapshot.completedAt?.getTime(),
      pid: snapshot.pid,
      stderrBytes: snapshot.stderrBytes,
      stderrTail: snapshot.stderrTail,
      stdoutBytes: snapshot.stdoutBytes,
      stdoutTail: snapshot.stdoutTail,
      outputPath: snapshot.outputPath,
      stderrPersistedOutputPath: snapshot.stderrPersistedOutputPath,
      stdoutPersistedOutputPath: snapshot.stdoutPersistedOutputPath,
      result: snapshot.result ? serializeResult(snapshot.result) : undefined,
      error: snapshot.error
        ? { type: snapshot.error.type, message: snapshot.error.message }
        : undefined,
    };
  }

  async function disposeLeaseResources(leaseId: string): Promise<void> {
    const adapter = adapters.get(leaseId);
    if (!adapter) return;
    adapters.delete(leaseId);
    try {
      await adapter.close?.();
    } catch (error) {
      log(`adapter close failed for lease ${leaseId}:`, error);
    }
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    registry.releaseAll();
    for (const [leaseId] of adapters) {
      await disposeLeaseResources(leaseId);
    }
    executions.clear();
    try {
      await rm(join(managedRoot, "leases"), { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { channelName: SESSION_LINUX_EXECUTION_CHANNEL, channel, dispose, registry };
}

async function execLinuxViaAdapter(
  adapter: ExecutionPort,
  command: string,
  args: string[],
): Promise<string> {
  const result = await adapter.run({ command: { mode: "argv", file: command, args } }, {});
  if (result.status !== "completed") {
    throw new Error(`${command} exited with ${result.status}`);
  }
  return result.stdout.text;
}

/**
 * 丢弃控制端（Windows）下沉的 shell 选择：`shellOverride` 是控制端解析快照（例如
 * `S:\Git\bin\bash.exe` 的 git-bash provider），在 Linux 执行端 spawn 该路径必然 ENOENT，
 * 会话内 Bash 全数失败（真实实例实测：`spawn S:\Git\bin\bash.exe ENOENT`）。
 * 命令本身仍按 `posix-bash` profile 由执行端解析自己的 shell；只有 POSIX 绝对路径的
 * 选择（执行端可用）才保留，保持「能力在会话环境内解析」的语义。
 */
function normalizeControlSideShellSelection(request: ExecutionRequest): void {
  if (request.command.mode !== "shell") return;
  const shellCommand = request.command as {
    shell?: boolean | string;
    shellOverride?: { path?: string };
  };
  const overridePath = shellCommand.shellOverride?.path;
  if (overridePath !== undefined && !overridePath.startsWith("/")) {
    delete shellCommand.shellOverride;
  }
  if (
    typeof shellCommand.shell === "string" &&
    shellCommand.shell.length > 0 &&
    !shellCommand.shell.startsWith("/")
  ) {
    delete shellCommand.shell;
  }
}

export { ChannelScopeError };
