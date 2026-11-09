import { z } from "zod";

// ============================================================
// 已适配的外部 coding agent 预设目录
// ============================================================
// 绑定对话框的选项来源。每个预设回答三个问题：
//   1. 怎么调用（driver + 默认 argv）；
//   2. 怎么确认装没装（探测命令）；
//   3. 模型从哪来（可枚举 / 需自定义）。
//
// 只放"已经实测过调用形状"的 CLI：猜一个没验证过的参数组合，用户会得到
// 一个静默失败的绑定，比没有预设更糟。其余 CLI 走 generic-template 手填。

/**
 * 模型目录的来源。
 *
 * - `npm-product-json`：CLI 的 npm 包里带一份 `product.json`，其中 `models[]` 是
 *   权威模型目录，**每个模型各自声明 `reasoning.supportedEfforts`**。这是唯一
 *   可靠的逐模型档位事实源——`--help` 里那行 `--effort (minimal, low, …)` 只是
 *   全局可接受值域，对具体模型并不成立（实测把 low 传给只支持 high 的模型，
 *   CLI 照收不报错，用户无从察觉）。
 * - `help-probe`：从 `--help` 的 `--model` 说明里解析模型名列表（无逐模型档位）。
 * - `command`：跑 preset.modelListCommand（如 `opencode models`）逐行读模型 id。
 *   opencode 的 `--help` 不列模型，模型清单只存在于这条子命令的输出里，既不能
 *   从帮助文本解析，也不会像 codebuddy 那样带逐模型档位信息。
 * - `catalog-cache`：CLI 自己把服务端模型目录缓存在本地（Command Code 的
 *   `~/.commandcode/cache/model-catalog/v1/catalog-*.json`）。缓存同时给出模型 id
 *   与逐模型 `reasoningEfforts`，是 Command Code 唯一不用登录就能读到的权威目录。
 * - `free-text`：完全手填。
 */
export const EXTERNAL_AGENT_MODEL_SOURCES = [
  "static",
  "server-cache",
  "help-probe",
  "command",
  "catalog-cache",
  "free-text",
] as const;
export type ExternalAgentModelSource = (typeof EXTERNAL_AGENT_MODEL_SOURCES)[number];

/** 模型的传参形状：决定在 argv 里补哪个 flag。 */
export const EXTERNAL_AGENT_MODEL_FLAGS = ["--model", "-m", "none"] as const;
export type ExternalAgentModelFlag = (typeof EXTERNAL_AGENT_MODEL_FLAGS)[number];

/**
 * 推理档位的传参形状。
 *
 * - `flag`：`--effort <level>`（claude / codebuddy 实测）；
 * - `config`：`-c key=value`（codex 没有 effort flag，只能覆盖配置项）；
 * - `variant`：拼进模型串 `--model provider/model#<level>`（opencode 实测）——
 *   它没有独立的 effort flag，档位是模型 id 的一部分；传错档位会立刻报
 *   `Variant unavailable for <model>: <variant>`，与 claude-family 的静默接受相反。
 * - `none`：该 CLI 不接受推理档位。
 */
export const EXTERNAL_AGENT_EFFORT_DELIVERIES = ["flag", "config", "variant", "none"] as const;
export type ExternalAgentEffortDelivery = (typeof EXTERNAL_AGENT_EFFORT_DELIVERIES)[number];

