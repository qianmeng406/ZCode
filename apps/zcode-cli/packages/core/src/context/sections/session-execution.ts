// ============================================================
// Session Execution Environment Section
// ============================================================
//
// 会话级 Linux/WSL 执行环境激活后，以建议性措辞告诉模型命令类别与 /mnt/c
// 映射下的实测性能差异。提示词不承担禁止/放行语义，实际路由由执行绑定强制。
//
// 性能数字来自同机实测（p50，项目位于 Windows 盘并通过 /mnt/c 映射）：
//   docs/research/session-linux-performance-data/
//   docs/research/session-linux-performance-guidance.md
// 已入库的上游基准（docs/research/wsl-agent-benchmark-report.md）使用 ext4
// 工作区，其 ≈5x 加速结论不适用于本功能的 /mnt/c 映射，不能混用。
// 汇总与限制见 docs/research/session-linux-performance-guidance.md。

import type { SessionExecutionEnvironment } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const SECTION_NAME = "Session Execution Environment";

const ADVISORY_NOTE =
  "These notes are guidance, not hard restrictions; the active execution binding is authoritative.";

const MEASURED_GUIDANCE = [
  "Measured performance guidance (same host, /mnt/c mapping; relative, not guarantees):",
  "- Short shell commands are much cheaper than Windows Git Bash (~2-7 ms vs ~36-60 ms). Prefer a few aggregated commands over many tiny invocations.",
  "- Directory listings and text reads are faster (~7-16x vs Git Bash), but file-dense loops on /mnt/c are ~10x SLOWER (100 small write+read+delete ~600 ms vs ~59 ms). Prefer batching bulk create/read/delete work into one process, and avoid repeated rewrites of many small files or node_modules churn.",
  "- Builds, typecheck and compile show no reliable speedup (~1.0x); better not to rely on this environment for build speed.",
  "- The provided Bash tool is cheaper than invoking wsl.exe from Bash (~107-179 ms per call) or starting a login shell per command (~488 ms); prefer using it directly.",
  "- Installing system packages (apt/sudo/systemd) or overwriting node_modules is best avoided unless the task explicitly requires it; native dependencies may be platform-specific.",
];

const COMMAND_ROUTING = [
  "Command routing:",
  "- Bash commands, background tasks, hooks and subagents run in WSL Linux with POSIX bash.",
  "- File tools (Read/Write/Edit/Glob/Grep) operate on the same mapped project files.",
  "- MCP servers, Browser Use and Computer Use remain on the Windows control plane.",
  "- Windows-only commands (PowerShell, cmd.exe, .exe tools, Windows GUI/signing/packaging) are not part of this session's command routing. If a task genuinely requires one, the usual path is to ask the user to switch the session to 本机默认 (Windows) instead of retrying it in Linux; what can actually run is decided by the active execution binding, not by this note.",
];

export interface SessionExecutionSectionOptions {
  /** 极简档位 / 工作流子代理 / 子代理使用紧凑版，避免破坏体积预算。 */
  compact?: boolean;
}

export function buildSessionExecutionSection(
  environment: SessionExecutionEnvironment | undefined,
  options: SessionExecutionSectionOptions = {},
): ContextSection | null {
  if (environment?.kind !== "wsl") {
    return null;
  }
  const content = options.compact
    ? buildCompactContent(environment)
    : buildFullContent(environment);
  return {
    name: SECTION_NAME,
    source: "session_execution",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildFullContent(environment: Extract<SessionExecutionEnvironment, { kind: "wsl" }>) {
  return [
    `# ${SECTION_NAME}`,
    `This session runs commands in WSL Linux (${environment.distro}, user ${environment.user}). The desktop and control plane remain on Windows; the project directory is mounted from the Windows disk (/mnt/c).`,
    "",
    ADVISORY_NOTE,
    "",
    ...COMMAND_ROUTING,
    "",
    ...MEASURED_GUIDANCE,
  ].join("\n");
}

function buildCompactContent(environment: Extract<SessionExecutionEnvironment, { kind: "wsl" }>) {
  return [
    `# ${SECTION_NAME}`,
    `This session runs commands in WSL Linux (${environment.distro}, user ${environment.user}); the desktop and MCP/Browser/Computer Use remain on Windows. Guidance only; the active execution binding is authoritative.`,
    "- Bash, background tasks, hooks, subagents and file tools use the WSL Linux execution binding.",
    "- Windows-only commands (PowerShell, cmd.exe, .exe, signing/packaging) are not part of this routing; if one is genuinely required, prefer asking the user to switch the session to 本机默认.",
    "- Prefer batching bulk work on /mnt/c (~10x slower for file-dense loops); the provided Bash tool is cheaper than invoking wsl.exe or a login shell per command. Builds show no reliable speedup.",
  ].join("\n");
}
