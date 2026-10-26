import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const MONITOR_TOOL_NAME = "Monitor";

export const MONITOR_PROVIDER_DESCRIPTION = `Waits until a condition becomes true instead of sleeping or re-reading logs.

- target_kind="task" + expect_kind="output_matches": watch a background task's output (needs task_id) until \`pattern\` (regex) appears.
- target_kind="file" + expect_kind="file_contains": watch a file (needs file_path) until it contains \`text\`.
- target_kind="port" + expect_kind="reachable": wait until a TCP port accepts a connection (needs port; host defaults to 127.0.0.1).
- target_kind="http" + expect_kind="http_ok": wait until a URL answers 2xx, or exactly \`status\` when given.

Returns as soon as the condition holds, on timeout, or when the target disappears or finishes without matching. Use it after starting \`npm run dev\`, a test watcher, \`docker compose up\`, or a CI poll; use TaskOutput instead when you need the whole output rather than a condition. Prefer a bounded timeout_ms; do not poll with repeated reads.`;

/**
 * 输入刻意保持**扁平**：provider JSON Schema 契约禁止 anyOf/$ref，判别式联合无法直接投影。
 * `target_kind` / `expect_kind` 两个枚举 + 组合校验在 validateInput 与 handler 里完成。
 */
export const MonitorInputSchema = z
  .object({
    target_kind: z
      .enum(["task", "file", "port", "http"])
      .describe("What to watch: a background task, a file, a TCP port, or a URL"),
    expect_kind: z
      .enum(["output_matches", "file_contains", "reachable", "http_ok"])
      .describe("Condition to wait for; must match target_kind"),
    task_id: z.string().optional().describe("Background task ID (target_kind=task)"),
    file_path: z.string().optional().describe("File to watch (target_kind=file)"),
    host: z.string().optional().describe("Host for target_kind=port; defaults to 127.0.0.1"),
    port: z.number().int().min(1).max(65_535).optional().describe("TCP port (target_kind=port)"),
    url: z.string().optional().describe("URL to poll (target_kind=http)"),
    pattern: z
      .string()
      .optional()
      .describe("Regular expression matched against task output (expect_kind=output_matches)"),
    text: z.string().optional().describe("Literal text to wait for (expect_kind=file_contains)"),
    ignore_case: z.boolean().default(false).describe("Case-insensitive match"),
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe("Require this exact HTTP status instead of any 2xx (expect_kind=http_ok)"),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(1_800_000)
      .default(120_000)
      .describe("Give up after this many milliseconds (default 120000, max 1800000)"),
    poll_interval_ms: z
      .number()
      .int()
      .min(50)
      .max(10_000)
      .default(200)
      .describe("Re-check interval in milliseconds (default 200)"),
  })
  .strict();

export type MonitorInput = z.infer<typeof MonitorInputSchema>;

export const MonitorInputJsonSchema = toToolJsonSchema(MonitorInputSchema);

export const MONITOR_REASONS = [
  "matched",
  "timeout",
  "aborted",
  "target_missing",
  "target_terminal",
] as const;

export const MonitorResultSchema = z
  .object({
    satisfied: z.boolean(),
    reason: z.enum(MONITOR_REASONS),
    elapsed_ms: z.number().int().nonnegative(),
    /** 命中处上下各两行，最多 2000 字符。 */
    snippet: z.string().optional(),
    /** 超时/终止时最后观察到的输出尾部或状态，帮助判断目标是否还在推进。 */
    last_observed: z.string().optional(),
  })
  .strict();

export type MonitorResult = z.infer<typeof MonitorResultSchema>;

export const MonitorResultJsonSchema = toToolJsonSchema(MonitorResultSchema);