export const externalAgentPresetSchema = z.object({
  /** 稳定 id（绑定落库与 UI 选择都用它）。 */
  id: z.string().min(1),
  label: z.string().min(1),
  /** 一句话说明（对话框副标题）。 */
  description: z.string().min(1),
  /**
   * 适配完成度。
   *
   * - `full`：调用形状、流式过程、模型目录、会话落盘扫描都实测过，绑定后能完整用起来
   *   （活动卡实时过程 + 续接列表 + 上下文面板 + 删除）；
   * - `partial`：只验证过最基本的调用形状，模型/档位/过程流对不齐，**不进绑定列表**
   *   （用户选了只会得到一个看起来能用、实际半残的绑定）。
   *
   * 仍然留在目录里：老绑定还需要 `findExternalAgentPreset` 回显 label。
   *
   * 缺省 `full` 是**线上兼容**取向的：探测结果会过一遍这个 schema，旧执行机的
   * payload 没有这个字段，缺省成 `partial` 会让新 UI 一条预设都列不出来；
   * 缺省成 `full` 则退回"全都列"的旧行为，不会比今天更差。
   */
  adaptation: z.enum(["full", "partial"]).default("full"),
  // opencode-exec：`opencode run` 的 stdout 是逐行 JSON 事件流，prompt 走 stdin。
  driver: z.enum([
    "claude-family",
    "codex-exec",
    "opencode-exec",
    // 与 externalAgentBinding 的 EXTERNAL_AGENT_DRIVER_KINDS 保持同步：catalog 不能
    // 反向 import binding（binding 依赖 catalog 的 findExternalAgentPreset）。
    "commandcode-exec",
    "generic-template",
  ]),
  command: z.string().min(1),
  /** 不含 prompt 的固定前缀参数。 */
  args: z.array(z.string()).default([]),
  promptDelivery: z.enum(["argv-append", "stdin", "template"]),
  /**
   * 外部 agent 自己的权限档位参数值（claude-family 的 --permission-mode）。
   *
   * 委派执行需要**能跑命令**：实测 acceptEdits 只放行改文件，Bash 会被拒，
   * 外部 agent 只能退回 Glob 猜目录、返回残缺结果。因此预设给 bypassPermissions
   * ——用户绑定即明示同意把执行交给它。该字段跟随预设代码生效（旧绑定落库的
   * 值不会覆盖新预设，见 buildExternalAgentInvocation）。
   */
  permissionMode: z.string().optional(),
  modelFlag: z.enum(EXTERNAL_AGENT_MODEL_FLAGS),
  modelSource: z.enum(EXTERNAL_AGENT_MODEL_SOURCES),
  /**
   * modelSource=`command` 时要跑的子命令（相对 preset.command 的参数）。
   *
   * 只存参数不存命令：命令永远是被绑定的那个可执行文件，否则"探测哪个 CLI"与
   * "调用哪个 CLI"会分家。
   */
  modelListCommand: z.array(z.string().max(200)).max(10).optional(),
  /** modelSource=static 时的候选。 */
  models: z.array(z.string()).default([]),
  /**
   * modelSource=`command` 时子命令输出的第一行是不是表头（如 qoder 的
   * `--list-models` 先打一行 `MODEL`）。缺省 false：opencode 的 models 输出
   * 没有表头，逐行都是模型 id。（optional 而非 default：预设数组是 as const
   * 字面量，default 会把它变成必填、逼着所有旧预设补字段。）
   */
  modelListSkipHeader: z.boolean().optional(),
  /**
   * 会话落盘根目录（home 下的一级目录名，transcript 扫描/删除用）。
   * 缺省 `.codebuddy`：claude-family 族的既有事实，老预设不带这个字段。
   * qoder 的 CN CLI 用 `~/.qoder-cn`（与 IDE 的 `~/.qoder` 是两棵树）。
   */
  sessionHomeDir: z.string().max(60).optional(),
  /** 推理档位的传参形状；none = 该 CLI 没有这个概念。 */
  effortDelivery: z.enum(EXTERNAL_AGENT_EFFORT_DELIVERIES).default("none"),
  /**
   * effortDelivery=`flag` 时的 argv flag 名。缺省 `--effort`（claude/codebuddy）；
   * qoder 的同义 flag 是 `--reasoning-effort`，传 `--effort` 会被静默吞掉
   * （它不做严格选项校验），档位于是永远不生效。
   */
  effortFlag: z.string().max(40).optional(),
  /**
   * 每个模型的档位候选（model id → levels）。
   *
   * 档位是模型能力：同一 CLI 里不同模型能接受的档位集合不同，不能拿 CLI 级的一张
   * 固定表套所有模型。这张表只放**已核实**的映射；没有映射的模型返回 undefined，
   * 调用方据此不提供档位选择（而不是给一组可能是错的候选）。
   *
   * 键 `""` 表示"未指定模型 / 用 CLI 默认模型"时的候选。
   */
  effortLevelsByModel: z.record(z.string().max(200), z.array(z.string())).default({}),
});
export type ExternalAgentPreset = z.infer<typeof externalAgentPresetSchema>;

