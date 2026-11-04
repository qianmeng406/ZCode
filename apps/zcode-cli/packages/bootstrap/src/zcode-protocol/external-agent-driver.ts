// 外部 coding agent 的进程驱动层。
//
// 第一期只实现一次性执行（OneShotExternalAgentDriver）：用 ExecutionPort 的 argv
// 模式 spawn 外部 CLI，收完全部 stdout 后按 driver 族解析结果。
//
// 接口刻意按「可长驻」设计（submit 返回 runId + 完成信号），第二期换成 PTY 实现时
// 调用方无需改动 —— 只是 run 的生命周期变长、output 变成可持续订阅。
import type { ExecutionPort } from "@zcode/contracts";
import {
  buildExternalAgentInvocation,
  createClaudeStreamParser,
  parseExternalAgentResult,
  type ExternalAgentBinding,
} from "@zcode/shared";

export interface ExternalAgentRunResult {
  /** 外部 agent 的最终回答文本（已按 driver 族解析）。 */
  text: string;
  /** 原始 stdout，调用方需要证据时用。 */
  rawStdout: string;
  exitCode: number;
  isError: boolean;
  durationMs: number;
  /** 外部会话 id：下一轮 `-r` 续接用。 */
  externalSessionId?: string;
  /** 本轮是否带着上一轮的会话续接执行。 */
  continued: boolean;
}

export interface ExternalAgentRunInput {
  binding: ExternalAgentBinding;
  prompt: string;
  cwd: string;
  /** 续接策略：auto（默认，有外部会话就续）/ fresh（强制新会话）。 */
  continuation?: "auto" | "fresh";
  signal?: AbortSignal;
  /** 输出增量回调（第一期只在结束时给一次全文；PTY 期改为逐块）。 */
  onOutput?: (chunk: {
    stream: "stdout" | "stderr";
    text: string;
    preview?: unknown;
    entries?: Array<{ kind: "reasoning" | "text" | "tool"; text: string }>;
  }) => void;
}

export interface ExternalAgentDriver {
  readonly kind: "oneshot";
  run(input: ExternalAgentRunInput): Promise<ExternalAgentRunResult>;
}

