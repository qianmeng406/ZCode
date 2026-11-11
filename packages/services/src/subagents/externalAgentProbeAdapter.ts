// 设置页外部 CLI 探测的本机执行通道（S6）。
//
// desktop host 装配 subagentsService 时注入：child_process 直接跑探测命令，只探
// 本机。编排与 bootstrap 的会话绑定 v4 RPC 同源（shared/node probeExternalPresets
// ——"哪个 CLI 跑哪条命令、按什么顺序、怎么解析"只有一份知识），本文件只负责把
// "跑一条命令并回收 stdout"落到本机进程。
//
// 语义对齐 bootstrap 的 probeCommand（ExecutionPort 翻译层）：
// - 命令不存在（ENOENT）不抛错，回 `failure` —— 它无法区分"没装"与"PATH 没带过来"，
//   断言成"未安装"会误导用户；
// - 超时 kill 进程，回 `failure`；
// - 命令自己跑完但退出码非零 = `ok:false` 且不带 failure（真的没装/没登录）。
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { ExternalAgentPresetStatus } from "@zcode/shared";
import {
  probeExternalPresets,
  type ExternalAgentProbeCommandInput,
  type ExternalAgentProbeCommandResult,
  type ExternalAgentProbeCommandRunner,
} from "@zcode/shared/node";

const DEFAULT_OUTPUT_BYTES = 64_000;

/** 创建设置页用的本机探测函数；探测结果缓存与否由 UI 侧决定（表单打开时调用）。 */
export function createLocalExternalAgentProbe(): () => Promise<ExternalAgentPresetStatus[] | null> {
  const runCommand: ExternalAgentProbeCommandRunner = (input) => runProbeCommand(input);
  // 探测命令（--version / models list / 读缓存文件）对 cwd 不敏感；
  // home 语义与被探测的 CLI 一致（模型缓存都在 ~/ 下）。
  const cwd = homedir();
  return async () => {
    try {
      return await probeExternalPresets({ runCommand, cwd });
    } catch {
      // probeExternalPresets 本身不抛（各命令失败都归一化）；兜底防御，
      // 不能让一次装配异常把设置页表单打挂。
      return null;
    }
  };
}

async function runProbeCommand(
  input: ExternalAgentProbeCommandInput,
): Promise<ExternalAgentProbeCommandResult> {
  const maxBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  return await new Promise<ExternalAgentProbeCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.file, input.args, {
        cwd: input.cwd,
        // PWD 对齐 cwd：与 bootstrap 同款，opencode 系子命令按 PWD 过滤 project。
        env: { ...process.env, PWD: input.cwd },
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ ok: false, stdout: "", failure: describeError(error) });
      return;
    }
    let stdout = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: ExternalAgentProbeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= maxBytes) return;
      // 硬截断即可：探测输出要么是行式清单（截尾无害），要么是整份 JSON
      // （截断后 parse 失败 → 调用方退回静态兜底，方向与 bootstrap 一致）。
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // ENOENT 等 spawn 失败走 error 事件而不是 throw；不抛错是探测的契约。
      finish({ ok: false, stdout: "", failure: describeError(error) });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({ ok: false, stdout: "", failure: `probe_timeout: ${input.file}` });
        return;
      }
      finish({ ok: code === 0, stdout });
    });
  });
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message.trim()}` : message.trim() || "probe_spawn_failed";
}
