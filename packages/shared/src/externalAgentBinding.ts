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
  // opencode：`opencode run --format json` 同样逐行输出 JSON 事件，但事件字段
  // （part.text / part.tool / part.state.input）与 codex、claude 都不同；
  // prompt 走 stdin（不进 argv）。字段不同、错误行语义也不同，所以独立成族。
  "opencode-exec",
  // commandcode：`command-code -p --output-format json` 输出 NDJSON，事件被包在
  // `{type:"event",event:{...}}` 里，最后一条是 `{type:"result",subtype,finalText}`。
  // 与 claude/codex/opencode 的事件字段都不同；权限也特殊（headless 必须 --yolo）。
  "commandcode-exec",
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
     * profile 级显式覆盖（S7 Explore 渠道）：优先级最高，压过预设值。
     *
     * 与落库的 `permissionMode` 是两回事：那个是"绑定时的历史值"，必须跟随预设
     * 升级（跟随代码语义）；override 是"这个身份明确要求的档位"（如 Explore 的
     * 只读 plan 模式），预设值不得盖掉它。缺席时优先级链行为逐字不变。
     */
    permissionModeOverride: z.string().max(40).optional(),
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
    /**
     * 每个模型各自记住的上下文窗口（model key → token 数）。
     *
     * 与档位同理：窗口是**模型能力**，换模型各记各的。值为空 = 不传
     * `--context-window`，用 CLI/服务端默认窗口。
     */
    contextWindowByModel: z.record(z.string().max(200), z.number().int().positive()).optional(),
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

// ============================================================
// 上一次执行的结构化摘要（持久化；冷恢复后回显"上次执行"）
// ============================================================
// 活动快照本身是运行期事实（进程没了就不该显示"运行中"），但"上次跑到什么结果"
// 对用户仍有价值：重启后打开过程面板，至少能看到上次是谁跑的、成没成、多久、
// 结论尾部。只存摘要，不存过程条目——过程属于那一次运行，重放它反而误导。
export const EXTERNAL_AGENT_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
export type ExternalAgentRunStatus = (typeof EXTERNAL_AGENT_RUN_STATUSES)[number];

export const externalAgentRunSummarySchema = z
  .object({
    agentLabel: z.string().min(1).max(80),
    /** 本次委派使用的模型（缺省 = CLI 默认模型）。 */
    model: z.string().max(200).optional(),
    status: z.enum(EXTERNAL_AGENT_RUN_STATUSES),
    /** 收口时间（epoch ms）。 */
    finishedAt: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    /** 最终正文尾部；只用于回显，不参与解析。 */
    tail: z.string().max(4_000).optional(),
  })
  .strict();

export type ExternalAgentRunSummary = z.infer<typeof externalAgentRunSummarySchema>;

// stream-json：逐事件输出（每行一个 JSON），活动卡才能实时展示"正在跑什么命令"。
const CLAUDE_FAMILY_DEFAULT_ARGS = ["-p", "--output-format", "stream-json"] as const;
const CODEX_EXEC_DEFAULT_ARGS = ["exec"] as const;
// --format json 是活动卡实时过程的唯一来源；缺了它就只能等一次性结果。
const OPENCODE_RUN_DEFAULT_ARGS = ["run", "--format", "json"] as const;
// Command Code 的 -p 是 headless 入口，--output-format json 给 NDJSON 事件流。
const COMMAND_CODE_DEFAULT_ARGS = ["-p", "--output-format", "json"] as const;

/**
 * 模型 flag：按驱动族给默认值，绑定时用户显式选过 preset 则用 preset 的。
 * `none` 表示该 CLI 不接受模型参数（generic-template），此时 model 被忽略。
 */
function resolveModelFlag(binding: ExternalAgentBinding): string | undefined {
  if (binding.driver === "codex-exec") return "-m";
  if (binding.driver === "claude-family") return "--model";
  if (binding.driver === "opencode-exec") return "--model";
  if (binding.driver === "commandcode-exec") return "--model";
  return undefined;
}