/**
 * 单个模型的推理能力（从模型目录读回来的事实）。
 *
 * 与 preset.effortLevelsByModel 的区别：那个是**静态猜测表**，这个是**跑探测读出来的
 * 真实事实**。探测可用时后者优先。
 */
export const externalAgentModelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 该模型可选的档位；空 = 不可选（固定档或没有推理维度）。 */
  supportedEfforts: z.array(z.string()).default([]),
  /** 该模型的默认档位（不可选时就是它实际使用的那个）。 */
  defaultEffort: z.string().optional(),
});
export type ExternalAgentModelInfo = z.infer<typeof externalAgentModelInfoSchema>;

/**
 * 推断某个模型的档位候选。
 *
 * 优先级：
 * 1. 探测回来的真实模型目录（`probedModels`）——唯一权威，逐模型；
 * 2. 静态表的精确模型键；
 * 3. 静态表的 `""` 键（CLI 级兜底）；
 * 4. 空 = 不提供档位选择。
 *
 * 前两步之外都给"猜的候选"，所以探测结果永远优先——实测把低档传给只支持高档的
 * 模型，CLI 会静默接受，用户根本发现不了档位无效。
 */
export function resolveEffortLevels(
  preset: ExternalAgentPreset,
  model: string | undefined,
  probedModels?: readonly ExternalAgentModelInfo[],
): string[] {
  // 服务端目录命中：有 supportedEfforts 用之；固定档回落到 CLI 选择器的缺省档——
  // codebuddy 的 EffortPanel 对固定档也是这么做的（不隐藏，回落基础档）。
  //
  // 例外是 `variant`（opencode）：档位是模型串的一部分，传错档位 CLI 直接报
  // `Variant unavailable for <model>: <level>`——这时"回落缺省档"不是宽容而是必然
  // 失败。所以空候选一律当作"该模型没有档位"，不显示档位入口。
  const probed = probedModels?.find((entry) => entry.id === model);
  if (probed) {
    if (probed.supportedEfforts.length > 0) return probed.supportedEfforts;
    // 空候选的语义按驱动族区分：
    // - variant（opencode）：档位在模型串里，传错档位直接报错；
    // - commandcode-exec：没有 reasoningEfforts 的模型收到 --effort 不会得到有效档位，
    //   显示档位入口只会让用户以为生效了。
    // 两者都返回空。claude-family/codex 的固定档模型则回落到 CLI 选择器缺省档
    // （codebuddy 的 EffortPanel 就是这么做的，隐藏入口反而让人以为不支持）。
    return preset.effortDelivery === "variant" || preset.driver === "commandcode-exec"
      ? []
      : [...CLI_PICKER_DEFAULT_EFFORTS];
  }
  const exact = preset.effortLevelsByModel[model ?? ""];
  if (exact) return exact;
  if (model && preset.effortLevelsByModel[""]) return preset.effortLevelsByModel[""];
  return preset.effortLevelsByModel[""] ?? [];
}

/**
 * 静态档位表的兜底数据（探测不可用时才用）。
 *
 * 已知局限：这三家的 `--help` 都没有逐模型档位清单，所以这里只能登记 CLI 级范围。
 * codebuddy 的权威来源是服务端下发的缓存（登录后才有），探测可用时一律以它为准
 * ——这张表只在读不到缓存时兜底。
 * - claude-code：`--effort` 的合法值固定为这五个（非法值警告原文列出）；
 * - codebuddy：在 claude 那组之上多一个 minimal（`--help` 原文列出）；
 * - codex：档位来自 config.toml 的 `model_reasoning_effort`，本机配置的
 *   `enabled-reasoning-efforts` 是这七项。
 */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEBUDDY_EFFORT_LEVELS = ["minimal", ...CLAUDE_EFFORT_LEVELS] as const;
const CODEX_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "persistent",
  "max",
] as const;

/**
 * 内置预设。
 *
 * 参数形状全部来自本机实测（`--help` / `--version` 与真实调用）：
 * - claude / codebuddy：`-p --output-format json "<prompt>"`，`--model` 取模型 ID，
 *   推理档位是 `--effort <level>`；
 * - codex：非交互入口是 `codex exec`，模型是 `-m`，但它**没有** effort flag——
 *   只能 `-c model_reasoning_effort="…"` 覆盖配置项；
 * - opencode：非交互入口是 `opencode run --format json`（JSONL 事件流），prompt 走
 *   stdin（多行 prompt 进 argv 会被 Windows .cmd shim 截断）；模型来自
 *   `opencode models` 的逐行输出，而不是 --help；没有独立 effort flag。
 */