/** 一次性执行：spawn → 收全量输出 → 解析。 */
export function createOneShotExternalAgentDriver(input: {
  executionPort: ExecutionPort;
  defaultTimeoutMs?: number;
}): ExternalAgentDriver {
  const defaultTimeoutMs = input.defaultTimeoutMs ?? 600_000;

  return {
    kind: "oneshot",
    async run(runInput) {
      const { binding, prompt, cwd } = runInput;
      const continuation = runInput.continuation ?? "auto";
      const invocation = buildExternalAgentInvocation(binding, prompt, { continuation });
      const startedAt = Date.now();
      // 上一条 tail 快照：用于把累积尾部差分成本次新增输出。
      const lastTail: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
      // 是否已经逐段推送过输出：推过就不再补发全文，否则进度里会出现两遍。
      let streamed = false;
      // 正文是否已经以增量形式推过：推过就不再补整段结果，避免卡片里出现两遍。
      let streamedText = false;
      // claude-family 是 stream-json：逐行解析成结构化条目（思考/正文/工具），
      // 半行 JSON 留在解析器缓冲里；非 JSONL 驱动原样转发。
      const streamParser = createClaudeStreamParser();
      // 结构化条目里出现正文 = 正文已经进过活动卡；末尾的 result 不能再补一遍。
      // （codebuddy 的 result 就是 assistant 正文的全文，重复追加会让面板里同一段
      // 话出现两遍——实测反馈。）
      const emitEntries = (
        entries: Array<{ kind: "reasoning" | "text" | "tool"; text: string }>,
      ) => {
        if (entries.length === 0) return;
        streamed = true;
        if (entries.some((entry) => entry.kind === "text")) streamedText = true;
        runInput.onOutput?.({ stream: "stdout", text: "", entries });
      };
      const emitRaw = (stream: "stdout" | "stderr", text: string) => {
        if (stream === "stderr") {
          streamed = true;
          runInput.onOutput?.({ stream, text });
          return;
        }
        if (binding.driver !== "claude-family") {
          streamed = true;
          runInput.onOutput?.({ stream, text });
          return;
        }
        emitEntries(streamParser.push(text));
      };

      const result = await input.executionPort.run(
        {
          command: {
            mode: "argv",
            file: invocation.command,
            args: invocation.args,
          },
          cwd,
          ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
          ...(binding.env ? { env: { ...binding.env } } : {}),
          timeoutMs: binding.timeoutMs ?? defaultTimeoutMs,
          // 外部 agent 的输出可能很长（-p 全量模式），放宽 inline 上限并落盘。
          outputLimit: {
            maxInlineBytes: 1_000_000,
            maxBufferBytes: 4_000_000,
            persistOutput: "always",
            maxPersistedBytes: 32_000_000,
            tailBytes: 64_000,
          },
        },
        {
          ...(runInput.signal ? { abortSignal: runInput.signal } : {}),
          // 实时进度。两种形状都要接：
          // - Bash 直写文件路径给 `outputPreview`（已是全文预览）；
          // - argv 路径只给 `stdoutTail`/`stderrTail`（累积尾部快照）。
          // 只认前者会让普通进程（codebuddy 就是 argv）一条进度都没有。
          onEvent: (event: {
            type?: string;
            outputPreview?: unknown;
            stdoutTail?: unknown;
            stderrTail?: unknown;
          }) => {
            if (event.type !== "progress") return;
            if (event.outputPreview) {
              runInput.onOutput?.({ stream: "stdout", text: "", preview: event.outputPreview });
              return;
            }
            // 尾部快照是"最后 N 字节"：与上次比前缀，取增量；滚动窗口跳过前缀时
            // 退化成整段（有重复但不会丢内容）。
            const emitTail = (stream: "stdout" | "stderr", value: unknown) => {
              if (typeof value !== "string" || value.length === 0) return;
              const previous = lastTail[stream];
              const delta = value.startsWith(previous) ? value.slice(previous.length) : value;
              lastTail[stream] = value;
              if (delta) emitRaw(stream, delta);
            };
            emitTail("stdout", event.stdoutTail);
            emitTail("stderr", event.stderrTail);
          },
        } as never,
      );

      // 结束时把解析器缓冲里的半行也尝试产出（进程刚好在行中间退出）。
      const flushed = streamParser.flush();
      if (flushed.length > 0) emitEntries(flushed);

      const stdoutView = readStreamOutput(result, "stdout");
      const rawStdout = stdoutView.text;
      const stderr = extractStreamText(result, "stderr");
      // 没逐段推过（执行端没给 progress 事件）才补发全文：已推过就不重复，
      // 否则活动卡的 tail 会出现两遍同样的内容。
      if (!streamed) {
        if (stderr.trim()) runInput.onOutput?.({ stream: "stderr", text: clipProgress(stderr) });
        if (rawStdout) runInput.onOutput?.({ stream: "stdout", text: clipProgress(rawStdout) });
      }

      const parsed = parseExternalAgentResult(binding, rawStdout);
      // 没流式到正文时（模型只回了 result，或没开 partial）：把最终回答作为一条正文条目，
      // 否则活动卡只有工具调用、看不到它的结论。
      if (!streamedText && parsed.text.trim()) {
        runInput.onOutput?.({
          stream: "stdout",
          text: "",
          entries: [{ kind: "text", text: parsed.text }],
        });
      }
      // 解析不出正文时不能静默返回空串：至少要给出证据（字节数/落盘位置），
      // 否则上层只能看到「已完成」，无从判断是 CLI 没输出还是我们没读到。
      const text = parsed.text.trim()
        ? parsed.text
        : rawStdout.trim()
          ? rawStdout
          : describeMissingOutput(stdoutView);
      const exitCode =
        typeof (result as { exitCode?: number }).exitCode === "number"
          ? (result as { exitCode: number }).exitCode
          : parsed.isError
            ? 1
            : 0;

      return {
        text,
        rawStdout,
        exitCode,
        // 退出码非 0 或结构里标了 is_error 都算失败；stderr 单有输出不算失败
        // （很多 CLI 会把进度写到 stderr）。
        isError: parsed.isError || exitCode !== 0,
        durationMs: Date.now() - startedAt,
        ...(parsed.sessionId ? { externalSessionId: parsed.sessionId } : {}),
        // 请求续接且带着 id 才算继续（CLI 起不到旧会话时它自己开新的，语义仍是 fresh）。
        continued: continuation !== "fresh" && Boolean(binding.externalSessionId),
      };
    },
  };
}

