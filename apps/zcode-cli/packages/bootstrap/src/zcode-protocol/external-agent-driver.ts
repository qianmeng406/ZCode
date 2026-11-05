// 外部 coding agent 的进程驱动层。
//
// 第一期只实现一次性执行（OneShotExternalAgentDriver）：用 ExecutionPort 的 argv
// 模式 spawn 外部 CLI，收完全部 stdout 后按 driver 族解析结果。
//
// 接口刻意按「可长驻」设计（submit 返回 runId + 完成信号），第二期换成 PTY 实现时
// 调用方无需改动 —— 只是 run 的生命周期变长、output 变成可持续订阅。
import type { ExecutionPort } from "@zcode/contracts";
import { readFileSync, statSync } from "node:fs";
import {
  buildExternalAgentInvocation,
  createClaudeStreamParser,
  parseClaudeFamilyStreamActivities,
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
    /** true = entries 是收口后的权威重建，接收方应整体替换已累积的条目。 */
    replace?: boolean;
    /** 源输出被截断（artifact 超出重解析上限，只读了结尾）：必须透传到活动快照。 */
    sourceTruncated?: boolean;
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
      // 全量 stdout：inline 视图只保留**前** maxInlineBytes，result 事件在末尾，
      // 用截断视图解析必然失败（真实事故：6.5MB 输出的委派把 1MB JSONL 当结果
      // 回传给主 agent，再被工具预算二次截断）。
      const fullStdoutView =
        binding.driver === "claude-family"
          ? readFullStdout(stdoutView)
          : // 其它 driver 不落 artifact 兜底解析，就直接沿用执行端报告的截断事实。
            { text: rawStdout, truncated: stdoutView.truncated === true };
      const fullStdout = fullStdoutView.text;
      // 源输出被截断（artifact > 重解析上限）：必须让面板知道「更早的过程没解析」，
      // 否则用户只会看到一份从中间开始的记录，却以为任务本身丢了内容。
      if (fullStdoutView.truncated) {
        runInput.onOutput?.({ stream: "stdout", text: "", sourceTruncated: true });
      }

      // 权威重建（claude-family）：执行中的条目来自滚动尾窗差分，行会被窗口
      // 切断、内容会重复/丢段。进程结束后 stdout artifact 里有全量字节，用它
      // 整体重解析并把活动条目整体替换掉——最终面板必须完整且有序。
      // 解析结果为空（非 JSONL 等）时保持原样，不破坏已有条目。
      if (binding.driver === "claude-family") {
        const authoritative = parseClaudeFamilyStreamActivities(fullStdout);
        if (authoritative.length > 0) {
          streamed = true;
          if (authoritative.some((entry) => entry.kind === "text")) streamedText = true;
          runInput.onOutput?.({
            stream: "stdout",
            text: "",
            entries: authoritative,
            replace: true,
          });
        }
      }

      // 没逐段推过（执行端没给 progress 事件）才补发全文：已推过就不重复，
      // 否则活动卡的 tail 会出现两遍同样的内容。
      if (!streamed) {
        if (stderr.trim()) runInput.onOutput?.({ stream: "stderr", text: clipProgress(stderr) });
        if (rawStdout) runInput.onOutput?.({ stream: "stdout", text: clipProgress(rawStdout) });
      }

      // 结果必须从全量 stdout 解析（artifact 优先），不能拿 inline 截断视图。
      const parsed = parseExternalAgentResult(binding, fullStdout);
      const parsedText = parsed.text.trim();
      // 解析不到 result 时 parseExternalAgentResult 会把原始 stdout 当正文返回；
      // claude-family 的 JSONL 不是正文——既不能进活动条目，也不能当委派结果。
      const hasResultText =
        parsedText.length > 0 &&
        !(binding.driver === "claude-family" && looksLikeStreamJson(parsedText));
      // 没流式到正文时（模型只回了 result，或没开 partial）：把最终回答作为一条正文条目，
      // 否则活动卡只有工具调用、看不到它的结论。
      if (!streamedText && hasResultText) {
        runInput.onOutput?.({
          stream: "stdout",
          text: "",
          entries: [{ kind: "text", text: parsed.text }],
        });
      }
      // 解析不出正文时不能静默返回空串：至少要给出证据（字节数/落盘位置），
      // 否则上层只能看到「已完成」，无从判断是 CLI 没输出还是我们没读到。
      const text = hasResultText
        ? parsed.text
        : binding.driver === "claude-family" && looksLikeStreamJson(fullStdout)
          ? describeMissingOutput(stdoutView)
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

export interface StreamOutputView {
  text: string;
  bytes?: number;
  artifactPath?: string;
  /** 执行端自己报告的"inline 文本被截断"（输出超过 maxInlineBytes）。 */
  truncated?: boolean;
  /** 落盘 artifact 自身也被持久化上限截断（更早的字节根本没落盘）。 */
  artifactTruncated?: boolean;
}

/** 收口重解析的读取上限；driver 的 outputLimit.maxPersistedBytes 与它一致。 */
const MAX_REPARSE_BYTES = 32_000_000;

/**
 * 收口重解析用的全量 stdout：优先落盘 artifact（inline 超限时 text 只是
 * 截断视图），其次内存 text。读失败退回内存视图，绝不抛错——
 * 重解析是锦上添花，不能把收口流程拖失败。
 *
 * `truncated` 表示源数据本身不全（artifact 超上限只读了尾部，或 inline 视图
 * 被截断且没有 artifact 可回落）：上层据此在面板上提示「更早的过程缺失」，
 * 而不是静默当作完整记录。
 */
export function readFullStdout(
  view: StreamOutputView,
  maxBytes: number = MAX_REPARSE_BYTES,
): { text: string; truncated: boolean } {
  if (view.artifactPath) {
    try {
      const stat = statSync(view.artifactPath);
      if (stat.isFile() && stat.size > 0) {
        if (stat.size <= maxBytes) {
          // 读到了完整 artifact：即便 inline 视图被截断也不算源数据不全，
          // 但 artifact 自己若被持久化上限截过，更早的字节就是真的没了。
          return {
            text: readFileSync(view.artifactPath, "utf8"),
            truncated: view.artifactTruncated === true,
          };
        }
        // 超上限：取尾部（结尾的 result 事件最关键），起始半行解析器会跳过。
        const buffer = readFileSync(view.artifactPath);
        return {
          text: buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString("utf8"),
          truncated: true,
        };
      }
    } catch {
      // artifact 缺席/不可读：退回内存视图（readStreamOutput 已把 tail 并进 text）。
    }
  }
  return { text: view.text, truncated: view.truncated === true };
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
    // 执行端本来就报告了截断事实（ExecutionStreamResult.truncated/artifactTruncated），
    // 以前在这里被丢掉，导致非 claude-family 的截断完全静默。
    ...(record.truncated === true ? { truncated: true } : {}),
    ...(record.artifactTruncated === true ? { artifactTruncated: true } : {}),
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

/** 是否像 claude-family 的 stream-json（首行就是 {"type":...} 事件）。 */
function looksLikeStreamJson(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith("{") && head.includes('"type"');
}

/** 进度事件里最多带这么多字符（尾部，保留最后状态行）。 */
const PROGRESS_CLIP_CHARS = 8_000;

function clipProgress(text: string): string {
  return text.length <= PROGRESS_CLIP_CHARS ? text : text.slice(-PROGRESS_CLIP_CHARS);
}
