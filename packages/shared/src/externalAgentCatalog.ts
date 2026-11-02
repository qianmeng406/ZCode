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
 * - `free-text`：完全手填。
 */
export const EXTERNAL_AGENT_MODEL_SOURCES = [
  "static",
  "npm-product-json",
  "help-probe",
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
 * - `none`：该 CLI 不接受推理档位。
 */
export const EXTERNAL_AGENT_EFFORT_DELIVERIES = ["flag", "config", "none"] as const;
export type ExternalAgentEffortDelivery = (typeof EXTERNAL_AGENT_EFFORT_DELIVERIES)[number];

export const externalAgentPresetSchema = z.object({
  /** 稳定 id（绑定落库与 UI 选择都用它）。 */
  id: z.string().min(1),
  label: z.string().min(1),
  /** 一句话说明（对话框副标题）。 */
  description: z.string().min(1),
  driver: z.enum(["claude-family", "codex-exec", "generic-template"]),
  command: z.string().min(1),
  /** 不含 prompt 的固定前缀参数。 */
  args: z.array(z.string()).default([]),
  promptDelivery: z.enum(["argv-append", "stdin", "template"]),
  /** 外部 agent 自己的只读档位参数值（如 claude-family 的 --permission-mode）。 */
  permissionMode: z.string().optional(),
  modelFlag: z.enum(EXTERNAL_AGENT_MODEL_FLAGS),
  modelSource: z.enum(EXTERNAL_AGENT_MODEL_SOURCES),
  /** modelSource=static 时的候选。 */
  models: z.array(z.string()).default([]),
  /** 推理档位的传参形状；none = 该 CLI 没有这个概念。 */
  effortDelivery: z.enum(EXTERNAL_AGENT_EFFORT_DELIVERIES).default("none"),
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
  const probed = probedModels?.find((entry) => entry.id === model);
  if (probed) return probed.supportedEfforts;
  const exact = preset.effortLevelsByModel[model ?? ""];
  if (exact) return exact;
  if (model && preset.effortLevelsByModel[""]) return preset.effortLevelsByModel[""];
  return preset.effortLevelsByModel[""] ?? [];
}

/**
 * 静态档位表的兜底数据（探测不可用时才用）。
 *
 * 已知局限：这三家的 `--help` 都没有逐模型档位清单，所以这里只能登记 CLI 级范围。
 * codebuddy 有权威来源（npm 包里的 product.json，逐模型 supportedEfforts），
 * 探测可用时一律以它为准——这张表只在读不到目录时兜底。
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
 *   只能 `-c model_reasoning_effort="…"` 覆盖配置项。
 */
export const EXTERNAL_AGENT_PRESETS: readonly ExternalAgentPreset[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic 官方 CLI，参数与 codebuddy 同构。",
    driver: "claude-family",
    command: "claude",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
    permissionMode: "acceptEdits",
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
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
    permissionMode: "acceptEdits",
    modelFlag: "--model",
    // codebuddy 的 npm 包带 product.json（逐模型 supportedEfforts）——比 --help 权威。
    modelSource: "npm-product-json",
    models: [],
    effortDelivery: "flag",
    // codebuddy 的 --effort 比 claude 多一个 minimal。
    effortLevelsByModel: { "": [...CODEBUDDY_EFFORT_LEVELS] },
  },
  {
    id: "codex",
    label: "Codex CLI",
    description: "OpenAI Codex CLI，非交互入口为 `codex exec`。",
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
] as const;

export function findExternalAgentPreset(id: string | undefined): ExternalAgentPreset | undefined {
  if (!id) return undefined;
  return EXTERNAL_AGENT_PRESETS.find((preset) => preset.id === id);
}

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
 * 从 CLI 的 `product.json` 解析逐模型档位。
 *
 * codebuddy（及其 WorkBuddy 桌面版）的 npm 包里带一份产品清单，其中 `models[]`
 * 是权威模型目录。每个模型的 `reasoning` 有两种形态：
 *
 * - `{ effort: "high" }`               —— 固定档，不可选；
 * - `{ supportedEfforts: [...], defaultEffort: "high" }` —— 可选。
 *
 * 这是唯一可靠的逐模型档位事实源：`--help` 里那行全局值域对具体模型并不成立，
 * 而 CLI 对不支持的档位**静默接受**（实测把 low 传给只支持 high 的模型照样返回成功），
 * 所以拿错表用户根本察觉不到。
 *
 * 解析失败返回空数组：调用方退回静态表，不把"读不到"当成"没有模型"。
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
    parsed.push({
      id: record.id,
      name: typeof record.name === "string" && record.name.length > 0 ? record.name : record.id,
      supportedEfforts: supported,
      ...(defaultEffort ? { defaultEffort } : {}),
    });
  }
  return parsed;
}
