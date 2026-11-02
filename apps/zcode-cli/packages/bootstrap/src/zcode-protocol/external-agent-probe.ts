// 外部 agent 的本地探测：装没装、什么版本、有哪些模型。
//
// 这是绑定对话框的"事实来源"。对话框本身不跑进程——它只读这里给出的结果，
// 这样 UI 侧没有 spawn 权限，也避免每次打开对话框都探测一遍。
//
// 三条探测各自的失败语义（都不抛错，UI 需要的是"能不能用"而不是异常）：
// - 版本探测失败 = 未安装/不可执行 → installed: false；
// - 模型探测失败 = 空清单 → 对话框退回自由输入，不把"猜不到"呈现成"没有模型"。
import type { ExecutionPort } from "@zcode/contracts";
import {
  EXTERNAL_AGENT_PRESETS,
  parseModelListFromHelp,
  type ExternalAgentPreset,
} from "@zcode/shared";

/** 一个预设在本机的实测状态。 */
export interface ExternalAgentPresetStatus {
  preset: ExternalAgentPreset;
  installed: boolean;
  /** `--version` 的原始首行（未安装时缺席）。 */
  version?: string;
  /** 模型候选；空 = 该 CLI 不支持枚举（UI 退回自由输入）。 */
  models: string[];
}

/** 探测结果的 RPC 形状（只读、无状态、超时重发安全）。 */
export interface ExternalAgentProbeResult {
  agents: ExternalAgentPresetStatus[];
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 跑一条短命令并回收输出。
 *
 * 复用 ExecutionPort 而不是自己 spawn：探测与执行走同一条进程边界，
 * 远程/容器会话里的探测因此也能落到正确的工作机上（与 Bash 工具同源）。
 */
async function probeCommand(
  executionPort: ExecutionPort,
  file: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = (await executionPort.run(
      {
        command: { mode: "argv", file, args },
        cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
        outputLimit: {
          maxInlineBytes: 64_000,
          maxBufferBytes: 64_000,
          persistOutput: "none",
          tailBytes: 8_000,
        },
      },
      {},
    )) as unknown;
    // spawn 失败时端口**不抛错**，而是回一个带 error 的结果且 exitCode 缺席。
    // 只看 exitCode 会把"命令不存在"判成成功——探测的整个意义就没了。
    if (hasExecutionError(result)) return { ok: false, stdout: "" };
    const exitCode =
      typeof (result as { exitCode?: number }).exitCode === "number"
        ? (result as { exitCode: number }).exitCode
        : 0;
    return { ok: exitCode === 0, stdout: readStdout(result) };
  } catch {
    // 命令不存在 / 不可执行 / 超时：一律按"未安装"处理。
    return { ok: false, stdout: "" };
  }
}

/**
 * 端口是否回了执行级错误（spawn_error / timeout / cancelled / output_limit…）。
 *
 * 这是探测"装没装"的唯一可靠判据：命令不存在时端口不抛错，只把 error 放进结果，
 * 而 exitCode 字段是缺席的（不是非零）。
 */
function hasExecutionError(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const error = (result as { error?: unknown }).error;
  if (error !== undefined && error !== null) return true;
  const status = (result as { status?: unknown }).status;
  return status !== undefined && status !== "completed";
}

/**
 * 从端口的 run 结果里取 stdout 文本。
 *
 * 端口实测形状是 `{ stdout: { text, bytes, truncated, tail } }`（对象，不是字符串）；
 * 旧适配器可能直接给字符串。两种都收，取不到回空串——绝不把"取不到"当成失败。
 */
function readStdout(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const streams = record.streams;
  if (streams && typeof streams === "object") {
    const fromStreams = readStreamEntry((streams as Record<string, unknown>).stdout);
    if (fromStreams !== undefined) return fromStreams;
  }
  return readStreamEntry(record.stdout) ?? "";
}

/** 单路输出的兼容读取：字符串 / `{text}` / `{tail}` 三种形态。 */
function readStreamEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const text = (entry as { text?: unknown }).text;
  if (typeof text === "string") return text;
  const tail = (entry as { tail?: unknown }).tail;
  return typeof tail === "string" ? tail : undefined;
}

/** 单个预设的探测：先版本，装了才查模型。 */
async function probePreset(
  executionPort: ExecutionPort,
  preset: ExternalAgentPreset,
  cwd: string,
): Promise<ExternalAgentPresetStatus> {
  const versionProbe = await probeCommand(executionPort, preset.command, ["--version"], cwd);
  if (!versionProbe.ok) {
    return { preset, installed: false, models: [] };
  }
  const version = versionProbe.stdout.trim().split(/\r?\n/u)[0]?.trim() || undefined;
  if (preset.modelSource !== "help-probe") {
    return { preset, installed: true, ...(version ? { version } : {}), models: [] };
  }
  // static 与 help-probe 之外都是自由输入；只有 help-probe 才值得再起一个进程。
  const helpProbe = await probeCommand(executionPort, preset.command, ["--help"], cwd);
  return {
    preset,
    installed: true,
    ...(version ? { version } : {}),
    models: helpProbe.ok ? parseModelListFromHelp(helpProbe.stdout) : [],
  };
}

/**
 * 探测全部内置预设。
 *
 * 并发探测：三条命令互不依赖，串行会让对话框打开慢 3 倍。
 */
export async function probeExternalAgents(options: {
  executionPort: ExecutionPort;
  cwd: string;
}): Promise<ExternalAgentProbeResult> {
  const agents = await Promise.all(
    EXTERNAL_AGENT_PRESETS.map((preset) =>
      probePreset(options.executionPort, preset, options.cwd),
    ),
  );
  return { agents };
}
