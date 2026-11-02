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

/** 模型清单的来源策略。 */
export const EXTERNAL_AGENT_MODEL_SOURCES = ["static", "help-probe", "free-text"] as const;
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
 * 推断某个模型的档位候选。
 *
 * 先查精确的模型键，再退回 `""`（CLI 默认模型那一档）。两处都没有 = 该模型
 * 没有已知档位能力，调用方应隐藏档位选择——给一组猜的候选比不给更糟
 * （用户选了才发现无效）。
 */
export function resolveEffortLevels(
  preset: ExternalAgentPreset,
  model: string | undefined,
): string[] {
  const exact = preset.effortLevelsByModel[model ?? ""];
  if (exact) return exact;
  if (model && preset.effortLevelsByModel[""]) return preset.effortLevelsByModel[""];
  return preset.effortLevelsByModel[""] ?? [];
}

/**
 * 各 CLI 的档位候选表（按键 `""` = CLI 默认模型那一档）。
 *
 * 实测事实：这三家的 `--help` 都没有"每模型档位"清单，也没有可枚举的模型能力接口
 * （claude 的非法值警告列的是 CLI 级同一组、codebuddy 静默接受任意值、codex 接受
 * 任意模型名）。因此这里只登记**能确证**的范围：
 * - claude-code：`--effort` 的合法值固定为这五个（非法值警告原文列出），
 *   即对任意模型都是同一组；
 * - codebuddy：在 claude 那组之上多一个 minimal（`--help` 原文列出）；
 * - codex：档位来自 config.toml 的 `model_reasoning_effort`，本机配置的
 *   `enabled-reasoning-efforts` 是这七项。
 *
 * 结构是 per-model 的（`effortLevelsByModel`）：一旦将来拿到真实的逐模型数据，
 * 只需在这里补键，调用方与 UI 都不用改。
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
    // codebuddy --help 把支持列表直接印在 --model 的说明里，可解析。
    modelSource: "help-probe",
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