export const EXTERNAL_AGENT_PRESETS: readonly ExternalAgentPreset[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic 官方 CLI，参数与 codebuddy 同构。",
    adaptation: "partial",
    driver: "claude-family",
    command: "claude",
    // stream-json：逐事件输出，活动卡才能实时展示"正在跑什么命令"。
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    // 交付形状由驱动族知识决定：claude-family 一律 stdin（见 buildExternalAgentInvocation
    // 的注释——Windows cmd shim 会截断多行 argv 且有 8191 上限），落库值不再参与分流。
    promptDelivery: "stdin",
    permissionMode: "bypassPermissions",
    modelFlag: "--model",
    // Claude Code 的 --model 只接受别名或完整模型名，没有可枚举清单。
    modelSource: "free-text",
    models: [],
    effortDelivery: "flag",
    effortLevelsByModel: { "": [...CLAUDE_EFFORT_LEVELS] },
  },
  {
    id: "codebuddy",
    label: "CodeBuddy",
    description: "腾讯 CodeBuddy CLI（WorkBuddy 桌面版内置同一 CLI）。",
    adaptation: "full",
    driver: "claude-family",
    command: "codebuddy",
    // stream-json：逐事件输出，活动卡才能实时展示"正在跑什么命令"。
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    permissionMode: "bypassPermissions",
    modelFlag: "--model",
    // 模型与档位都来自服务端下发的缓存（登录后才有）；product.json 只作兜底。
    modelSource: "server-cache",
    models: [],
    effortDelivery: "flag",
    effortLevelsByModel: { "": [...CODEBUDDY_EFFORT_LEVELS] },
  },
  {
    id: "codex",
    label: "Codex CLI",
    description: "OpenAI Codex CLI，非交互入口为 `codex exec`。",
    adaptation: "partial",
    driver: "codex-exec",
    command: "codex",
    args: ["exec"],
    promptDelivery: "argv-append",
    modelFlag: "-m",
    // Codex 的模型来自 ~/.codex/config.toml，没有可枚举清单。
    modelSource: "free-text",
    models: [],
    effortDelivery: "config",
    effortLevelsByModel: { "": [...CODEX_EFFORT_LEVELS] },
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI（opencode.ai），非交互入口 `opencode run`。",
    adaptation: "full",
    driver: "opencode-exec",
    command: "opencode",
    // --format json：逐行 JSON 事件（text / reasoning / tool_use / …），活动卡才有实时过程。
    args: ["run", "--format", "json"],
    // prompt 经 stdin 交付：既不进 argv（多行会被 cmd shim 截断），也不依赖 CLI 的
    // "管道 stdin 并入 message"以外的任何隐式行为。
    promptDelivery: "stdin",
    // 委派要能跑命令：opencode 的 --auto 自动批准未被显式拒绝的权限，等价于其它族的
    // bypassPermissions（用户绑定即明示同意把执行交给它）。
    permissionMode: "auto",
    modelFlag: "--model",
    // 模型清单只在 `opencode models` 的逐行输出里，--help 不列。
    modelSource: "command",
    modelListCommand: ["models"],
    models: [],
    // 档位走 `--model provider/model#<variant>`（实测 v2.2.5）：没有独立 effort flag，
    // 但每档都真实存在，且传错档位会立刻报 Variant unavailable——所以必须给选择，
    // 靠推理档位是模型能力（逐模型 values 由探测从 ~/.cache/opencode/models.json 读出）。
    effortDelivery: "variant",
    effortLevelsByModel: {},
  },
  {
    id: "qodercli-cn",
    label: "Qoder CLI CN",
    description: "阿里 Qoder CLI CN（QwenWork 桌面版内置，claude-family 同构）。",
    adaptation: "full",
    // 调用形状 2026-11-09 本机实测（qoderclicn 1.1.32 / 1.1.85）：
    // - `-p -o stream-json` 输出与 claude-family 逐字段同构（init/assistant/result、
    //   result.result/is_error/session_id），另有 hook_started/hook_progress/hook_response
    //   等 system 事件——现有解析器只认 assistant/user/result，天然忽略；
    // - 推理档位是 `--reasoning-effort`（CLI 级可接受值域 auto/none/low/medium/high/
    //   xhigh/max/ultracode，但**逐模型**支持集合不同，见下面的表）；
    // - 权限档位值用下划线：bypass_permissions（不是 claude 的驼峰）；
    // - `--list-models` 首行是表头 `MODEL`，其后逐行一个模型名；
    // - 会话落盘 `~/.qoder-cn/projects/<cwd 编码>/<id>.jsonl`（CN CLI 的 config root，
    //   与 IDE 的 `~/.qoder` 是两棵树），布局与 claude-family 同构；
    // - 不在 PATH 上时藏在 %LOCALAPPDATA%\Programs\QwenWorkCN\<版本>\resources\bin\，
    //   解析兜底见 adapters/windows-executable.ts 的已知安装位置表（独立安装版的
    //   `qoderclicn` 会进 PATH，优先级更高）。
    // prompt 经 stdin 交付（与 claude-family 同源，-p + 管道 stdin；避免 Windows
    // 命令行 8191 字符上限）。
    driver: "claude-family",
    command: "qoderclicn",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    permissionMode: "bypass_permissions",
    modelFlag: "--model",
    modelSource: "command",
    modelListCommand: ["--list-models"],
    modelListSkipHeader: true,
    models: [],
    effortDelivery: "flag",
    effortFlag: "--reasoning-effort",
    // 逐模型档位：2026-11-09 用 CLI 自己的 /model + /effort 面板逐模型枚举
    // （qoderclicn 1.1.85，零模型调用；面板标签 → 值：None/Disabled→none、
    // Low→low、Medium→medium、High→high、Extra High→xhigh、Max→max、
    // Ultracode→ultracode）。**不要用 CLI 级值域套所有模型**——旧的
    // low..max 兜底在 Qwen3.8-* 上会把不存在的 high/max 显示出来。
    // 服务端模型目录调整后此表会过时：探测不可用时它是唯一来源，届时重采。
    effortLevelsByModel: {
      // 元模型：服务端自动选模型 / 快速档，面板没有档位入口。
      Auto: [],
      Fast: [],
      "Qwen3.8-Max": ["none", "low", "medium", "xhigh", "ultracode"],
      "Qwen3.8-Flash": ["none", "low", "medium", "xhigh", "ultracode"],
      "DeepSeek-V4-Pro": ["none", "high", "max"],
      "DeepSeek-Flash": ["none", "low", "high", "max"],
      "GLM-5.3": ["none", "low", "high", "max"],
      "GLM-5.3-Flash": ["none", "high", "max"],
      "Kimi-K3.1-Pro": ["none", "low", "high", "max"],
      "Kimi-K2.8-Preview": ["none", "low", "high", "max"],
      "Step-5-Preview": ["none", "low", "high", "max"],
      "MiniMax-M3.1-Flash": ["none", "low", "medium", "high", "xhigh", "max", "ultracode"],
      // 未知/新模型：不给档位（宁可没有入口，也不显示一组可能是错的候选）。
      "": [],
    },
    sessionHomeDir: ".qoder-cn",
  },
  {
    id: "commandcode",
    label: "Command Code",
    description: "Command Code CLI（npm `command-code`；Windows 用 `cmdc`，`cmd` 是系统 shell）。",
    adaptation: "full",
    // 调用形状 2026-11-09 本机实测（command-code 1.88.5）：
    // - 非交互入口是 `-p`（`--print [query]`），prompt 可走 argv 或管道 stdin；这里
    //   固定 stdin（多行 prompt 经 Windows .cmd shim 会被截断，且命令行有 8191 上限）；
    // - `--output-format json` 是 NDJSON：事件帧 `{type:"event",event:{...}}` + 最后
    //   一条 `{type:"result",subtype,finalText,sessionId?}`；
    // - 模型 `--model <id>`；档位 `--effort <level>`，但**逐模型**能力不同，来源见
    //   modelSource=catalog-cache；
    // - headless 默认拒绝写文件/执行 shell，必须 `--yolo`（`--permission-mode yolo`
    //   在 headless 下不解除限制）；`--trust` 跳过项目信任提示，
    //   `--skip-onboarding` 跳过 taste onboarding（自动化运行）；
    // - 续接用 `-r <sessionId>`（headless 只接受显式 id，裸 `--resume` 会报错）；
    // - 会话落盘 `~/.commandcode/projects/<slug>/<id>.jsonl`，slug 规则见
    //   shared 的 cwdToCommandCodeProjectDirName。
    // Windows 上不能用 `cmd`（系统 shell），必须用全名 command-code 或 cmdc。
    driver: "commandcode-exec",
    command: "command-code",
    args: ["-p", "--output-format", "json", "--trust", "--skip-onboarding"],
    promptDelivery: "stdin",
    // invocation 把该值翻译成 `--yolo`（不是 --permission-mode 的取值）。
    permissionMode: "yolo",
    modelFlag: "--model",
    // 模型目录与逐模型档位都在 CLI 的服务端目录缓存里，探测直接读缓存。
    modelSource: "catalog-cache",
    models: [],
    effortDelivery: "flag",
    effortFlag: "--effort",
    // 逐模型档位来自缓存探测；读不到缓存时不提供档位入口，绝不套 CLI 级缺省表
    // （Command Code 里没有 reasoningEfforts 的模型收到 --effort 不会得到有效档位）。
    effortLevelsByModel: { "": [] },
    sessionHomeDir: ".commandcode",
  },
] as const;

