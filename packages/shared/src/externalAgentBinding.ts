import { z } from "zod";

// ============================================================
// 会话绑定的外部 coding agent（只读主控 + 委派执行）
// ============================================================
// 语义：会话绑定一个外部 agent CLI 后，主会话进入只读（plan）模式——它能读、
// 能分析、能出计划，但不能改文件；计划通过 DelegateToExternalAgent 工具交给
// 绑定的外部 agent 执行。
//
// 只保存驱动所需的静态配置；进程句柄、输出缓冲、session_id 等运行态一律不持久化。

/** 驱动族：决定参数形状。claude-family 覆盖 codebuddy / claude 等同构 CLI。 */
export const EXTERNAL_AGENT_DRIVER_KINDS = ["claude-family", "generic-template"] as const;
export type ExternalAgentDriverKind = (typeof EXTERNAL_AGENT_DRIVER_KINDS)[number];

/** prompt 怎么交给外部 CLI。 */
export const EXTERNAL_AGENT_PROMPT_DELIVERIES = ["argv-append", "stdin", "template"] as const;
export type ExternalAgentPromptDelivery = (typeof EXTERNAL_AGENT_PROMPT_DELIVERIES)[number];

const PROMPT_PLACEHOLDER = "{prompt}";

// 命令/参数是用户显式配置，不是来自模型的输入；这里只做基本的空值与非空校验，
// 不做路径白名单——绑定是显式用户操作，与 Bash 工具的动态调用性质不同。
export const externalAgentBindingSchema = z
  .object({
    /** 展示名（如 "workbuddy / codebuddy"）。 */
    label: z.string().min(1).max(80),
    driver: z.enum(EXTERNAL_AGENT_DRIVER_KINDS),
    /** 可执行文件或命令名（claude-family 默认 "codebuddy"）。 */
    command: z.string().min(1).max(500),
    /** 追加参数；template 模式下只有这里能出现 {prompt}。 */
    args: z.array(z.string().max(2_000)).max(50).default([]),
    promptDelivery: z.enum(EXTERNAL_AGENT_PROMPT_DELIVERIES),
    /** 外部 agent 自己的只读档位（claude-family 下为 --permission-mode 的值）。 */
    permissionMode: z.string().max(40).optional(),
    /** 额外环境变量（如 CODEBUDDY_FORCE_LITE_WB_BUNDLE）。 */
    env: z.record(z.string(), z.string()).optional(),
    /** 单次委派的超时（ms）；缺省由调用方兜底。 */
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    /** 绑定时被覆盖的 plan 状态，解绑时据此恢复。 */
    previousPlanEnabled: z.boolean().optional(),
  })
  .strict();

export type ExternalAgentBinding = z.infer<typeof externalAgentBindingSchema>;

const CLAUDE_FAMILY_DEFAULT_ARGS = ["-p", "--output-format", "json"] as const;

/**
 * 把绑定展开成可执行的 argv。
 *
 * - claude-family：`{command} -p --output-format json [...args] "<prompt>"`
 *   （codebuddy / claude 实测同构：`-p` 非交互，`--output-format json` 返回数组，
 *   取 `type:"result"` 的 `.result`）。
 * - generic-template：`{command} [...args]`，`{prompt}` 占位替换；
 *   `stdin` 模式则把 prompt 通过 stdin 传入。
 */
export function buildExternalAgentInvocation(
  binding: ExternalAgentBinding,
  prompt: string,
): { command: string; args: string[]; stdin?: string } {
  if (binding.driver === "claude-family") {
    const base = binding.args.length > 0 ? binding.args : [...CLAUDE_FAMILY_DEFAULT_ARGS];
    const args = [...base];
    if (binding.permissionMode) args.push("--permission-mode", binding.permissionMode);
    if (binding.promptDelivery === "stdin")
      return { command: binding.command, args, stdin: prompt };
    // argv-append / template 在 family 族里都落到末尾追加 prompt。
    args.push(prompt);
    return { command: binding.command, args };
  }
  // generic-template：只有 args 参与，{prompt} 显式占位。
  const args = binding.args.map((arg) =>
    arg.includes(PROMPT_PLACEHOLDER) ? arg.split(PROMPT_PLACEHOLDER).join(prompt) : arg,
  );
  if (binding.promptDelivery === "stdin") return { command: binding.command, args, stdin: prompt };
  if (!binding.args.some((arg) => arg.includes(PROMPT_PLACEHOLDER))) args.push(prompt);
  return { command: binding.command, args };
}

/**
 * 从外部 agent 的 stdout 提取最终回答。
 *
 * - claude-family + `--output-format json`：返回 `type:"result"` 条目的 `.result`
 *   （实测 codebuddy 2.179.2 的结构）；解析失败时退回原文。
 * - 其余情况：原文（generic 模板无法假设结构）。
 */
export function parseExternalAgentResult(
  binding: ExternalAgentBinding,
  stdout: string,
): { text: string; isError: boolean } {
  if (binding.driver !== "claude-family") return { text: stdout, isError: false };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { text: stdout, isError: false };
    const result = parsed.find(
      (entry): entry is { type: string; result?: unknown; is_error?: unknown } =>
        !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "result",
    );
    if (!result) return { text: stdout, isError: false };
    return {
      text: typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? ""),
      isError: result.is_error === true,
    };
  } catch {
    return { text: stdout, isError: false };
  }
}
