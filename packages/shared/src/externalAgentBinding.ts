import { z } from "zod";
import { findExternalAgentPreset } from "./externalAgentCatalog.js";

// ============================================================
// 会话绑定的外部 coding agent（只读主控 + 委派执行）
// ============================================================
// 语义：会话绑定一个外部 agent CLI 后，主会话进入只读（plan）模式——它能读、
// 能分析、能出计划，但不能改文件；计划通过 DelegateToExternalAgent 工具交给
// 绑定的外部 agent 执行。
//
// 只保存驱动所需的静态配置；进程句柄、输出缓冲、session_id 等运行态一律不持久化。

/** 驱动族：决定参数形状与输出解析。 */
export const EXTERNAL_AGENT_DRIVER_KINDS = [
  "claude-family",
  // codex 的非交互入口是子命令 `codex exec`，输出是 JSONL 事件流，
  // 与 claude 族的"单个 JSON 数组"不同，所以必须独立成族。
  "codex-exec",
  "generic-template",
] as const;
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
    /**
     * 内置预设 id（绑定来自哪个已适配的 agent）。
     * 只作溯源与 UI 回显；真正的调用形状仍由 driver/args 决定，
     * 这样用户手改过参数后不会因为预设目录变化而被静默改写。
     */
    presetId: z.string().max(60).optional(),
    /** 外部 agent 使用的模型（为空 = 用该 CLI 的默认模型）。 */
    model: z.string().max(200).optional(),
    /**
     * 每个模型各自记住的推理档位（model key → level）。
     *
     * 档位是**模型能力**，不是 CLI 能力：同一个 CLI 里不同模型支持的一组档位不同，
     * 换模型后沿用旧档位可能根本无效（claude 会警告后静默退回默认，codebuddy 直接
     * 收下）。所以按模型分开记，而不是在绑定上挂一个全局值。
     *
     * key 用 model 的原始 id；空串 key 对应"没指定模型（用 CLI 默认模型）"这一档。
     * 值为空 = 该模型用 CLI 默认档位。
     */
    effortsByModel: z.record(z.string().max(200), z.string().max(40)).optional(),
    /** 额外环境变量（如 CODEBUDDY_FORCE_LITE_WB_BUNDLE）。 */
    env: z.record(z.string(), z.string()).optional(),
    /**
     * 上次委派的外部会话 id（CLI 自报，如 codebuddy 的 session_id）。
     *
     * 续接靠它：下次委派带上 `-r <id>`，外部 agent 就能接着上一轮的上下文干活
     * （"接着刚才的改"）。恢复失败（会话过期/被清理）时 CLI 自己开新会话，不阻塞。
     */
    externalSessionId: z.string().max(200).optional(),
    /** 单次委派的超时（ms）；缺省由调用方兜底。 */
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    /** 绑定时被覆盖的 plan 状态，解绑时据此恢复。 */
    previousPlanEnabled: z.boolean().optional(),
    /** 绑定时被覆盖的协作模式，解绑时据此恢复。 */
    previousMode: z.string().max(40).optional(),
  })
  .strict();

export type ExternalAgentBinding = z.infer<typeof externalAgentBindingSchema>;

const CLAUDE_FAMILY_DEFAULT_ARGS = ["-p", "--output-format", "json"] as const;
const CODEX_EXEC_DEFAULT_ARGS = ["exec"] as const;

/**
 * 模型 flag：按驱动族给默认值，绑定时用户显式选过 preset 则用 preset 的。
 * `none` 表示该 CLI 不接受模型参数（generic-template），此时 model 被忽略。
 */
function resolveModelFlag(binding: ExternalAgentBinding): string | undefined {
  if (binding.driver === "codex-exec") return "-m";
  if (binding.driver === "claude-family") return "--model";
  return undefined;
}

/**
 * 推理档位的传参。按驱动族决定形状：
 * - claude-family：`--effort <level>`（两家实测都支持）；
 * - codex-exec：**没有** effort flag，只能 `-c model_reasoning_effort="<level>"`。
 *
 * 档位从 `effortsByModel[当前模型]` 取——它是模型的能力，不是 CLI 的能力。
 * 返回空数组表示该模型没有显式档位（用 CLI 默认），或该族不接受档位
 * （generic-template）——宁可忽略也不能猜一个参数名塞进去。
 */
function resolveEffortArgs(binding: ExternalAgentBinding): string[] {
  const effort = binding.effortsByModel?.[binding.model ?? ""];
  if (!effort) return [];
  if (binding.driver === "claude-family") return ["--effort", effort];
  if (binding.driver === "codex-exec") {
    // codex 的 -c 值是 TOML 片段，字符串要带引号；整体作为一个 argv 元素传给 CLI。
    return ["-c", `model_reasoning_effort="${effort}"`];
  }
  return [];
}

/**
 * 把绑定展开成可执行的 argv。
 *
 * - claude-family：`{command} -p --output-format json [--model M] [--effort L] "<prompt>"`
 *   （claude / codebuddy 实测同构：`-p` 非交互，`--output-format json` 返回数组，
 *   取 `type:"result"` 的 `.result`）。
 * - codex-exec：`{command} exec [-m M] [-c key=value] "<prompt>"`（非交互入口是子命令）。
 * - generic-template：`{command} [...args]`，`{prompt}` 占位替换；
 *   `stdin` 模式则把 prompt 通过 stdin 传入。
 */