/**
 * 推理档位的传参。按驱动族决定形状：
 * - claude-family：`--effort <level>`（claude / codebuddy 实测；qoder 的同义 flag
 *   是 `--reasoning-effort`，由预设的 `effortFlag` 声明——它的解析器不校验未知
 *   选项，传 `--effort` 会被静默吞掉，档位永远不生效）；
 * - codex-exec：**没有** effort flag，只能 `-c model_reasoning_effort="<level>"`；
 * - opencode-exec：没有 effort flag，档位是模型串的后缀 `--model provider/model#<level>`
 *   （实测 v2.2.5；传错档位报 `Variant unavailable`）。
 *
 * 档位从 `effortsByModel[当前模型]` 取——它是模型的能力，不是 CLI 的能力。
 * 返回空数组表示该模型没有显式档位（用 CLI 默认），或该族不接受档位
 * （generic-template）——宁可忽略也不能猜一个参数名塞进去。
 *
 * opencode 的档位不由这里产出：它必须跟模型串一起进 `--model`（见调用方），
 * 单独 push 一个 `#low` 会被当成位置参数（prompt 的一部分）。
 */
function resolveEffortArgs(binding: ExternalAgentBinding): string[] {
  const effort = binding.effortsByModel?.[binding.model ?? ""];
  if (!effort) return [];
  if (binding.driver === "claude-family" || binding.driver === "commandcode-exec") {
    const flag = findExternalAgentPreset(binding.presetId)?.effortFlag ?? "--effort";
    return [flag, effort];
  }
  if (binding.driver === "codex-exec") {
    // codex 的 -c 值是 TOML 片段，字符串要带引号；整体作为一个 argv 元素传给 CLI。
    return ["-c", `model_reasoning_effort="${effort}"`];
  }
  return [];
}

/**
 * 显式上下文窗口的传参。
 *
 * 只有预设声明了 `contextWindowFlag` 的 CLI 才产出（qoder 的 `--context-window`）；
 * 值取 `contextWindowByModel[当前模型]`，是正整数 token 数（CLI 校验原文：
 * "Must be a positive integer"）。值为空 = 不传，用 CLI/服务端默认窗口。
 */
function resolveContextWindowArgs(binding: ExternalAgentBinding): string[] {
  const contextWindow = binding.contextWindowByModel?.[binding.model ?? ""];
  if (!contextWindow) return [];
  const flag = findExternalAgentPreset(binding.presetId)?.contextWindowFlag;
  if (!flag) return [];
  return [flag, String(contextWindow)];
}

/**
 * opencode 的模型串：把档位拼成 `#<variant>` 后缀。
 *
 * 模型为空时不拼——没有模型就没有档位可挂（用 CLI 默认）。
 */
function resolveOpencodeModelValue(binding: ExternalAgentBinding): string | undefined {
  if (!binding.model) return undefined;
  const effort = binding.effortsByModel?.[binding.model];
  return effort ? `${binding.model}#${effort}` : binding.model;
}

/**
 * 把绑定展开成可执行的 argv。
 *
 * - claude-family：`{command} -p --output-format json [--model M] [--effort L] "<prompt>"`
 *   （claude / codebuddy 实测同构：`-p` 非交互，`--output-format json` 返回数组，
 *   取 `type:"result"` 的 `.result`）。
 * - codex-exec：`{command} exec [-m M] [-c key=value] "<prompt>"`（非交互入口是子命令）。
 * - opencode-exec：`{command} run --format json [--auto] [--model M] [--session ID]`，
 *   prompt 走 stdin（见该分支注释）。
 * - generic-template：`{command} [...args]`，`{prompt}` 占位替换；
 *   `stdin` 模式则把 prompt 通过 stdin 传入。
 */
