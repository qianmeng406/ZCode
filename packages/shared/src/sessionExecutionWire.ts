import { z } from "zod";
import { executionOutputPreviewSchema } from "./execution-output-preview.js";

// ============================================================
// 会话执行环境 wire 契约（typed channel "session-linux-execution"）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
//
// 线格式规则（spec「所有者及接口」第 8 条）：
// - 不跨 RPC 传 AbortSignal / function / Error 实例；
// - Date 一律毫秒时间戳（*AtMs），Uint8Array 一律 base64（*Base64）；
// - 全部 schema strict，宿主与 Linux 端共用同一运行时校验。
//
// 操作拓扑：Agent（CLI session owner）经宿主反向 RPC `interaction/sessionExecution`
// 把 { sessionId, operation } 转给 window Host 的 sessionExecutionExecutor；
// Host 在本机 WSL 端部署 stdio/RPC 执行端并按 lease/generation 执行。

export const SESSION_EXECUTION_CHANNEL = "session-linux-execution" as const;

/** 宿主执行端分配的临时 lease；配置不持久化。 */
export const sessionExecutionLeaseSchema = z
  .object({
    leaseId: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export type SessionExecutionLease = z.infer<typeof sessionExecutionLeaseSchema>;

// ── 执行请求 wire（ExecutionRequest 的 JSON 安全投影）──

export const executionWireCommandSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("argv"),
      file: z.string().min(1),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("shell"),
      command: z.string().min(1),
      shell: z.union([z.literal(true), z.string()]).optional(),
      shellProfile: z.literal("posix-bash").optional(),
      // shellOverride 携带宿主解析出的 shell 选择；dialect/source 为必填事实。
      shellOverride: z
        .object({
          id: z.string().optional(),
          label: z.string().optional(),
          path: z.string().optional(),
          dialect: z.enum(["cmd", "posix", "git-bash", "legacy-shell"]),
          source: z.enum(["auto-detected", "user-config", "legacy-fallback"]),
          display: z.object({ name: z.string() }).strict(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ExecutionWireCommand = z.infer<typeof executionWireCommandSchema>;

/**
 * embedded search prelude 的能力转换结果：
 * Linux 端只接受 native-binaries / argv0-dispatch（POSIX 可执行形态）；
 * internal-cli（Windows Electron helper）必须在 Host 边界转换或拒绝，
 * 绝不能把 Windows binary/command 整包送进 Linux（spec「路径及能力」）。
 */
export const executionWireEmbeddedSearchBackendSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("internal-cli"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("argv0-dispatch"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-binaries"),
      findCommand: z.string().min(1),
      grepCommand: z.string().min(1),
      rgCommand: z.string().min(1),
    })
    .strict(),
]);
export type ExecutionWireEmbeddedSearchBackend = z.infer<
  typeof executionWireEmbeddedSearchBackendSchema
>;

export const executionWireEmbeddedSearchPreludeSchema = z
  .object({
    kind: z.literal("embedded-search"),
    backend: executionWireEmbeddedSearchBackendSchema,
    findAndGrepEnabled: z.boolean().optional(),
  })
  .strict();
export type ExecutionWireEmbeddedSearchPrelude = z.infer<
  typeof executionWireEmbeddedSearchPreludeSchema
>;

export const executionWireEnvOverlaySchema = z
  .object({
    base: z.enum(["inherit", "empty"]).optional(),
    set: z.record(z.string(), z.string()).optional(),
    unset: z.array(z.string()).optional(),
  })
  .strict();

export const executionWireOutputLimitSchema = z
  .object({
    maxInlineBytes: z.number().int().nonnegative().optional(),
    maxBufferBytes: z.number().int().nonnegative().optional(),
    persistOutput: z.enum(["none", "on_truncate", "always"]).optional(),
    maxPersistedBytes: z.number().int().nonnegative().optional(),
    maxArtifactBytes: z.number().int().nonnegative().optional(),
    killProcessOnPersistedLimit: z.boolean().optional(),
  })
  .strict();

/** ExecutionSandboxPolicy 的 wire 投影；CLI 序列化不得丢 policy（Bash handler 会显式写入）。 */
export const executionWireSandboxPolicySchema = z
  .object({
    enabled: z.boolean(),
    profile: z.string().optional(),
    dangerouslyDisableSandbox: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * TraceContext 的 wire 投影。attributes 值域与 contracts TraceContext 一致
 * （string | number | boolean）；queryId/parentId/sessionId/turnId 是事实字段，
 * 不能只挑三字段——capture/correlation 依赖它们。
 */
export const executionWireTraceSchema = z
  .object({
    traceId: z.string().min(1),
    queryId: z.string().optional(),
    spanId: z.string().optional(),
    parentSpanId: z.string().optional(),
    parentId: z.string().optional(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

// 有界上限：wire 事件窗口/timeout 不能无限增长（spec「严格 wire 校验」）。
export const EXECUTION_WIRE_MAX_EVENTS_PER_POLL = 128;
export const EXECUTION_WIRE_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const EXECUTION_WIRE_MAX_STDIN_BYTES = 8 * 1024 * 1024;

const boundedTimeoutMsSchema = z.number().int().positive().max(EXECUTION_WIRE_MAX_TIMEOUT_MS);

const base64Schema = z
  .string()
  .max(Math.ceil(EXECUTION_WIRE_MAX_STDIN_BYTES / 3) * 4)
  .refine(
    (value) => {
      // 空串合法；否则必须是规范 base64（可选 padding）。
      if (value.length === 0) return true;
      return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
    },
    { message: "Invalid base64" },
  );

export const executionWireRequestSchema = z
  .object({
    command: executionWireCommandSchema,
    /** Windows 控制端绝对 cwd；Host 负责映射为 Linux cwd，不做 shell 文本替换。 */
    cwd: z.string().optional(),
    bashPrelude: executionWireEmbeddedSearchPreludeSchema.optional(),
    captureCwdAfterSuccess: z.boolean().optional(),
    env: executionWireEnvOverlaySchema.optional(),
    /** stdinText 与 stdinBase64 互斥；都不能超 EXECUTION_WIRE_MAX_STDIN_BYTES。 */
    stdinBase64: base64Schema.optional(),
    stdinText: z.string().max(EXECUTION_WIRE_MAX_STDIN_BYTES).optional(),
    timeoutMs: boundedTimeoutMsSchema.optional(),
    outputLimit: executionWireOutputLimitSchema.optional(),
    sandbox: executionWireSandboxPolicySchema.optional(),
    trace: executionWireTraceSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.stdinBase64 !== undefined && value.stdinText !== undefined), {
    message: "stdinText and stdinBase64 are mutually exclusive",
  })
  .refine(
    (value) =>
      value.stdinBase64 === undefined ||
      Buffer.from(value.stdinBase64, "base64").length <= EXECUTION_WIRE_MAX_STDIN_BYTES,
    { message: "stdinBase64 exceeds size limit" },
  );
export type ExecutionWireRequest = z.infer<typeof executionWireRequestSchema>;

// ── 执行结果 wire（ExecutionResult / 事件投影）──

export const executionWireStreamResultSchema = z
  .object({
    text: z.string(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    artifactPath: z.string().optional(),
    artifactBytes: z.number().int().nonnegative().optional(),
    artifactTruncated: z.boolean().optional(),
  })
  .strict();

export const executionWireFailureSchema = z
  .object({
    type: z.enum([
      "spawn_error",
      "timeout",
      "cancelled",
      "sandbox_violation",
      "output_limit",
      "unknown",
    ]),
    message: z.string(),
  })
  .strict();

export const executionWireResultSchema = z
  .object({
    status: z.enum(["completed", "failed", "timed_out", "cancelled", "spawn_error"]),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    stdout: executionWireStreamResultSchema,
    stderr: executionWireStreamResultSchema,
    durationMs: z.number().nonnegative(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    startedAtMs: z.number(),
    completedAtMs: z.number(),
    pid: z.number().int().optional(),
    error: executionWireFailureSchema.optional(),
    /** Linux 端真实 cwd；Host 负责回映射为 Windows 路径。 */
    resolvedCwd: z.string().optional(),
  })
  .strict();
export type ExecutionWireResult = z.infer<typeof executionWireResultSchema>;

export const executionWireEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("started"),
      pid: z.number().int().optional(),
      timestampMs: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.enum(["stdout", "stderr"]),
      chunkBase64: z.string(),
      text: z.string(),
      timestampMs: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      elapsedMs: z.number().nonnegative(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
      timestampMs: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      result: executionWireResultSchema,
      timestampMs: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      error: executionWireFailureSchema,
      timestampMs: z.number(),
    })
    .strict(),
]);
export type ExecutionWireEvent = z.infer<typeof executionWireEventSchema>;

// ── 后台执行 wire ──

export const executionWireBackgroundStartResultSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.literal("running"),
    startedAtMs: z.number(),
    pid: z.number().int().optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
  })
  .strict();
export type ExecutionWireBackgroundStartResult = z.infer<
  typeof executionWireBackgroundStartResultSchema
>;

export const executionWireBackgroundSnapshotSchema = z
  .object({
    taskId: z.string().min(1),
    status: z.enum(["running", "completed", "failed", "timed_out", "cancelled", "spawn_error"]),
    startedAtMs: z.number(),
    completedAtMs: z.number().optional(),
    pid: z.number().int().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    result: executionWireResultSchema.optional(),
    error: executionWireFailureSchema.optional(),
  })
  .strict();
export type ExecutionWireBackgroundSnapshot = z.infer<typeof executionWireBackgroundSnapshotSchema>;

export const executionWireBackgroundOutputResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("output"),
      workId: z.string(),
      status: z.enum(["running", "completed", "failed", "timed_out", "cancelled", "spawn_error"]),
      output: z.string(),
      truncated: z.boolean(),
      outputPath: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      workId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("read_failed"),
      workId: z.string(),
      code: z.string().optional(),
    })
    .strict(),
]);
export type ExecutionWireBackgroundOutputResult = z.infer<
  typeof executionWireBackgroundOutputResultSchema
>;