export function findExternalAgentPreset(id: string | undefined): ExternalAgentPreset | undefined {
  if (!id) return undefined;
  return EXTERNAL_AGENT_PRESETS.find((preset) => preset.id === id);
}

/**
 * claude-family 会话落盘的 home 一级目录名。
 *
 * 缺省 `.codebuddy`：既有 claude/codebuddy 预设不带 `sessionHomeDir` 字段，行为
 * 与新增之前逐字一致。qoder 的 CN CLI 落在 `~/.qoder-cn`，由预设声明。
 */
export function resolveExternalAgentSessionHomeDir(presetId: string | undefined): string {
  return findExternalAgentPreset(presetId)?.sessionHomeDir ?? ".codebuddy";
}

/**
 * 可供绑定的预设（`adaptation === "full"`）。
 *
 * 绑定对话框与探测只认这一份：半适配的预设留在目录里只是为了老绑定还能回显，
 * 摆进"选一个 agent"列表会让用户以为它能用。
 */
export const EXTERNAL_AGENT_BINDABLE_PRESETS: readonly ExternalAgentPreset[] =
  EXTERNAL_AGENT_PRESETS.filter((preset) => preset.adaptation === "full");

/**
 * 一个预设在本机探测到的状态。
 *
 * 与协议 schema（zcode-protocol-v4/external-agent-probe.ts）保持同形，但定义在
 * shared 顶层：UI 与 bootstrap 都要用它，而 v4 目录只承载线上契约。
 */
