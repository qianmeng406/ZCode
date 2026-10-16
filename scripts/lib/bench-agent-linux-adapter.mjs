// bench-agent-linux adapter 契约层：公共入口导入、ExecutionRequest 构造、探针与场景 runner。
// 从 bench-agent-linux-probes.mjs / 主入口无行为变化提取。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { computeStats } from "./bench-agent-linux-stats.mjs";

const DEFAULT_TIMEOUT_MS = 60000;

/** 导入公共 adapter 入口（必须为 dist 公共入口路径），返回 {ok, factory, error}。 */
export async function importAdapterModule(modulePath) {
  try {
    await access(modulePath);
  } catch {
    return { ok: false, error: `adapter module not found: ${modulePath}` };
  }
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.createNodeExecutionAdapter !== "function") {
      return { ok: false, error: "createNodeExecutionAdapter export missing from adapter module" };
    }
    // createNodeExecutionAdapter 是工厂：调用方需 port = factory({outputRootDir, processEnv})。
    return { ok: true, factory: mod.createNodeExecutionAdapter, exports: Object.keys(mod) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 构造 adapter ExecutionRequest（每次 run 新建，防内部 WeakMap 输出路径缓存复用）。 */
export function buildAdapterRequest({ command, workspace, shell, platform, timeoutMs }) {
  return {
    command: {
      mode: "shell",
      command,
      shellProfile: "posix-bash",
      shellOverride: {
        id: "bench",
        label: shell,
        path: shell,
        dialect: platform === "win32" ? "git-bash" : "posix",
        source: "auto-detected",
        display: { name: "bash" },
      },
    },
    cwd: workspace,
    captureCwdAfterSuccess: true,
    timeoutMs,
    outputLimit: { persistOutput: "always" },
    trace: { sessionId: "bench", attributes: { toolCallId: createBenchTraceId() } },
  };
}

/** 生成唯一 toolCallId / trace 属性（与 probes 保持同一实现）。 */
function createBenchTraceId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `bench-${Date.now().toString(36)}-${rand}`;
}

/** timeout/cancel/background 探针，严格按已读契约实现；缺失方法则 skip 不臆测。 */
export async function runAdapterProbes(port, { workspace, shell, platform }) {
  const probes = [];
  // timeout 探针：timeoutMs 属于 ExecutionRequest。
  {
    const request = buildAdapterRequest({
      command: "sleep 5",
      workspace,
      shell,
      platform,
      timeoutMs: 200,
    });
    const startedAt = performance.now();
    const run = await port.run(request);
    const elapsedMs = performance.now() - startedAt;
    const correct = run?.timedOut === true || run?.status === "timed_out";
    probes.push({
      name: "timeout",
      correct,
      observed: {
        status: run?.status ?? null,
        timedOut: run?.timedOut ?? null,
        elapsedMs: Math.round(elapsedMs),
      },
    });
  }
  // cancel 探针：AbortSignal 属于 run options。
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    const request = buildAdapterRequest({
      command: "sleep 5",
      workspace,
      shell,
      platform,
      timeoutMs: 60000,
    });
    const run = await port.run(request, { signal: controller.signal });
    clearTimeout(timer);
    const correct = run?.cancelled === true || run?.status === "cancelled";
    probes.push({
      name: "cancel",
      correct,
      observed: { status: run?.status ?? null, cancelled: run?.cancelled ?? null },
    });
  }
  // background 探针：仅当契约方法齐全才执行。
  const missing = ["start", "getBackgroundTask", "cancelBackgroundTask"].filter(
    (m) => typeof port[m] !== "function",
  );
  if (missing.length > 0) {
    probes.push({ name: "background", correct: null, skipped: true, missing });
  } else {
    const start = await port.start(
      buildAdapterRequest({ command: "sleep 5", workspace, shell, platform, timeoutMs: 60000 }),
    );
    const snapshotBefore = await port.getBackgroundTask(start.taskId);
    const cancelled = await port.cancelBackgroundTask(start.taskId);
    probes.push({
      name: "background",
      correct: start?.status === "running" && Boolean(snapshotBefore),
      observed: {
        startStatus: start?.status ?? null,
        snapshotStatus: snapshotBefore?.status ?? null,
        cancelStatus: cancelled?.status ?? null,
      },
    });
  }
  return probes;
}

