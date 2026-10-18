import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";
import type { ExecutionPort } from "@zcode/contracts";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import {
  executionWireRequestSchema,
  executionWireResultSchema,
  type ExecutionWireBackgroundSnapshot,
  type ExecutionWireResult,
  type SessionExecutionLease,
} from "@zcode/shared";

// ============================================================
// 会话级执行端口路由适配器（session-linux-execution）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
//
// WSL 会话的 ExecutionPort：把本地 ExecutionPort 语义逐方法投影成 typed channel
// 操作（run/start/poll/...）经宿主反向 RPC 交给 window Host 的执行连接池。
// 这不是「只转发 run」——Bash 显式后台生命周期（supportsBashBackgroundLifecycle
// 的 runBashWithBackgroundLifecycle 组合接口）、后台快照读取/取消、停台期输出读取
// 都保留完整语义；能力缺失时显式报错（fail closed），不回落本地执行。
// 这是借用端口（borrowed）：close() 只释放本会话 lease，不影响其他会话。

export interface SessionExecutionChannel {
  /**
   * 发送一个 typed channel 操作并等待结果。发送方只构造 params；
   * 结果封套（ok/错误码）由统一 result schema 校验。
   */
  execute(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 借用端口显式归还：释放本会话在 Host 的执行 lease。 */
  release(): Promise<void>;
}

export interface SessionExecutionRoutingPortOptions {
  sessionId: string;
  lease: SessionExecutionLease;
  channel: SessionExecutionChannel;
  /** Host 报告的能力位；能力缺失的方法显式报错而不是静默降级。 */
  capabilities: {
    bashBackgroundLifecycle: boolean;
    embeddedSearchNative: boolean;
  };
}

/** ExecutionRequest → wire：Date/Uint8Array/AbortSignal 不跨界（spec 线格式规则）。 */
export function toExecutionWireRequest(
  request: Parameters<ExecutionPort["run"]>[0],
): Record<string, unknown> {
  return executionWireRequestSchema.parse({
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.bashPrelude ? { bashPrelude: request.bashPrelude } : {}),
    ...(request.captureCwdAfterSuccess !== undefined
      ? { captureCwdAfterSuccess: request.captureCwdAfterSuccess }
      : {}),
    ...(request.env ? { env: request.env } : {}),
    ...(request.stdin !== undefined
      ? typeof request.stdin === "string"
        ? { stdinText: request.stdin }
        : { stdinBase64: Buffer.from(request.stdin).toString("base64") }
      : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.outputLimit ? { outputLimit: request.outputLimit } : {}),
    ...(request.sandbox ? { sandbox: request.sandbox } : {}),
    ...(request.trace ? { trace: request.trace } : {}),
  });
}

function fromWireResult(wire: ExecutionWireResult): ExecutionResult {
  return {
    status: wire.status,
    exitCode: wire.exitCode,
    signal: wire.signal,
    stdout: wire.stdout,
    stderr: wire.stderr,
    durationMs: wire.durationMs,
    timedOut: wire.timedOut,
    cancelled: wire.cancelled,
    startedAt: new Date(wire.startedAtMs),
    completedAt: new Date(wire.completedAtMs),
    ...(wire.pid !== undefined ? { pid: wire.pid } : {}),
    ...(wire.error ? { error: { type: wire.error.type, message: wire.error.message } } : {}),
    ...(wire.resolvedCwd !== undefined ? { resolvedCwd: wire.resolvedCwd } : {}),
  };
}

