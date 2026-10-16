// WSL 连接耗时分解的支持纯函数（参数扩展、阶段归因、命令 detail 脱敏）。
// 规格见 docs/research/wsl-connection-latency.spec.md。
// 纯函数无 IO，主驱动 wsl-connect-latency.ts 负责真实测量。
import { parseSmokeArgs, type WslWorkspaceSmokeOptions } from "./wsl-workspace-smoke-args.js";

export interface WslConnectLatencyOptions {
  iterations: number;
  smoke: WslWorkspaceSmokeOptions;
}

/** 在 smoke 参数之外接受 --iterations N（默认 5，范围 1..50）。 */
export function parseLatencyArgs(argv: string[]): WslConnectLatencyOptions {
  const rest: string[] = [];
  let iterations = 5;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === "--iterations") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/u.test(value)) {
        throw new Error("--iterations 需要正整数");
      }
      iterations = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    rest.push(item);
  }
  if (iterations < 1 || iterations > 50) {
    throw new Error("--iterations 范围 1..50");
  }
  return { iterations, smoke: parseSmokeArgs(rest) };
}

/** connectRemote 日志标记时间点（performance.now 时基，缺失为 undefined）。 */
export interface ConnectMarkerTimes {
  detecting?: number;
  detected?: number;
  deploying?: number;
  deployComplete?: number;
  launching?: number;
  execStarted?: number;
  handshaking?: number;
  handshakeDone?: number;
}

export interface ConnectPhaseBreakdown {
  detectMs: number | null;
  runtimeNetworkMs: number | null;
  deployMs: number | null;
  launchMs: number | null;
  handshakeMs: number | null;
  wrapMs: number | null;
  /** 总墙钟减去已归因段；含调用前隙与 execStarted→handshaking 等小隙，不得虚减。 */
  unattributedMs: number;
}

function segment(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined) return null;
  return Math.max(0, end - start);
}

/** 把连接墙钟按日志标记归因到六段；标记缺失时该段为 null，缺口落入 unattributedMs。 */
export function attributeConnectPhases(
  marks: ConnectMarkerTimes,
  startedAtMs: number,
  finishedAtMs: number,
): ConnectPhaseBreakdown {
  const span = Math.max(0, finishedAtMs - startedAtMs);
  const detectMs = segment(marks.detecting, marks.detected);
  const runtimeNetworkMs = segment(marks.detected, marks.deploying);
  const deployMs = segment(marks.deploying, marks.deployComplete);
  // launch 起点优先取 deploy complete；skipDeploy 场景退化到 launching 标记。
  const launchMs = segment(marks.deployComplete ?? marks.launching, marks.execStarted);
  const handshakeMs = segment(marks.handshaking, marks.handshakeDone);
  const wrapMs = segment(marks.handshakeDone, finishedAtMs);
  const attributed =
    (detectMs ?? 0) +
    (runtimeNetworkMs ?? 0) +
    (deployMs ?? 0) +
    (launchMs ?? 0) +
    (handshakeMs ?? 0) +
    (wrapMs ?? 0);
  return {
    detectMs,
    runtimeNetworkMs,
    deployMs,
    launchMs,
    handshakeMs,
    wrapMs,
    unattributedMs: Math.max(0, span - attributed),
  };
}

const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|APIKEY|API_KEY|API-KEY)[A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|\S+)/giu;

/** 命令 detail 脱敏：凭据类赋值替换为 <redacted>，并截断到 240 字符。 */
export function sanitizeCommandDetail(text: string): string {
  const redacted = text.replace(SECRET_ASSIGNMENT, "$1=<redacted>");
  return redacted.length > 240 ? redacted.slice(0, 240) : redacted;
}
