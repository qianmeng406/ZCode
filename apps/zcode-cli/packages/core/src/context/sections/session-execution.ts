// ============================================================
// Session Execution Environment Section
// ============================================================
//
// 会话级 Linux/WSL 执行环境激活后，告诉模型哪些命令类别在 Linux 执行、
// 哪些仍在 Windows 控制面，以及 /mnt/c 映射下的实测性能差异。
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

const MEASURED_GUIDANCE = [
  "Measured performance guidance (same host, /mnt/c mapping; relative, not guarantees):",
  "- Short shell commands are much cheaper than Windows Git Bash (~2-7 ms vs ~36-60 ms). Prefer a few aggregated commands over many tiny invocations.",
  "- Directory listings and text reads are faster (~7-16x vs Git Bash), but file-dense loops on /mnt/c are ~10x SLOWER (100 small write+read+delete ~600 ms vs ~59 ms). Avoid mass create/read/delete loops, repeated rewrites of many small files, and node_modules churn; batch bulk work into one process.",
  "- Builds, typecheck and compile show no reliable speedup (~1.0x); do not choose this environment for build-speed claims.",
  "- Never invoke wsl.exe from Bash (~107-179 ms per call) or a login shell per command (~488 ms). Use the provided Bash tool directly.",
  "- Do not install system packages (apt/sudo/systemd) or overwrite node_modules; native dependencies may be platform-specific.",
];

const COMMAND_ROUTING = [
  "Command routing:",
  "- Bash commands, background tasks, hooks and subagents run in WSL Linux with POSIX bash.",
  "- File tools (Read/Write/Edit/Glob/Grep) operate on the same mapped project files.",
  "- MCP servers, Browser Use and Computer Use remain on the Windows control plane.",
  "- Windows-only commands (PowerShell, cmd.exe, .exe tools, Windows GUI/signing/packaging) cannot run here. Ask the user to switch the session to 本机默认 (Windows); do not retry them in Linux.",
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
    ...COMMAND_ROUTING,
    "",
    ...MEASURED_GUIDANCE,
  ].join("\n");
}

function buildCompactContent(environment: Extract<SessionExecutionEnvironment, { kind: "wsl" }>) {
  return [
    `# ${SECTION_NAME}`,
    `This session runs commands in WSL Linux (${environment.distro}, user ${environment.user}); the desktop and MCP/Browser/Computer Use remain on Windows.`,
    "- Bash, background tasks, hooks, subagents and file tools use the WSL Linux execution binding.",
    "- Windows-only commands (PowerShell, cmd.exe, .exe, signing/packaging) cannot run here; ask the user to switch the session to 本机默认.",
    "- File-dense loops on /mnt/c are ~10x slower than Windows: batch bulk work. Never invoke wsl.exe or a login shell per command. Builds show no reliable speedup.",
  ].join("\n");
}