export function buildExternalAgentInvocation(
  binding: ExternalAgentBinding,
  prompt: string,
  options?: { continuation?: "auto" | "fresh" },
): { command: string; args: string[]; stdin?: string } {
  if (binding.driver === "claude-family") {
    const base = binding.args.length > 0 ? binding.args : [...CLAUDE_FAMILY_DEFAULT_ARGS];
    const args = [...base];
    const modelFlag = resolveModelFlag(binding);
    if (binding.model && modelFlag) args.push(modelFlag, binding.model);
    args.push(...resolveEffortArgs(binding));
    // 预设自带的权限档位跟随代码走：绑定落库时抄的是当时的预设值，预设升级
    // （如 acceptEdits 改 bypassPermissions）后旧绑定必须跟着生效，否则用户会
    // 得到一个"能改文件但跑不了命令"的半残执行器。手填命令仍用绑定自己的值。
    const permissionMode =
      findExternalAgentPreset(binding.presetId)?.permissionMode ?? binding.permissionMode;
    if (permissionMode) args.push("--permission-mode", permissionMode);
    // 续接上一轮外部会话：`-r <id>` 让两次委派共享上下文（CLI 自己起不到会话时
    // 会自动开新的，不阻塞本次任务）。
    if (options?.continuation !== "fresh" && binding.externalSessionId) {
      args.push("-r", binding.externalSessionId);
    }
    if (binding.promptDelivery === "stdin")
      return { command: binding.command, args, stdin: prompt };
    // argv-append / template 在 family 族里都落到末尾追加 prompt。
    args.push(prompt);
    return { command: binding.command, args };
  }
  if (binding.driver === "codex-exec") {
    const base = binding.args.length > 0 ? binding.args : [...CODEX_EXEC_DEFAULT_ARGS];
    const args = [...base];
    const modelFlag = resolveModelFlag(binding);
    if (binding.model && modelFlag) args.push(modelFlag, binding.model);
    args.push(...resolveEffortArgs(binding));
    if (binding.promptDelivery === "stdin")
      return { command: binding.command, args, stdin: prompt };
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

/** 读取某个模型当前的推理档位（undefined = 用该 CLI 默认档位）。 */
export function readModelEffort(
  binding: ExternalAgentBinding,
  model: string | undefined,
): string | undefined {
  return binding.effortsByModel?.[model ?? ""];
}

/**
 * 返回"把某个模型的档位设为 level"后的新绑定（level 为 null/空 = 清除该模型的档位）。
 *
 * 只动 effortsByModel 里的一条：换 A 模型的档位不影响 B 模型记着的值——
 * 这正是"档位属于模型"的实现。
 */
export function withModelEffort(
  binding: ExternalAgentBinding,
  model: string | undefined,
  level: string | null,
): ExternalAgentBinding {
  const key = model ?? "";
  const existing = { ...binding.effortsByModel };
  const normalized = level?.trim();
  if (normalized) existing[key] = normalized;
  else delete existing[key];
  const next: ExternalAgentBinding = { ...binding };
  if (Object.keys(existing).length > 0) next.effortsByModel = existing;
  else delete next.effortsByModel;
  return next;
}

/**
 * 从外部 agent 的 stdout 提取最终回答。
 *
 * - claude-family + `--output-format json`：返回 `type:"result"` 条目的 `.result`
 *   （实测 codebuddy 2.179.2 / claude 2.1.193 的结构）；解析失败时退回原文。
 * - codex-exec：不加 `--json` 时 stdout 就是最终回答，原样返回；
 *   `is_error` 只能由退出码判定（见 driver）。
 * - 其余情况：原文（generic 模板无法假设结构）。
 */
export function parseExternalAgentResult(
  binding: ExternalAgentBinding,
  stdout: string,
): { text: string; isError: boolean; sessionId?: string } {
  if (binding.driver !== "claude-family") return { text: stdout, isError: false };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { text: stdout, isError: false };
    const result = parsed.find(
      (
        entry,
      ): entry is { type: string; result?: unknown; is_error?: unknown; session_id?: unknown } =>
        !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "result",
    );
    if (!result) return { text: stdout, isError: false };
    const body =
      typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "");
    // 有些版本会给出空的 result 但消息数组里有 assistant 正文：退到最后一轮
    // assistant 的 output_text，别把"有回答但没装进 result 字段"当成空回答。
    const text = body.trim().length > 0 ? body : lastAssistantText(parsed);
    // session_id 是下一轮 `-r` 续接的凭据；CLI 没给就缺席（重开会话）。
    const sessionId =
      typeof result.session_id === "string" && result.session_id.length > 0
        ? result.session_id
        : undefined;
    return {
      text,
      isError: result.is_error === true,
      ...(sessionId ? { sessionId } : {}),
    };
  } catch {
    return { text: stdout, isError: false };
  }
}

/** 取消息数组里最后一条 assistant 的文本（兜底，可能为空）。 */
function lastAssistantText(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; role?: unknown; content?: unknown };
    if (entry?.type !== "message" || entry.role !== "assistant" || !Array.isArray(entry.content)) {
      continue;
    }
    const text = entry.content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}