/**
 * adapter 场景：工厂调用产出 port；performance.now 包围 await port.run；
 * cold-init 只跑 1 次（firstSample 即唯一样本），hot 为后续批量。
 * 整个阶段 try/finally 关闭 port；probe incorrect / import 失败进 failures。
 */
export async function benchAdapter({ args, adapterModule, tempDir, failures }) {
  const adapterResult = {
    module: adapterModule,
    imported: false,
    importError: null,
    scenarios: {},
    probes: [],
  };
  const imported = await importAdapterModule(adapterModule);
  if (!imported.ok) {
    adapterResult.importError = imported.error;
    failures.push({
      scenario: "adapter-import",
      variant: "adapter",
      kind: "spawn-error",
      detail: imported.error,
    });
    return adapterResult;
  }
  adapterResult.imported = true;
  let port;
  try {
    port = imported.factory({ outputRootDir: tempDir, processEnv: process.env });
  } catch (error) {
    failures.push({
      scenario: "adapter-factory",
      variant: "adapter",
      kind: "spawn-error",
      detail: error.message,
    });
    adapterResult.importError = `factory failed: ${error.message}`;
    return adapterResult;
  }
  try {
    const platform = process.platform;

    async function timedAdapterRun(command) {
      // 每个 run 全新 request（防内部输出路径缓存复用），timeoutMs 属于 request。
      const request = buildAdapterRequest({
        command,
        workspace: args.workspace,
        shell: args.shell,
        platform,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const startedAt = performance.now();
      const run = await port.run(request);
      return { run, durationMs: performance.now() - startedAt };
    }

    async function benchAdapterCommand(id, command, samples) {
      const samplesMs = [];
      let firstSample = null;
      for (let i = 0; i < samples; i += 1) {
        const { run, durationMs } = await timedAdapterRun(command);
        const markerOk = command === ":" || String(run?.stdout?.text ?? "").trim() === "marker";
        // cwd 校验：必须为字符串且 resolve 后相等（win 大小写不敏感比较）。
        const cwdOk =
          typeof run?.resolvedCwd === "string" &&
          run.resolvedCwd !== "" &&
          path.resolve(run.resolvedCwd).toLowerCase() ===
            path.resolve(args.workspace).toLowerCase();
        const truncated = run?.stdout?.truncated === true || run?.stderr?.truncated === true;
        if (
          run &&
          run.status === "completed" &&
          (run.exitCode === 0 || run.exitCode === undefined) &&
          markerOk &&
          cwdOk &&
          !truncated
        ) {
          samplesMs.push(durationMs);
          if (i === 0) {
            firstSample = durationMs;
          }
        } else {
          failures.push({
            scenario: id,
            variant: command,
            kind: truncated ? "output-limit" : "correctness",
            detail:
              `status=${run?.status ?? "null"} exit=${run?.exitCode ?? "null"} cwdOk=${cwdOk} markerOk=${markerOk} truncated=${truncated} err=${run?.error?.message ?? ""}`.slice(
                0,
                300,
              ),
          });
        }
      }
      return { id, stats: computeStats(samplesMs, { firstSample }) };
    }

    // cold init：仅 1 次 run，样本即 cold；其后为 hot 批量。
    adapterResult.scenarios["adapter-cold-init"] = (
      await benchAdapterCommand("adapter-cold-init", ":", 1)
    ).stats;
    adapterResult.scenarios["adapter-hot-run-noop"] = (
      await benchAdapterCommand("adapter-hot-run-noop", ":", args.samplesShort)
    ).stats;
    adapterResult.scenarios["adapter-hot-run-printf"] = (
      await benchAdapterCommand("adapter-hot-run-printf", "printf marker", args.samplesShort)
    ).stats;

    adapterResult.probes = await runAdapterProbes(port, {
      workspace: args.workspace,
      shell: args.shell,
      platform,
    });
    for (const probe of adapterResult.probes) {
      if (probe.correct === false) {
        failures.push({
          scenario: `adapter-probe:${probe.name}`,
          variant: "probe",
          kind: "correctness",
          detail: JSON.stringify(probe.observed).slice(0, 300),
        });
      }
    }
  } finally {
    // 整个 adapter 阶段包在 try/finally：任何异常也必须关闭 port 清理资源。
    try {
      if (typeof port.close === "function") {
        await port.close();
      }
    } catch (error) {
      failures.push({
        scenario: "adapter-close",
        variant: "adapter",
        kind: "spawn-error",
        detail: error.message,
      });
    } finally {
      adapterResult.closed = true;
    }
  }
  return adapterResult;
}