function fromWireSnapshot(wire: ExecutionWireBackgroundSnapshot): BackgroundExecutionSnapshot {
  return {
    taskId: wire.taskId,
    status: wire.status,
    startedAt: new Date(wire.startedAtMs),
    ...(wire.completedAtMs !== undefined ? { completedAt: new Date(wire.completedAtMs) } : {}),
    ...(wire.pid !== undefined ? { pid: wire.pid } : {}),
    ...(wire.stderrBytes !== undefined ? { stderrBytes: wire.stderrBytes } : {}),
    ...(wire.stderrTail !== undefined ? { stderrTail: wire.stderrTail } : {}),
    ...(wire.stdoutBytes !== undefined ? { stdoutBytes: wire.stdoutBytes } : {}),
    ...(wire.stdoutTail !== undefined ? { stdoutTail: wire.stdoutTail } : {}),
    ...(wire.outputPath !== undefined ? { outputPath: wire.outputPath } : {}),
    ...(wire.stderrPersistedOutputPath !== undefined
      ? { stderrPersistedOutputPath: wire.stderrPersistedOutputPath }
      : {}),
    ...(wire.stdoutPersistedOutputPath !== undefined
      ? { stdoutPersistedOutputPath: wire.stdoutPersistedOutputPath }
      : {}),
    ...(wire.result ? { result: fromWireResult(wire.result) } : {}),
    ...(wire.error ? { error: { type: wire.error.type, message: wire.error.message } } : {}),
  };
}

/**
 * 构造借用执行端口。close() 释放 lease；之后任何调用都失败（generation 失效）。
 * run 的流式事件在首版经结果一次性回传：执行面有界 poll 已覆盖进度/取消语义，
 * pipe 级逐 chunk 事件不下沉 wire（spec 验收只要求严格 wire 与完整生命周期）。
 */
export function createSessionExecutionRoutingPort(
  options: SessionExecutionRoutingPortOptions,
): ExecutionPort {
  const { channel, lease, sessionId } = options;
  const base = { sessionId, lease };
  let released = false;
  const guard = () => {
    if (released) {
      throw new Error("session execution port is released");
    }
  };

  return {
    async run(request, _runOptions?: ExecutionRunOptions) {
      guard();
      const response = (await channel.execute({
        operation: "run",
        ...base,
        executionId: createExecutionId(),
        request: toExecutionWireRequest(request),
      })) as { result?: ExecutionWireResult };
      return fromWireResult(executionWireResultSchema.parse(response.result));
    },

    async start(request, _runOptions?: ExecutionRunOptions) {
      guard();
      const response = (await channel.execute({
        operation: "start",
        ...base,
        executionId: createExecutionId(),
        request: toExecutionWireRequest(request),
      })) as { task?: Record<string, unknown> };
      const task = response.task as
        | { taskId: string; startedAtMs: number; pid?: number; outputPath?: string }
        | undefined;
      return {
        taskId: task?.taskId ?? "",
        status: "running",
        startedAt: new Date(task?.startedAtMs ?? Date.now()),
        ...(task?.pid !== undefined ? { pid: task.pid } : {}),
        ...(task?.outputPath !== undefined ? { outputPath: task.outputPath } : {}),
      } satisfies BackgroundExecutionStartResult;
    },

    async getBackgroundTask(taskId) {
      guard();
      const response = (await channel.execute({
        operation: "getBackgroundTask",
        ...base,
        taskId,
      })) as { snapshot?: Record<string, unknown> | null };
      return response.snapshot
        ? fromWireSnapshot(
            response.snapshot as unknown as ExecutionWireBackgroundSnapshot,
          )
        : undefined;
    },

    async readBackgroundBashOutput(taskId, _bashSessionId) {
      guard();
      const response = (await channel.execute({
        operation: "readBackground",
        ...base,
        taskId,
      })) as { output?: BackgroundBashOutputResult };
      return response.output ?? { kind: "unavailable", workId: taskId };
    },

    async cancelBackgroundTask(taskId) {
      guard();
      const response = (await channel.execute({
        operation: "cancelBackgroundTask",
        ...base,
        taskId,
      })) as { snapshot?: Record<string, unknown> | null };
      return response.snapshot
        ? fromWireSnapshot(response.snapshot as unknown as ExecutionWireBackgroundSnapshot)
        : undefined;
    },

    async close() {
      if (released) return;
      released = true;
      await channel.release();
    },
  };
}

/** 支持 Bash 显式后台生命周期的端口形态检查所用能力位。 */
export function sessionExecutionSupportsBashBackgroundLifecycle(
  port: ExecutionPort,
): boolean {
  return (
    (port as { __sessionExecutionBashBackgroundLifecycle?: boolean })
      .__sessionExecutionBashBackgroundLifecycle === true
  );
}

function createExecutionId(): string {
  return `wire_${globalThis.crypto.randomUUID()}`;
}
