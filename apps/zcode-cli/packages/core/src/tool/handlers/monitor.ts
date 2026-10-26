import net from "node:net";
import { open } from "node:fs/promises";
import {
  MONITOR_TOOL_NAME,
  MONITOR_PROVIDER_DESCRIPTION,
  MonitorInputJsonSchema,
  MonitorInputSchema,
  MonitorResultJsonSchema,
  MonitorResultSchema,
  isHttpClientPortError,
  type MonitorInput,
  type MonitorResult,
} from "@zcode/contracts";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationContext,
  ToolInputValidationResult,
} from "../types.js";

const MONITOR_SNIPPET_MAX_CHARS = 2_000;
const MONITOR_LAST_OBSERVED_MAX_CHARS = 1_200;
const MONITOR_TASK_READ_MAX_BYTES = 256 * 1024;

type MonitorTarget =
  | { kind: "task"; taskId: string; pattern: RegExp }
  | { kind: "file"; path: string; text: string; ignoreCase: boolean }
  | { kind: "port"; host: string; port: number }
  | { kind: "http"; url: string; status?: number };

type ProbeOutcome =
  | { kind: "matched"; snippet: string }
  | { kind: "waiting"; observed?: string }
  | { kind: "missing"; observed?: string }
  | { kind: "terminal"; observed?: string };

interface MonitorTaskReadState {
  /** task 输出文件的增量读取游标；没有可读文件时保持 undefined，回落到 8 KiB 尾部快照。 */
  offset?: number;
  /** 尾部快照模式下上一次观察到的文本，用于识别"输出还在推进"。 */
  lastTail?: string;
}

/**
 * Monitor：等待一个条件成立，而不是让模型 sleep 或反复读日志。
 *
 * 轮询在工具内部进行，模型只看到一次调用与一个结论；四种目标共用同一套超时/取消语义。
 * 任务输出优先按字节 offset 增量读文件（长输出不会因为滚动而漏掉早期命中），文件不可读
 * （远端执行环境/权限）时回落到 `readBackgroundBashOutput` 的 8 KiB 尾部快照。
 */
const monitorHandler: ToolHandler = async (input, context) => {
  const parsed = MonitorInputSchema.parse(input) as MonitorInput;
  const resolved = resolveMonitorTarget(parsed);
  if (!resolved.ok) {
    return monitorFailure(2, resolved.message);
  }
  const startedAt = Date.now();
  const timeoutMs = parsed.timeout_ms;
  const pollIntervalMs = parsed.poll_interval_ms;
  const state: MonitorTaskReadState = {};
  let lastObserved: string | undefined;

  while (true) {
    if (context.abortSignal.aborted) {
      return monitorResult({
        satisfied: false,
        reason: "aborted",
        elapsedMs: Date.now() - startedAt,
        lastObserved,
      });
    }
    const outcome = await probeTarget(resolved.target, context, state);
    if (outcome.kind === "matched") {
      return monitorResult({
        satisfied: true,
        reason: "matched",
        elapsedMs: Date.now() - startedAt,
        snippet: outcome.snippet,
      });
    }
    lastObserved = outcome.observed ?? lastObserved;
    if (outcome.kind === "missing") {
      return monitorResult({
        satisfied: false,
        reason: "target_missing",
        elapsedMs: Date.now() - startedAt,
        lastObserved,
      });
    }
    if (outcome.kind === "terminal") {
      return monitorResult({
        satisfied: false,
        reason: "target_terminal",
        elapsedMs: Date.now() - startedAt,
        lastObserved,
      });
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return monitorResult({
        satisfied: false,
        reason: "timeout",
        elapsedMs: elapsed,
        lastObserved,
      });
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed), context.abortSignal);
  }
};

