import { z } from "zod";
import {
  EXECUTION_WIRE_MAX_EVENTS_PER_POLL,
  executionWireBackgroundStartResultSchema,
  executionWireEventSchema,
  executionWireRequestSchema,
  executionWireResultSchema,
  sessionExecutionLeaseSchema,
} from "./sessionExecutionWire.js";
import {
  sessionExecutionEnvironmentSchema,
  sessionExecutionStateSchema,
} from "./sessionExecutionEnvironment.js";

// ============================================================
// 会话执行 typed channel 操作与控制面（interaction/sessionExecution）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
// wire 基础类型（ExecutionRequest/Result/事件/后台投影）在 sessionExecutionWire.ts；
// 本文件是 operation 级契约：执行面（Host 执行端）与控制面（CLI session owner）严格 split。

// ── typed channel 操作（prepare/start/run/poll/cancel/...）──

export const SESSION_EXECUTION_OPERATIONS = [
  "prepare",
  "release",
  /** 释放该 session 当前借用的全部执行 lease（agent 退出/切换提交后回收）。 */
  "releaseSession",
  "run",
  "start",
  "poll",
  "cancel",
  "readBackground",
  "getBackgroundTask",
  "cancelBackgroundTask",
  "bashBackgroundLifecycle",
] as const;
export type SessionExecutionOperation = (typeof SESSION_EXECUTION_OPERATIONS)[number];

export const sessionExecutionPrepareParamsSchema = z
  .object({
    operation: z.literal("prepare"),
    sessionId: z.string().min(1),
    environment: sessionExecutionEnvironmentSchema,
    /** Windows workspace 真源路径；Host 负责映射，Linux 端不得自行推断。 */
    workspacePath: z.string().min(1),
  })
  .strict();

export const sessionExecutionPrepareResultSchema = z
  .object({
    ok: z.literal(true),
    lease: sessionExecutionLeaseSchema,
    /** 授权映射的 Linux cwd；不可映射/越界时 prepare 失败。 */
    resolvedCwd: z.string().min(1),
    capabilities: z
      .object({
        bashBackgroundLifecycle: z.boolean(),
        embeddedSearchNative: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const sessionExecutionReleaseParamsSchema = z
  .object({
    operation: z.literal("release"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
  })
  .strict();

/** 按 sessionId 释放该会话借用的全部执行 lease；agent 退出/切换提交后由 CLI 触发。 */
export const sessionExecutionReleaseSessionParamsSchema = z
  .object({
    operation: z.literal("releaseSession"),
    sessionId: z.string().min(1),
  })
  .strict();

export const sessionExecutionRunParamsSchema = z
  .object({
    operation: z.literal("run"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    executionId: z.string().min(1),
    request: executionWireRequestSchema,
  })
  .strict();

export const sessionExecutionStartParamsSchema = z
  .object({
    operation: z.literal("start"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    executionId: z.string().min(1),
    request: executionWireRequestSchema,
  })
  .strict();

/** 有界 poll：返回自 cursor 起的事件与（若已终态）结果；避免重建流协议。 */
export const sessionExecutionPollParamsSchema = z
  .object({
    operation: z.literal("poll"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    executionId: z.string().min(1),
    cursor: z.number().int().nonnegative(),
  })
  .strict();

export const sessionExecutionPollResultSchema = z
  .object({
    events: z.array(executionWireEventSchema).max(EXECUTION_WIRE_MAX_EVENTS_PER_POLL),
    nextCursor: z.number().int().nonnegative(),
    result: executionWireResultSchema.optional(),
  })
  .strict();

export const sessionExecutionCancelParamsSchema = z
  .object({
    operation: z.literal("cancel"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    executionId: z.string().min(1),
  })
  .strict();

export const sessionExecutionReadBackgroundParamsSchema = z
  .object({
    operation: z.literal("readBackground"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    taskId: z.string().min(1),
  })
  .strict();

/** ExecutionPort.getBackgroundTask 的 wire 形态；快照缺席（未知 taskId）时不带 snapshot。 */
export const sessionExecutionGetBackgroundTaskParamsSchema = z
  .object({
    operation: z.literal("getBackgroundTask"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    taskId: z.string().min(1),
  })
  .strict();

/** ExecutionPort.cancelBackgroundTask 的 wire 形态；取消前快照回传（可能缺席）。 */
export const sessionExecutionCancelBackgroundTaskParamsSchema = z
  .object({
    operation: z.literal("cancelBackgroundTask"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    taskId: z.string().min(1),
  })
  .strict();

/** Bash 显式后台生命周期组合接口（supportsBashBackgroundLifecycle 的 wire 形态）。 */
export const sessionExecutionBashBackgroundLifecycleParamsSchema = z
  .object({
    operation: z.literal("bashBackgroundLifecycle"),
    sessionId: z.string().min(1),
    lease: sessionExecutionLeaseSchema,
    executionId: z.string().min(1),
    request: executionWireRequestSchema,
    mode: z.enum(["explicit", "auto_on_timeout"]),
  })
  .strict();

// ── 控制面操作（UI service get/set/cancel 经同一反向 RPC 方法）──
// getExecutionEnvironment：只读当前配置投影；
// setExecutionEnvironment：切换 admission（busy/queue/permission/background 拒绝）；
// cancelExecutionEnvironmentPreparation：取消进行中准备，不提交。

export const sessionExecutionControlGetParamsSchema = z
  .object({
    operation: z.literal("getExecutionEnvironment"),
    sessionId: z.string().min(1),
  })
  .strict();

export const sessionExecutionControlSetParamsSchema = z
  .object({
    operation: z.literal("setExecutionEnvironment"),
    sessionId: z.string().min(1),
    environment: sessionExecutionEnvironmentSchema,
  })
  .strict();

export const sessionExecutionControlCancelParamsSchema = z
  .object({
    operation: z.literal("cancelExecutionEnvironmentPreparation"),
    sessionId: z.string().min(1),
  })
  .strict();

export const sessionExecutionControlResultSchema = z
  .object({
    state: sessionExecutionStateSchema,
  })
  .strict();

export const sessionExecutionBashBackgroundLifecycleResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("foreground"), result: executionWireResultSchema }).strict(),
  z
    .object({
      kind: z.literal("backgrounded"),
      task: executionWireBackgroundStartResultSchema,
    })
    .strict(),
]);

/** 反向 RPC 结果统一封套：旧代/断连/无 executor 都走 ok:false，绝不回落本地执行。 */
export const sessionExecutionOperationErrorSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum([
      "backend_unavailable",
      "environment_unavailable",
      "lease_rejected",
      "stale_generation",
      "unknown_execution",
      "path_not_mapped",
      "capability_missing",
      "cancelled",
      "internal",
    ]),
    message: z.string(),
  })
  .strict();
export type SessionExecutionOperationError = z.infer<typeof sessionExecutionOperationErrorSchema>;