export function buildExternalAgentInvocation(
  binding: ExternalAgentBinding,
  prompt: string,
  options?: { continuation?: "auto" | "fresh" },
): { command: string; args: string[]; stdin?: string } {
  if (binding.driver === "claude-family") {
    // 预设的 argv 跟随代码：老绑定落库的 `--output-format json` 不会覆盖新版
    // stream-json，否则活动卡拿不到逐事件输出（用户还得重新绑定才生效）。
    const presetArgs = findExternalAgentPreset(binding.presetId)?.args;
    const base =
      presetArgs && presetArgs.length > 0
        ? [...presetArgs]
        : binding.args.length > 0
          ? [...binding.args]
          : [...CLAUDE_FAMILY_DEFAULT_ARGS];
    const args = [...base];
    const modelFlag = resolveModelFlag(binding);
    if (binding.model && modelFlag) args.push(modelFlag, binding.model);
    args.push(...resolveEffortArgs(binding));
    args.push(...resolveContextWindowArgs(binding));
    // 预设自带的权限档位跟随代码走：绑定落库时抄的是当时的预设值，预设升级
    // （如 acceptEdits 改 bypassPermissions）后旧绑定必须跟着生效，否则用户会
    // 得到一个"能改文件但跑不了命令"的半残执行器。手填命令仍用绑定自己的值。
    const permissionMode =
      binding.permissionModeOverride ??
      findExternalAgentPreset(binding.presetId)?.permissionMode ??
      binding.permissionMode;
    if (permissionMode) args.push("--permission-mode", permissionMode);
    // 续接语义由**用户钉死**（徽标菜单选了哪个外部会话）：有 externalSessionId 就
    // 永远 `-r` 它——包括工具入参传 continuation:"fresh" 时。实测（2026-11-07）让
    // 模型自己决定 fresh 会打断"一直续接"：它动辄判定任务无关另开新会话，用户
    // 想要的跨轮工作线就断了。想换目标/开新会话是用户的动作（菜单里选）。
    // CLI 起不到会话时会自动开新的，不阻塞本次任务；新 id 由端口写回自愈。
    if (binding.externalSessionId) {
      args.push("-r", binding.externalSessionId);
    }
    // prompt 一律走 stdin，不再按落库的 promptDelivery 分流到 argv 末尾追加。
    // 实测（2026-11-07）：Windows 上 claude-family 的 CLI 是 .cmd shim，经 cmd.exe
    // 启动时多行 prompt 从第一个换行处被截断（外部 agent 只收到第一行），且命令行
    // 有 8191 字符上限（长任务书直接「命令行太长」）；stdin 两个限制都没有。
    // claude-family 的 CLI（claude / codebuddy 同构）都支持 `-p` + stdin 提示词，
    // 所以落库的 argv-append 值在此族内不再有意义——传参形状由驱动族知识决定，
    // 与「预设 args 跟随代码」同一取向。
    return { command: binding.command, args, stdin: prompt };
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
  if (binding.driver === "opencode-exec") {
    // 与 claude-family 同一取向：预设 argv 跟随代码，老绑定落库的 args 不覆盖
    // `run --format json`——少了 --format json 就拿不到逐事件过程，只剩最后一坨
    // 结果，且用户还得重新绑定才生效。
    const presetArgs = findExternalAgentPreset(binding.presetId)?.args;
    const base =
      presetArgs && presetArgs.length > 0
        ? [...presetArgs]
        : binding.args.length > 0
          ? [...binding.args]
          : [...OPENCODE_RUN_DEFAULT_ARGS];
    const args = [...base];
    // --auto：自动批准未显式拒绝的权限。非交互委派下没人能点确认框，不给这个
    // 标志外部 agent 会在第一个需要批准的操作上卡死。同样跟随预设代码走，
    // 手填命令仍用绑定自己的值。
    // permissionModeOverride（S7 Explore 渠道）= 该身份要求受限执行：这两族的
    // "档位"不是可选值而是解除限制的开关，保持缺省（不解除）即只读。
    const permissionMode = binding.permissionModeOverride
      ? undefined
      : (findExternalAgentPreset(binding.presetId)?.permissionMode ?? binding.permissionMode);
    if (permissionMode) args.push("--auto");
    const modelFlag = resolveModelFlag(binding);
    // 档位在这族里是模型串的后缀（`provider/model#variant`），必须与 --model 一起进：
    // 单独 push `#low` 会被当位置参数（= prompt 片段），CLI 不会报错，档位静默失效。
    const modelValue = resolveOpencodeModelValue(binding);
    if (modelValue && modelFlag) args.push(modelFlag, modelValue);
    // 续接由用户钉死（与 claude-family 一致）：有 externalSessionId 就永远
    // `--session <id>`，continuation:"fresh" 也不改。opencode 对不存在的 id 会
    // 用这个 id 新建会话，所以续接不会硬失败。
    if (binding.externalSessionId) args.push("--session", binding.externalSessionId);
    // prompt 绝不进 argv：Windows 上 opencode 是 .cmd shim，多行 prompt 经 cmd.exe
    // 会在第一个换行处被截断，长任务书还会撞 8191 字符命令行上限；stdin 两者都没有。
    return { command: binding.command, args, stdin: prompt };
  }
  if (binding.driver === "commandcode-exec") {
    // 与 claude-family 同一取向：预设 argv 跟随代码，老绑定落库的 args 不覆盖
    // `-p --output-format json`——少了它就拿不到逐事件过程，只剩最后一坨结果。
    const presetArgs = findExternalAgentPreset(binding.presetId)?.args;
    const base =
      presetArgs && presetArgs.length > 0
        ? [...presetArgs]
        : binding.args.length > 0
          ? [...binding.args]
          : [...COMMAND_CODE_DEFAULT_ARGS];
    const args = [...base];
    const modelFlag = resolveModelFlag(binding);
    if (binding.model && modelFlag) args.push(modelFlag, binding.model);
    args.push(...resolveEffortArgs(binding));
    // headless 默认拒绝 write_file / shell_command；解除限制的开关是 `--yolo`，不是
    // `--permission-mode yolo`（后者在 headless 下不生效）。权限值跟随预设代码走，
    // 手填命令仍用绑定自己的值。
    //
    // permissionModeOverride（S7 Explore 渠道）= 该身份要求受限执行。
    // **这里必须显式传 `--permission-mode <override>`，不能只是"不加 --yolo"**
    // （2026-11-12 实测）：不传 --yolo 时 write_file / shell_command 确实被拒，
    // 但 **`powershell` 工具完全放行**——它能 New-Item 也能 Remove-Item，
    // 于是"没解锁"实际上仍是可写可删。传 `--permission-mode plan` 后连 powershell
    // 也被拦（四条写入路子全拒，同时读文件/搜索照常），只读承诺才成立。
    const override = binding.permissionModeOverride;
    if (override) {
      args.push("--permission-mode", override);
    } else {
      const permissionMode =
        findExternalAgentPreset(binding.presetId)?.permissionMode ?? binding.permissionMode;
      if (permissionMode) args.push("--yolo");
    }
    // 续接与 claude-family 同语义：headless 只接受显式 id（裸 --resume 会报错），
    // 有 externalSessionId 就永远钉死它。失效 id 是报错还是自动新开未实测
    // （见 docs/specs/commandcode-external-agent-preset.md 的未验证项）。
    if (binding.externalSessionId) {
      args.push("-r", binding.externalSessionId);
    }
    // prompt 一律走 stdin（多行与长度限制同 claude-family）。
    return { command: binding.command, args, stdin: prompt };
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
 * 解析 `opencode run --format json` 的 JSONL 输出。
 *
 * 每行一个事件 `{type, timestamp, sessionID, ...}`：
 * - `text`：正文在 `part.text`。模型可能分成多段输出，段与段之间是不同段落，
 *   所以用空行拼接而不是直接连写（连写会让两段话粘成一句）。
 * - `error`：`error.message` 是失败原因；退出码之外的第二道判据。
 * - `sessionID`：任意事件都带，取第一个非空值即可——它是下一轮 `--session` 续接的凭据。
 *
 * 一条 JSON 都解析不出来（CLI 崩溃后直接打印栈、或 --format 没生效）→ 原文兜底：
 * 宁可把原始输出交给用户，也不能吞成空报告。
 */
export function parseOpencodeRunResult(stdout: string): {
  text: string;
  isError: boolean;
  sessionId?: string;
} {
  const texts: string[] = [];
  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let parsedAny = false;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // 半个事件（进程被杀 / 输出截断）：跳过。
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    parsedAny = true;
    const record = entry as {
      type?: unknown;
      sessionID?: unknown;
      part?: unknown;
      error?: unknown;
    };
    if (!sessionId && typeof record.sessionID === "string" && record.sessionID) {
      sessionId = record.sessionID;
    }
    if (record.type === "text") {
      const part = record.part as { text?: unknown } | undefined;
      if (part && typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
      continue;
    }
    if (record.type === "error") {
      const error = record.error as { message?: unknown } | undefined;
      errorMessage =
        error && typeof error.message === "string" && error.message.trim()
          ? error.message.trim()
          : (errorMessage ?? "OpenCode 返回错误");
    }
  }
  if (!parsedAny) return { text: stdout, isError: false };
  const text = texts.join("\n\n");
  if (errorMessage !== undefined) {
    // 失败时正文也要留着：错误行经常只有一句话，前面打出来的过程是排查线索。
    return {
      text: text ? `${text}\n\n${errorMessage}` : errorMessage,
      isError: true,
      ...(sessionId ? { sessionId } : {}),
    };
  }
  return { text, isError: false, ...(sessionId ? { sessionId } : {}) };
}

/**
 * 解析 `command-code -p --output-format json` 的 NDJSON 输出。
 *
 * 形状（官方 headless 文档 + 1.88.5 bundle 实测）：
 * - 事件帧：`{"type":"event","event":{...}}`（过程，不进最终回答）；
 * - 最后一行：`{"type":"result","subtype":"success|error|max_turns","finalText",
 *   "sessionId"?,"error"?}`。
 *
 * `subtype` 不是 success 一律算失败（max_turns 也是没跑完）；`finalText` 是权威正文，
 * 错误且正文为空时退回 `error` 文本。一条 result 都没有（CLI 崩溃 / 旧版本）时返回
 * 原文：宁可把原始输出交给用户，也不能吞成空报告。
 */
export function parseCommandCodeResult(stdout: string): {
  text: string;
  isError: boolean;
  sessionId?: string;
} {
  let result:
    | {
        subtype?: unknown;
        finalText?: unknown;
        sessionId?: unknown;
        error?: unknown;
      }
    | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // 半个事件（进程被杀 / 输出截断）：跳过。
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type === "result") {
      result = entry as typeof result;
    }
  }
  if (!result) return { text: stdout, isError: false };
  const finalText = typeof result.finalText === "string" ? result.finalText : "";
  const errorText =
    typeof result.error === "string"
      ? result.error.trim()
      : result.error && typeof result.error === "object"
        ? JSON.stringify(result.error)
        : "";
  const sessionId =
    typeof result.sessionId === "string" && result.sessionId.length > 0
      ? result.sessionId
      : undefined;
  const isError = result.subtype !== "success";
  return {
    text: finalText.trim().length > 0 ? finalText : errorText,
    isError,
    ...(sessionId ? { sessionId } : {}),
  };
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

/** 读取某个模型当前的上下文窗口（undefined = 用 CLI 默认窗口）。 */
export function readModelContextWindow(
  binding: ExternalAgentBinding,
  model: string | undefined,
): number | undefined {
  return binding.contextWindowByModel?.[model ?? ""];
}

/**
 * 返回"把某个模型的上下文窗口设为 tokens"后的新绑定（null = 清除该模型的设置）。
 *
 * 与 withModelEffort 同构：窗口按模型分开记，换模型不会串。
 */
export function withModelContextWindow(
  binding: ExternalAgentBinding,
  model: string | undefined,
  tokens: number | null,
): ExternalAgentBinding {
  const key = model ?? "";
  const existing = { ...binding.contextWindowByModel };
  if (tokens && Number.isInteger(tokens) && tokens > 0) existing[key] = tokens;
  else delete existing[key];
  const next: ExternalAgentBinding = { ...binding };
  if (Object.keys(existing).length > 0) next.contextWindowByModel = existing;
  else delete next.contextWindowByModel;
  return next;
}

/**
 * 从外部 agent 的 stdout 提取最终回答。
 *
 * - claude-family + `--output-format json`：返回 `type:"result"` 条目的 `.result`
 *   （实测 codebuddy 2.179.2 / claude 2.1.193 的结构）；解析失败时退回原文。
 * - codex-exec：不加 `--json` 时 stdout 就是最终回答，原样返回；
 *   `is_error` 只能由退出码判定（见 driver）。
 * - opencode-exec：逐行 JSON 事件流，正文由 text 事件拼成（见 parseOpencodeRunResult）。
 * - 其余情况：原文（generic 模板无法假设结构）。
 */
export function parseExternalAgentResult(
  binding: ExternalAgentBinding,
  stdout: string,
): { text: string; isError: boolean; sessionId?: string } {
  if (binding.driver !== "claude-family") {
    // opencode 的 stdout 是 JSONL 事件流，原始文本直接当报告是给用户看一堆 JSON；
    // 必须先在「非 claude-family 一律返回原文」这条短路之前分流。
    if (binding.driver === "opencode-exec") return parseOpencodeRunResult(stdout);
    if (binding.driver === "commandcode-exec") return parseCommandCodeResult(stdout);
    return { text: stdout, isError: false };
  }
  // stream-json：每行一个事件，最后一条 type=result 才是最终结果。
  const streamResult = parseStreamJsonResult(stdout);
  if (streamResult) return streamResult;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { text: stdout, isError: false };
    const result = parsed.find(
      (
        entry,
      ): entry is {
        type: string;
        result?: unknown;
        is_error?: unknown;
        session_id?: unknown;
      } => !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "result",
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

/**
 * 解析 stream-json（JSONL）的最后一条 result 事件。
 *
 * 返回 undefined 表示"不像 JSONL"：调用方回退到旧的整体 JSON 数组解析，
 * 老绑定（args 里还是 `--output-format json`）仍然可用。
 */
function parseStreamJsonResult(
  stdout: string,
): { text: string; isError: boolean; sessionId?: string } | undefined {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
  if (lines.length === 0) return undefined;
  let last: {
    result?: unknown;
    is_error?: unknown;
    session_id?: unknown;
    errors?: unknown;
    error?: unknown;
  } | null = null;
  // 裸错误事件：`{type:"error", error:"…"}`。claude-family 在**根本没进入一轮模型调用**
  // 时就只发它、不发 result（实测 codebuddy：`-r` 指向已失效会话 →
  // `{"type":"error","error":"No conversation found with session ID: …"}`，**退出码 0**）。
  let bareError: string | undefined;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        result?: unknown;
        is_error?: unknown;
        session_id?: unknown;
        errors?: unknown;
        error?: unknown;
      };
      if (entry?.type === "result") last = entry;
      else if (entry?.type === "error" && typeof entry.error === "string" && entry.error.trim()) {
        bareError = entry.error.trim();
      }
    } catch {
      // 半个事件（进程被杀 / 输出截断）：跳过。
    }
  }
  if (!last) {
    // 只有裸错误事件：必须如实报失败。
    //
    // 漏了这一步的后果是**静默假成功**（2026-11-12 实测）：没有 result 时这里返回
    // undefined，调用方退回"原文当正文 + isError:false"，于是子智能体卡片显示
    // "已完成"，正文是一行原始 JSON——而任务其实一行都没跑。退出码是 0，
    // 上层无从纠正。续接 id 过期（会话被清理/换机器）正是最容易撞上的场景。
    return bareError ? { text: bareError, isError: true } : undefined;
  }
  const sessionId =
    typeof last.session_id === "string" && last.session_id.length > 0 ? last.session_id : undefined;
  const resultText = typeof last.result === "string" ? last.result : "";
  return {
    // result 为空但 errors 有内容时（典型：模型名不存在、鉴权失败），把 errors 当成
    // 正文返回。
    //
    // 为什么必须这么做（2026-11-11 实测）：codebuddy 对未知模型的收口是
    // `{subtype:"error_during_execution", is_error:true, result:""…, errors:["400 model
    // [x] service info not found…"]}`——退出码仍是 0。以前只读 result，于是错误信息
    // 变成空串，driver 只好用「没有读到可解析的输出」盖住它，用户完全看不到真实原因
    // （这是模型名写错还是没登录？）。errors 才是这里唯一有诊断价值的内容。
    text: resultText.trim().length > 0 ? resultText : streamResultErrorText(last),
    isError: last.is_error === true,
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * 从 stream-json 的 result 事件里取出可读的错误原因。
 *
 * 只取 `errors`（字符串数组）与 `error`（单值）：这两个是 CLI 实际会放的字段，
 * 其余字段（usage/modelUsage 等）对用户理解失败原因没有帮助。
 */
function streamResultErrorText(last: { errors?: unknown; error?: unknown }): string {
  const messages: string[] = [];
  const errors = last.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item === "string" && item.trim()) messages.push(item.trim());
    }
  } else if (typeof errors === "string" && errors.trim()) {
    messages.push(errors.trim());
  }
  if (messages.length === 0 && typeof last.error === "string" && last.error.trim()) {
    messages.push(last.error.trim());
  }
  return messages.join("\n");
}

