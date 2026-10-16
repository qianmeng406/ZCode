/* eslint-disable no-console -- 验收脚本以控制台输出为交付物。 */
// WSL 连接耗时分解测量驱动（opt-in）：把标准 connectRemote 的墙钟按日志标记归因到
// detect / runtimeNetwork / deploy / launch / handshake / wrap 六段，并记录 backend
// observer 的 detect/exec/upload/exists/readFile 调用明细与 wsl.exe 裸往返校准。
// 只测量、不改产品行为；observer 仅包装不改变语义。规格见 docs/research/wsl-connection-latency.spec.md。
// 用法: npx tsx packages/server/scripts/wsl-connect-latency.ts --distro Ubuntu-24.04
//   --user zcodewslp2 --workspace /home/zcodewslp2/workspace
//   --mock-cdn-dir <绝对路径> --output <结果json绝对路径> [--iterations 10]
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ZCODE_VERSION } from "@zcode/shared";
import {
  connectRemote,
  createRemoteBackend,
  isWSLAvailable,
  listWSLDistros,
  type RemoteConnection,
} from "@zcode/server/remote";
import { resolveEffectiveAssetsRoot } from "./wsl-workspace-smoke-assets.js";
import {
  attributeConnectPhases,
  parseLatencyArgs,
  sanitizeCommandDetail,
  type ConnectMarkerTimes,
  type WslConnectLatencyOptions,
} from "./wsl-connect-latency-support.js";

const execFileAsync = promisify(execFile);
type ObservedBackend = Awaited<ReturnType<typeof createRemoteBackend>>;

interface BackendCallRecord {
  method: "detect" | "exec" | "upload" | "exists" | "readFile";
  durationMs: number;
  detail: string;
}

interface IterationRecord {
  iteration: number;
  totalMs?: number;
  systemRpcMs?: number;
  disposeMs?: number;
  identity?: { platform: string; homedir: string };
  phases?: ReturnType<typeof attributeConnectPhases>;
  backendCalls: BackendCallRecord[];
  error?: string;
}