export const monitorToolEntry: ToolEntry = {
  capability: "wait for a condition on a background task, file, TCP port, or URL",
  maxModelChars: 8_000,
  metadata: {
    name: MONITOR_TOOL_NAME,
    description: MONITOR_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: 8_000,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: monitorHandler,
  validateInput: validateMonitorInput,
  inputSchema: MonitorInputJsonSchema,
  outputSchema: MonitorResultJsonSchema,
  runtimeInputSchema: MonitorInputSchema,
  runtimeOutputSchema: MonitorResultSchema,
  permission: {
    permission: "read",
    reason: "Monitor only observes tasks, files, ports and URLs; it never writes",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 8_000,
    maxModelBytes: 8_000,
    strategy: "truncate",
    preview: {
      maxBytes: 8_000,
      direction: "head",
    },
  },
  // 等待时长由 timeout_ms 自己管理；执行器的超时只负责整个 turn 的强制收口。
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Monitor was cancelled while waiting for its condition",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function resolveMonitorTarget(
  input: MonitorInput,
): { ok: true; target: MonitorTarget } | { ok: false; message: string } {
  if (input.target_kind === "task") {
    if (input.expect_kind !== "output_matches") {
      return { ok: false, message: 'target_kind="task" requires expect_kind="output_matches"' };
    }
    if (!input.task_id?.trim()) {
      return { ok: false, message: 'target_kind="task" requires task_id' };
    }
    if (!input.pattern) {
      return { ok: false, message: 'expect_kind="output_matches" requires pattern' };
    }
    try {
      return {
        ok: true,
        target: {
          kind: "task",
          taskId: input.task_id.trim(),
          pattern: new RegExp(input.pattern, input.ignore_case ? "i" : ""),
        },
      };
    } catch (error) {
      return { ok: false, message: `pattern is not a valid regular expression: ${String(error)}` };
    }
  }
  if (input.target_kind === "file") {
    if (input.expect_kind !== "file_contains") {
      return { ok: false, message: 'target_kind="file" requires expect_kind="file_contains"' };
    }
    if (!input.file_path?.trim()) {
      return { ok: false, message: 'target_kind="file" requires file_path' };
    }
    if (input.text === undefined) {
      return { ok: false, message: 'expect_kind="file_contains" requires text' };
    }
    return {
      ok: true,
      target: {
        kind: "file",
        path: input.file_path.trim(),
        text: input.text,
        ignoreCase: input.ignore_case,
      },
    };
  }
  if (input.target_kind === "port") {
    if (input.expect_kind !== "reachable") {
      return { ok: false, message: 'target_kind="port" requires expect_kind="reachable"' };
    }
    if (input.port === undefined) {
      return { ok: false, message: 'target_kind="port" requires port' };
    }
    return {
      ok: true,
      target: { kind: "port", host: input.host?.trim() || "127.0.0.1", port: input.port },
    };
  }
  if (input.expect_kind !== "http_ok") {
    return { ok: false, message: 'target_kind="http" requires expect_kind="http_ok"' };
  }
  if (!input.url?.trim()) {
    return { ok: false, message: 'target_kind="http" requires url' };
  }
  return {
    ok: true,
    target: {
      kind: "http",
      url: input.url.trim(),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  };
}

function validateMonitorInput(
  input: unknown,
  _context: ToolInputValidationContext,
): ToolInputValidationResult {
  const parsed = MonitorInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      result: false,
      errorCode: 1,
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  const resolved = resolveMonitorTarget(parsed.data as MonitorInput);
  if (!resolved.ok) {
    return { result: false, errorCode: 2, message: resolved.message };
  }
  return { result: true };
}

async function probeTarget(
  target: MonitorTarget,
  context: ToolExecutionContext,
  state: MonitorTaskReadState,
): Promise<ProbeOutcome> {
  if (target.kind === "task") return probeTask(target, context, state);
  if (target.kind === "file") return probeFile(target, context);
  if (target.kind === "port") return probePort(target, context);
  return probeHttp(target, context);
}

async function probeTask(
  target: Extract<MonitorTarget, { kind: "task" }>,
  context: ToolExecutionContext,
  state: MonitorTaskReadState,
): Promise<ProbeOutcome> {
  const registry = context.runtimeTaskRegistry;
  const task = registry?.get(target.taskId);
  if (!task) return { kind: "missing" };
  const text = await readTaskOutputDelta(task.outputFile, target.taskId, context, state);
  if (text.length > 0) {
    const match = target.pattern.exec(text);
    if (match) {
      return { kind: "matched", snippet: extractSnippet(text, match.index) };
    }
  }
  const observed = text.length > 0 ? text : state.lastTail;
  if (observed) state.lastTail = observed;
  if (isTerminalRuntimeTask(task)) {
    return { kind: "terminal", observed: truncate(observed, MONITOR_LAST_OBSERVED_MAX_CHARS) };
  }
  return {
    kind: "waiting",
    observed: truncate(observed, MONITOR_LAST_OBSERVED_MAX_CHARS),
  };
}

/**
 * 优先按字节 offset 从输出文件续读：正则只在新增字节上跑，同时避免长输出把早期命中滚出窗口。
 * 文件不可读（远端执行环境、尚未创建、权限）时回落到执行端提供的 8 KiB 尾部快照。
 */
async function readTaskOutputDelta(
  outputFile: string | undefined,
  taskId: string,
  context: ToolExecutionContext,
  state: MonitorTaskReadState,
): Promise<string> {
  if (outputFile) {
    try {
      const handle = await open(outputFile, "r");
      try {
        const stats = await handle.stat();
        const offset = state.offset ?? 0;
        if (stats.size > offset) {
          const length = Math.min(stats.size - offset, MONITOR_TASK_READ_MAX_BYTES);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          state.offset = offset + bytesRead;
          return buffer.subarray(0, bytesRead).toString("utf8");
        }
        return "";
      } finally {
        await handle.close();
      }
    } catch {
      // 回落到执行端口；远端会话的 outputFile 可能是宿主路径。
    }
  }
  const executionPort = context.executionPort;
  if (!executionPort?.readBackgroundBashOutput) return "";
  try {
    const snapshot = await executionPort.readBackgroundBashOutput(taskId, context.sessionId);
    if (snapshot.kind !== "output") return "";
    return snapshot.output;
  } catch {
    return "";
  }
}

async function probeFile(
  target: Extract<MonitorTarget, { kind: "file" }>,
  context: ToolExecutionContext,
): Promise<ProbeOutcome> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) return { kind: "missing" };
  try {
    const stats = await fileSystemPort.stat({ path: target.path });
    if (stats.kind !== "file") return { kind: "waiting" };
  } catch {
    return { kind: "waiting" };
  }
  let content: string;
  try {
    const result = await fileSystemPort.readTextFile({
      path: target.path,
      maxBytes: MONITOR_TASK_READ_MAX_BYTES,
    });
    content = result.content;
  } catch {
    return { kind: "waiting" };
  }
  const haystack = target.ignoreCase ? content.toLowerCase() : content;
  const needle = target.ignoreCase ? target.text.toLowerCase() : target.text;
  const index = haystack.indexOf(needle);
  if (index >= 0) {
    return { kind: "matched", snippet: extractSnippet(content, index) };
  }
  return { kind: "waiting", observed: truncate(content, MONITOR_LAST_OBSERVED_MAX_CHARS) };
}

