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
});
export type ExternalAgentPreset = z.infer<typeof externalAgentPresetSchema>;

/**
 * 内置预设。
 *
 * 参数形状全部来自本机实测（`--help` / `--version` 与真实调用）：
 * - claude / codebuddy：`-p --output-format json "<prompt>"`，`--model` 取模型 ID；
 * - codex：非交互入口是 `codex exec`，模型是 `-m`（`--model` 亦可）。
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