/** Proxy 包装 backend：只给五个 IO 方法计时，其余成员原样转发且 this 指向原实例。 */
function observeBackendCalls(backend: ObservedBackend, sink: BackendCallRecord[]): ObservedBackend {
  const timed = new Set(["detect", "exec", "upload", "exists", "readFile"]);
  return new Proxy(backend, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof property === "string" && timed.has(property) && typeof value === "function") {
        const method = property as BackendCallRecord["method"];
        return async (...args: unknown[]) => {
          const startedAt = performance.now();
          try {
            return await (value as (...inner: unknown[]) => unknown).apply(target, args);
          } finally {
            const rawDetail =
              method === "exec"
                ? String(args[0] ?? "")
                : method === "upload"
                  ? String(args[1] ?? args[0] ?? "")
                  : String(args[0] ?? "");
            sink.push({
              method,
              durationMs: performance.now() - startedAt,
              detail: sanitizeCommandDetail(rawDetail),
            });
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ObservedBackend;
}

/** 捕获 connectRemote 的阶段日志标记时间戳；日志照常透传。 */
function captureConnectMarkers(): { marks: ConnectMarkerTimes; restore: () => void } {
  const originalLog = console.log;
  const marks: ConnectMarkerTimes = {};
  console.log = (...args: unknown[]) => {
    const text = args
      .map((item) => {
        if (typeof item === "string") return item;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
    const now = performance.now();
    if (text.includes("detecting remote env")) marks.detecting ??= now;
    else if (text.includes("detected:")) marks.detected ??= now;
    else if (text.includes("deploying server")) marks.deploying ??= now;
    else if (text.includes("deploy complete")) marks.deployComplete ??= now;
    else if (text.includes("launching remote server")) marks.launching ??= now;
    else if (text.includes("remote server exec started")) marks.execStarted ??= now;
    else if (text.includes("performing handshake")) marks.handshaking ??= now;
    else if (text.includes("handshake done")) marks.handshakeDone ??= now;
    originalLog(...args);
  };
  return {
    marks,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function stats(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs: median,
    maxMs: sorted.at(-1)!,
    meanMs: sorted.reduce((sum, item) => sum + item, 0) / sorted.length,
  };
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function run(): Promise<void> {
  const { iterations, smoke: options }: WslConnectLatencyOptions = parseLatencyArgs(
    process.argv.slice(2),
  );
  const emit = async (
    status: "passed" | "failed" | "skipped",
    payload: Record<string, unknown>,
    notes: string[],
  ) => {
    const body = {
      schema: "wsl-connect-latency/v1",
      status,
      distro: options.distro,
      user: options.user,
      workspace: options.workspace,
      mode: "warm-idempotent",
      zcodeVersion: ZCODE_VERSION,
      finishedAt: new Date().toISOString(),
      ...payload,
      ...(notes.length > 0 ? { notes } : {}),
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    console.log(`\n=== 结果: ${status} ===`);
    console.log(`结构化结果已写入: ${options.output}`);
    if (status === "failed") process.exitCode = 1;
  };

  if (process.platform !== "win32") {
    await emit("skipped", { iterationsRequested: iterations }, [
      `非 Windows 平台(${process.platform})，WSL 驱动明确 skip`,
    ]);
    return;
  }
  if (!(await isWSLAvailable())) {
    await emit("skipped", { iterationsRequested: iterations }, ["wsl.exe 不可用，明确 skip"]);
    return;
  }
  const distros = await listWSLDistros();
  if (!distros.some((item) => item.name === options.distro)) {
    throw new Error(`WSL 发行版不存在: ${options.distro}`);
  }

  const assets = await resolveEffectiveAssetsRoot(options.mockCdnDir);
  try {
    const releaseDir = `${assets.root}/releases/${ZCODE_VERSION}`.replaceAll("\\", "/");
    if (!existsSync(`${releaseDir}/server/zcode-server.cjs`)) {
      throw new Error(`随包资源缺件: ${releaseDir}/server/zcode-server.cjs 不存在`);
    }
    // 校准：同 distro/user 的 wsl.exe 裸往返，解释单条 backend.exec 的固定跨界成本。
    const calibrationSamples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const startedAt = performance.now();
      await execFileAsync("wsl.exe", ["-d", options.distro, "-u", options.user, "--exec", "true"], {
        timeout: 20_000,
        windowsHide: true,
      });
      calibrationSamples.push(performance.now() - startedAt);
    }
    console.log(`calibration: ${calibrationSamples.map((item) => item.toFixed(1)).join(", ")}ms`);

    const target = { kind: "wsl" as const, distro: options.distro, user: options.user };
    const connectOptions = {
      mockCdnDir: assets.root,
      assetInstallMode: "local-download-upload" as const,
      clientId: "wsl-connect-latency",
      handshakeTimeout: 30_000,
    };
    const perIteration: IterationRecord[] = [];
    let failed = false;
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const backend = await createRemoteBackend(target);
      const calls: BackendCallRecord[] = [];
      const observed = observeBackendCalls(backend, calls);
      const { marks, restore } = captureConnectMarkers();
      const record: IterationRecord = { iteration, backendCalls: calls };
      let connection: RemoteConnection | null = null;
      try {
        const startedAt = performance.now();
        connection = await connectRemote(observed, connectOptions);
        const finishedAt = performance.now();
        restore();
        record.totalMs = finishedAt - startedAt;
        record.phases = attributeConnectPhases(marks, startedAt, finishedAt);
        const rpcStart = performance.now();
        const info = await connection.services.systemService.info();
        record.systemRpcMs = performance.now() - rpcStart;
        record.identity = { platform: info.platform, homedir: info.homedir };
        console.log(
          `iter ${iteration}/${iterations} total=${record.totalMs.toFixed(0)}ms ` +
            `detect=${record.phases.detectMs ?? "-"} network=${record.phases.runtimeNetworkMs ?? "-"} ` +
            `deploy=${record.phases.deployMs ?? "-"} launch=${record.phases.launchMs ?? "-"} ` +
            `handshake=${record.phases.handshakeMs ?? "-"} wrap=${record.phases.wrapMs ?? "-"} ` +
            `unattributed=${record.phases.unattributedMs.toFixed(0)}`,
        );
      } catch (error) {
        restore();
        record.error = error instanceof Error ? error.message : String(error);
        failed = true;
        console.error(`iter ${iteration} 失败: ${record.error}`);
      } finally {
        if (connection) {
          const disposeStart = performance.now();
          try {
            await connection.disposeAndWait({ timeoutMs: 10_000 });
          } catch (error) {
            console.warn("disposeAndWait 失败:", error);
          }
          record.disposeMs = performance.now() - disposeStart;
        }
        try {
          await backend.disposeAndWait?.();
        } catch (error) {
          console.warn("backend 释放失败:", error);
        }
      }
      perIteration.push(record);
      if (failed) break;
      await delay(500);
    }

    const ok = perIteration.filter((item) => item.totalMs !== undefined);
    const numbers = (values: (number | null | undefined)[]) =>
      stats(values.filter((value): value is number => typeof value === "number"));
    const aggregate: Record<string, unknown> = {
      totalMs: numbers(ok.map((item) => item.totalMs)),
      systemRpcMs: numbers(ok.map((item) => item.systemRpcMs)),
      disposeMs: numbers(ok.map((item) => item.disposeMs)),
      detectMs: numbers(ok.map((item) => item.phases?.detectMs)),
      runtimeNetworkMs: numbers(ok.map((item) => item.phases?.runtimeNetworkMs)),
      deployMs: numbers(ok.map((item) => item.phases?.deployMs)),
      launchMs: numbers(ok.map((item) => item.phases?.launchMs)),
      handshakeMs: numbers(ok.map((item) => item.phases?.handshakeMs)),
      wrapMs: numbers(ok.map((item) => item.phases?.wrapMs)),
      unattributedMs: numbers(ok.map((item) => item.phases?.unattributedMs)),
    };
    const callGroups = new Map<
      string,
      { method: string; detail: string; count: number; totalMs: number; maxMs: number }
    >();
    for (const item of perIteration) {
      for (const call of item.backendCalls) {
        const key = `${call.method} ${call.detail.slice(0, 80)}`;
        const group = callGroups.get(key) ?? {
          method: call.method,
          detail: call.detail.slice(0, 240),
          count: 0,
          totalMs: 0,
          maxMs: 0,
        };
        group.count += 1;
        group.totalMs += call.durationMs;
        group.maxMs = Math.max(group.maxMs, call.durationMs);
        callGroups.set(key, group);
      }
    }
    const execCalls = [...callGroups.values()].sort((a, b) => b.totalMs - a.totalMs);

    await emit(
      failed ? "failed" : ok.length === iterations ? "passed" : "failed",
      {
        iterationsRequested: iterations,
        iterationsCompleted: ok.length,
        gapMs: 500,
        calibration: {
          command: `wsl.exe -d ${options.distro} -u ${options.user} --exec true`,
          samplesMs: calibrationSamples,
          stats: stats(calibrationSamples),
        },
        aggregate,
        perIteration,
        execCalls,
      },
      [
        "warm 幂等部署连接：运行时已安装，deploy 段是幂等核对，不是首次安装（首装样本见 first-deploy-result.json 21.18s）",
        "n<20 只报 min/median/max/mean，不给 P95",
        "unattributedMs 含调用前隙与 execStarted→handshaking 小隙；标记缺失的段为 null 不做估算",
      ],
    );
  } finally {
    await assets.cleanup?.();
  }
}

run().catch(async (error: unknown) => {
  console.error("测量执行失败:", error instanceof Error ? error.message : error);
  try {
    const { smoke: options } = parseLatencyArgs(process.argv.slice(2));
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(
      options.output,
      `${JSON.stringify(
        {
          schema: "wsl-connect-latency/v1",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // 参数非法时写不出结构化结果；非零退出即可。
  }
  process.exitCode = 1;
});