async function probePort(
  target: Extract<MonitorTarget, { kind: "port" }>,
  context: ToolExecutionContext,
): Promise<ProbeOutcome> {
  const reachable = await canConnect(target.host, target.port, context.abortSignal);
  return reachable
    ? { kind: "matched", snippet: `${target.host}:${target.port} is accepting connections` }
    : { kind: "waiting", observed: `${target.host}:${target.port} not reachable yet` };
}

async function probeHttp(
  target: Extract<MonitorTarget, { kind: "http" }>,
  context: ToolExecutionContext,
): Promise<ProbeOutcome> {
  const httpClientPort = context.httpClientPort;
  if (!httpClientPort) return { kind: "missing" };
  try {
    const response = await httpClientPort.request(
      {
        url: target.url,
        method: "GET",
        timeoutMs: 5_000,
        maxResponseBytes: 2_048,
      },
      { signal: context.abortSignal },
    );
    const matched = target.status === undefined
      ? response.status >= 200 && response.status < 300
      : response.status === target.status;
    return matched
      ? { kind: "matched", snippet: `${target.url} answered HTTP ${response.status}` }
      : { kind: "waiting", observed: `${target.url} answered HTTP ${response.status}` };
  } catch (error) {
    if (context.abortSignal.aborted) return { kind: "waiting" };
    // 连接失败在轮询语义里就是"还没就绪"；只有明确的 HTTP 结果才算观察到状态。
    const observed = isHttpClientPortError(error)
      ? `request failed: ${error.code}`
      : "request failed";
    return { kind: "waiting", observed };
  }
}

function canConnect(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    signal.addEventListener("abort", () => finish(false), { once: true });
  });
}

function extractSnippet(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index);
  const start = lineStart < 0 ? 0 : lineStart + 1;
  let newlinesAfter = 0;
  let end = text.length;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\n") {
      newlinesAfter += 1;
      if (newlinesAfter > 2) {
        end = cursor;
        break;
      }
    }
  }
  let snippetStart = start;
  for (let count = 0; count < 2 && snippetStart > 0; count += 1) {
    const previousLine = text.lastIndexOf("\n", snippetStart - 2);
    snippetStart = previousLine < 0 ? 0 : previousLine + 1;
  }
  const clipped = text.slice(snippetStart, end);
  return clipped.length > MONITOR_SNIPPET_MAX_CHARS
    ? `${clipped.slice(0, MONITOR_SNIPPET_MAX_CHARS)}\n…[truncated]`
    : clipped;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function monitorFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function monitorResult(input: {
  satisfied: boolean;
  reason: MonitorResult["reason"];
  elapsedMs: number;
  snippet?: string;
  lastObserved?: string;
}): MonitorResult {
  return {
    satisfied: input.satisfied,
    reason: input.reason,
    elapsed_ms: input.elapsedMs,
    ...(input.snippet === undefined ? {} : { snippet: input.snippet }),
    ...(input.lastObserved === undefined ? {} : { last_observed: input.lastObserved }),
  };
}