/**
 * 把 claude-family 的 `stream-json` 一行解析成人类可读的活动文本。
 *
 * 为什么要这层：codebuddy 的 stdout 是结构化事件（assistant 的 tool_use/text、
 * user 的 tool_result、result），直接展示原始 JSON 用户看不懂。活动卡只关心
 * "它现在在做什么"，所以这里把它压成一行行自然语言：
 *   → Bash: ls src
 *   正在检查目录结构
 *
 * 返回空数组表示这一行没有值得展示的内容（system/user/result 等）。
 */
export function formatClaudeFamilyStreamLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!entry || typeof entry !== "object") return [];
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "assistant" || !record.message || typeof record.message !== "object") {
    return [];
  }
  const content = (record.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      lines.push(item.text.trim());
      continue;
    }
    if (item.type !== "tool_use" || typeof item.name !== "string") continue;
    lines.push(`→ ${describeToolUse(item.name, item.input)}`);
  }
  return lines;
}

/** 工具调用的单行描述：取最有信息量的那个入参。 */
function describeToolUse(name: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const readString = (key: string): string | undefined =>
    typeof args[key] === "string" && (args[key] as string).trim()
      ? (args[key] as string).trim()
      : undefined;
  const detail =
    readString("command") ??
    readString("file_path") ??
    readString("path") ??
    readString("pattern") ??
    readString("query");
  if (!detail) return name;
  return `${name}: ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}`;
}

/** 取消息数组里最后一条 assistant 的文本（兜底，可能为空）。 */
function lastAssistantText(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: unknown;
      role?: unknown;
      content?: unknown;
    };
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
