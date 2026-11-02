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
}

export interface ExternalAgentRunInput {
  binding: ExternalAgentBinding;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  /** 输出增量回调（第一期只在结束时给一次全文；PTY 期改为逐块）。 */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
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
      const invocation = buildExternalAgentInvocation(binding, prompt);
      const startedAt = Date.now();

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
        } as never,
      );

      const rawStdout = extractStreamText(result, "stdout");
      const stderr = extractStreamText(result, "stderr");
      if (stderr.trim()) runInput.onOutput?.({ stream: "stderr", text: stderr });
      if (rawStdout) runInput.onOutput?.({ stream: "stdout", text: rawStdout });

      const parsed = parseExternalAgentResult(binding, rawStdout);
      const exitCode =
        typeof (result as { exitCode?: number }).exitCode === "number"
          ? (result as { exitCode: number }).exitCode
          : parsed.isError
            ? 1
            : 0;

      return {
        text: parsed.text,
        rawStdout,
        exitCode,
        // 退出码非 0 或结构里标了 is_error 都算失败；stderr 单有输出不算失败
        // （很多 CLI 会把进度写到 stderr）。
        isError: parsed.isError || exitCode !== 0,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * 从 ExecutionPort.run 的返回值里取某一路文本。
 *
 * 端口返回形状在不同适配器间略有差异（streams / stdout / tail），这里做兼容读取：
 * 优先按路取，其次取 tail，最后退回空串——绝不抛错，避免把"取不到输出"伪装成失败。
 */
function extractStreamText(result: unknown, stream: "stdout" | "stderr"): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const streams = record.streams;
  if (streams && typeof streams === "object") {
    const entry = (streams as Record<string, unknown>)[stream];
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string") return text;
      const tail = (entry as { tail?: unknown }).tail;
      if (typeof tail === "string") return tail;
    }
  }
  const direct = record[stream];
  if (typeof direct === "string") return direct;
  const tail = record.tail;
  if (stream === "stdout" && typeof tail === "string") return tail;
  return "";
}