interface StreamOutputView {
  text: string;
  bytes?: number;
  artifactPath?: string;
}

/**
 * 从 ExecutionPort.run 的返回值里取某一路输出。
 *
 * 端口返回形状在不同适配器间不一致：`streams.<路>` / 顶层 `<路>`，值可能是字符串
 * 或 `{ text, bytes, tail, artifactPath }`。三条规则：
 * 1. `text` 非空才算读到（空串当缺席——持久化模式下可能只给 tail）；
 * 2. text 缺席时用 `tail`（请求了 tailBytes 时端口保底给尾部）；
 * 3. 都拿不到就退回空串，绝不抛错——但要把 bytes/artifactPath 带出去，
 *    让上层能诊断"是 CLI 没输出还是我们没读到"。
 */
function readStreamOutput(result: unknown, stream: "stdout" | "stderr"): StreamOutputView {
  if (!result || typeof result !== "object") return { text: "" };
  const record = result as Record<string, unknown>;
  const streams = record.streams;
  const fromStreams =
    streams && typeof streams === "object"
      ? readStreamEntry((streams as Record<string, unknown>)[stream])
      : undefined;
  if (fromStreams && (fromStreams.text.length > 0 || fromStreams.bytes !== undefined)) {
    return fromStreams;
  }
  const direct = readStreamEntry(record[stream]);
  if (direct && (direct.text.length > 0 || direct.bytes !== undefined)) return direct;
  // 顶层 tail 只对应 requestedTail，端口把它挂在 stdout 条目上时上面已取到；
  // 这里兜底旧形状（record.tail）。
  if (stream === "stdout" && typeof record.tail === "string") return { text: record.tail };
  return fromStreams ?? direct ?? { text: "" };
}

function readStreamEntry(entry: unknown): StreamOutputView | undefined {
  if (typeof entry === "string") return { text: entry };
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const tail = typeof record.tail === "string" ? record.tail : "";
  return {
    text: text.length > 0 ? text : tail,
    ...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
    ...(typeof record.artifactPath === "string" ? { artifactPath: record.artifactPath } : {}),
  };
}

function extractStreamText(result: unknown, stream: "stdout" | "stderr"): string {
  return readStreamOutput(result, stream).text;
}

/** 完全读不到输出时的说明文本（替代静默空串）。 */
function describeMissingOutput(view: StreamOutputView): string {
  const parts = ["（外部 agent 执行结束，但没有读到可解析的输出）"];
  if (view.bytes !== undefined) parts.push(`stdout 共 ${view.bytes} 字节`);
  if (view.artifactPath) parts.push(`原始输出已落盘：${view.artifactPath}`);
  return parts.join("；");
}

/** 进度事件里最多带这么多字符（尾部，保留最后状态行）。 */
const PROGRESS_CLIP_CHARS = 8_000;

function clipProgress(text: string): string {
  return text.length <= PROGRESS_CLIP_CHARS ? text : text.slice(-PROGRESS_CLIP_CHARS);
}