export interface ExternalAgentPresetStatus {
  preset: ExternalAgentPreset;
  installed: boolean;
  /** `--version` 首行；未安装时缺席。 */
  version?: string;
  /**
   * 探测**本身**失败了（不是"没装"）：执行端口还没装配、CLI 进程起不来、
   * 命令超时等。有值时 `installed:false` 只代表"没探测到"，不代表"没安装"。
   *
   * 存在的理由：两者在 UI 上曾经长得一模一样，都是"未检测到"——用户以为自
   * 己没装 OpenCode，其实是会话冷启动时探测链路还没就绪。区分开之后，UI 对该
   * 预设显示"探测失败（可重试）"，而不是断言"未安装"。
   */
  probeError?: string;
  /** 模型候选；空 = 该 CLI 不支持枚举，UI 应退回自由输入。 */
  models: string[];
  /** 逐模型档位事实（CLI 自带模型目录）；空 = 读不到，退回静态兜底表。 */
  modelCatalog: ExternalAgentModelInfo[];
}

/**
 * 从 `codebuddy --help` 的 `--model` 说明里抽出支持列表。
 *
 * 形如：`--model <model>  ... Currently supported: (hy4-preview, hy3, ...)`。
 * 解析失败返回空数组——调用方按 free-text 退化，不把"猜不到"当成"没有模型"。
 */
export function parseModelListFromHelp(helpText: string): string[] {
  const match = /supported\s*[:：]\s*\(([^)]*)\)/iu.exec(helpText);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 120);
}

/**
 * 从服务端模型缓存解析模型目录（key = 模型 id）。
 *
 * 这是 codebuddy `/model` 面板的**权威来源**：登录后服务端把目录下发给 CLI，
 * 缓存在 `~/.codebuddy/local_storage/entry_*.info`。与本地 `product.json` 的差别
 * 是实打实的——`/model` 列表里有 `space-bunny`、`minimax-m3.1-flash` 等 9 个
 * product.json 里没有的模型，价格也对不上（deepseek-v4.1-flash 服务端 x0.11、
 * 本地 x0.00）；反过来的 13 个（gpt-5.6-*、gemini-3.5-flash 等）不在 `/model` 里。
 *
 * 缓存形状：`[{userId, data: {models: [...], agents: [{name, models: [id]}], ...}, ts}]`。
 * 模型清单取 `agents` 里 `name === "cli"`（缺省取第一个）那份——它正是面板显示的集合。
 */
export function parseServerModelCache(raw: unknown): ExternalAgentModelInfo[] {
  // 兼容两种输入：完整的用户数组，或探测脚本直接给出的单个 data 对象。
  const users = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
      ? [{ data: raw }]
      : [];
  // 多用户缓存取 ts 最新的那份。
  let best: { ts: number; data: Record<string, unknown> } | undefined;
  for (const user of users) {
    if (!user || typeof user !== "object") continue;
    const data = (user as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const models = (data as { models?: unknown }).models;
    if (!Array.isArray(models) || models.length === 0) continue;
    const ts = typeof (user as { ts?: unknown }).ts === "number" ? (user as { ts: number }).ts : 0;
    if (!best || ts > best.ts) best = { ts, data: data as Record<string, unknown> };
  }
  if (!best) return [];
  const data = best.data as {
    models?: Array<Record<string, unknown>>;
    agents?: Array<Record<string, unknown>>;
  };
  const byId = new Map<string, Record<string, unknown>>();
  for (const m of data.models ?? []) {
    if (m && typeof m === "object" && typeof m.id === "string") byId.set(m.id, m);
  }
  const agents = data.agents ?? [];
  const cli = agents.find((a) => a && a.name === "cli") ?? agents[0];
  const ids =
    cli && Array.isArray(cli.models)
      ? cli.models.filter((id): id is string => typeof id === "string")
      : [...byId.keys()];
  const parsed: ExternalAgentModelInfo[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) {
      // agent 清单里有、目录里没有（理论不达）：仍给占位，让 UI 能显示这个模型。
      parsed.push({ id, name: id, supportedEfforts: [] });
      continue;
    }
    const reasoning =
      m.reasoning && typeof m.reasoning === "object"
        ? (m.reasoning as {
            supportedEfforts?: unknown;
            defaultEffort?: unknown;
            effort?: unknown;
          })
        : undefined;
    const supported = Array.isArray(reasoning?.supportedEfforts)
      ? reasoning.supportedEfforts.filter((value): value is string => typeof value === "string")
      : [];
    const defaultEffort =
      typeof reasoning?.defaultEffort === "string"
        ? reasoning.defaultEffort
        : typeof reasoning?.effort === "string"
          ? reasoning.effort
          : undefined;
    parsed.push({
      id,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : id,
      supportedEfforts: supported,
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return parsed;
}

/**
 * CLI 档位选择器的缺省候选。
 *
 * codebuddy 的 EffortPanel 规则：模型没有 `supportedEfforts`（固定档）时，面板
 * **不隐藏**，而是回落到这组基础档（`filterEffortLevelsForPicker` 的 `ep` 常量）。
 * 固定档模型也是可选的——发出去是否被后端采纳是另一回事，但选择面与 CLI 一致。
 */
export const CLI_PICKER_DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * 从本地 `product.json` 解析模型目录（服务端缓存读不到时的兜底）。
 *
 * 已知局限（实测）：它是构建期快照，与登录后的 `/model` 列表对不上——缺 9 个
 * 服务端新增的模型，多 13 个未上架的；价格也过期。所以只在读不到服务端缓存时
 * 兜底用，档位同样以 `supportedEfforts` 为准（没有 = 固定档，调用方按
 * `CLI_PICKER_DEFAULT_EFFORTS` 回落）。
 */
export function parseModelCatalogFromProductJson(raw: unknown): ExternalAgentModelInfo[] {
  if (!raw || typeof raw !== "object") return [];
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const parsed: ExternalAgentModelInfo[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      id?: unknown;
      name?: unknown;
      reasoning?: unknown;
      supportsReasoning?: unknown;
      onlyReasoning?: unknown;
    };
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const reasoning =
      record.reasoning && typeof record.reasoning === "object"
        ? (record.reasoning as {
            supportedEfforts?: unknown;
            defaultEffort?: unknown;
            effort?: unknown;
          })
        : undefined;
    const supported = Array.isArray(reasoning?.supportedEfforts)
      ? reasoning.supportedEfforts.filter((value): value is string => typeof value === "string")
      : [];
    const defaultEffort =
      typeof reasoning?.defaultEffort === "string"
        ? reasoning.defaultEffort
        : typeof reasoning?.effort === "string"
          ? reasoning.effort
          : undefined;
    const efforts = supported;
    parsed.push({
      id: record.id,
      name: typeof record.name === "string" && record.name.length > 0 ? record.name : record.id,
      supportedEfforts: efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return parsed;
}

// ── Command Code 模型目录 ──
//
// Command Code 把服务端 `/model/list` 的结果整份缓存在
// `~/.commandcode/cache/model-catalog/v1/catalog-*.json`。形状（1.88.5 实测）：
//   {cacheVersion, scope, fetchedAt, renderedAt, body: {catalogVersion, data: [...]}}
// 每个 data 项带 `id`、`name`、`hidden`、`display.label`、`display.order`、
// `reasoningEfforts[]`。这份缓存是"不用登录也能读到的权威逐模型档位"：
// `--list-models` 只打印模型名（还会把 id 小写、按 group 分段），`--help` 的
// `--effort` 只是 CLI 级值域。
//
// 缓存里的模型 id 大小写是权威的（如 `moonshotai/Kimi-K3.1-Pro`），必须原样保留：
// `--list-models` 的展示行会把 id 小写，拿它拼 `--model` 依赖 CLI 的大小写归一，
// 不是稳定契约。
export function parseCommandCodeModelCatalog(raw: unknown): ExternalAgentModelInfo[] {
  const body = (raw as { body?: unknown } | null)?.body;
  const data = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : Array.isArray(raw)
        ? raw
        : [];
  const parsed: Array<{ info: ExternalAgentModelInfo; order: number }> = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      id?: unknown;
      name?: unknown;
      hidden?: unknown;
      reasoningEfforts?: unknown;
      display?: unknown;
    };
    if (typeof record.id !== "string" || !record.id) continue;
    // 缓存里含服务端保留但 CLI 不展示的模型（实测 110 条里 14 条 hidden，
    // `--list-models` 正好是剩下的 96 条）。不过滤会让绑定列表出现选不到的模型。
    if (record.hidden === true) continue;
    const display =
      record.display && typeof record.display === "object"
        ? (record.display as { label?: unknown; order?: unknown })
        : undefined;
    const supported = Array.isArray(record.reasoningEfforts)
      ? record.reasoningEfforts.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const label =
      typeof display?.label === "string" && display.label.trim()
        ? display.label.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : record.id;
    parsed.push({
      info: { id: record.id, name: label, supportedEfforts: supported },
      order: typeof display?.order === "number" ? display.order : Number.POSITIVE_INFINITY,
    });
  }
  // display.order 是 CLI 自己的展示顺序（先 Open Source、再闭源族…）；缺失的保持原序。
  return parsed
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.info);
}

/**
 * 解析 `cmd --list-models` 的人类可读表格（缓存读不到时的兜底）。
 *
 * 输出形如：
 *   Available models  ·  96 models
 *
 *   Open Source
 *
 *   deepseek/deepseek-v4-pro                hybrid-attention long-context reasoning
 *
 * 每行模型是「id + 2 个以上空格 + 描述」；分组标题只有单词，没有双空格分隔。
 * 只取 id（无逐模型档位）。要求 id 至少含 `/`、`.`、`-` 之一，避免把
 * `Available` 之类的标题词当成模型。
 */
export function parseCommandCodeModelList(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\S+)\s{2,}\S/u.exec(line);
    const id = match?.[1]?.trim();
    if (!id || id.length > 120 || !/[./-]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= 200) break;
  }
  return models;
}
