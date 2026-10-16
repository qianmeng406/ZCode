#!/usr/bin/env node
// bench-agent-linux 主入口：short/workspace/adapter/task 场景编排与 JSON 输出。
// 规约见 docs/research/wsl-agent-benchmark.spec.md。Node >= 24，无运行时依赖。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseArgs,
  parseTaskCommands,
  validateArgs,
  ArgError,
} from "./lib/bench-agent-linux-args.mjs";
import { computeStats } from "./lib/bench-agent-linux-stats.mjs";
import { benchAdapter } from "./lib/bench-agent-linux-adapter.mjs";
import {
  METHOD_SHELL,
  METHOD_TASK,
  METHOD_CAVEAT,
  SHORT_SCENARIOS,
  WORKSPACE_SCENARIOS,
  RG_PATTERN,
  RG_LARGE_DIRS,
  RG_LARGE_DIRS_PATTERN,
  runShellScenario,
  spawnOnce,
  resolveRg,
  pickRgSourceFiles,
  shQuote,
  outputFingerprint,
} from "./lib/bench-agent-linux-probes.mjs";

const DEFAULT_TIMEOUT_MS = 60000;
const ADAPTER_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`bench-agent-linux: ${message}\n`);
}

/** 组装 base metadata（env 白名单式，绝不序列化 process.env）。 */
function buildMetadata({ args, startedAt }) {
  return {
    schema: "bench-agent-linux/v1",
    method: METHOD_SHELL,
    methodCaveat: METHOD_CAVEAT,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    platform: { platform: process.platform, nodeVersion: process.version, arch: process.arch },
    binaries: { shell: args.shell, node: args.node, git: args.git, rg: null },
    workspace: args.workspace,
    output: args.output,
    samplesConfig: { short: args.samplesShort, workspace: args.samplesWorkspace },
  };
}

/** shell 场景取样：warmup 1 次 + samples 次，firstSample 单列，记录 script 与输出指纹。 */
async function benchScenario({
  id,
  script,
  check,
  shell,
  login,
  cwd,
  samples,
  timeoutMs,
  failures,
  extraArgs = [],
}) {
  await runShellScenario({ shell, login, script, check, cwd, timeoutMs, extraArgs });
  const samplesMs = [];
  let firstSample = null;
  for (let i = 0; i < samples; i += 1) {
    const result = await runShellScenario({
      shell,
      login,
      script,
      check,
      cwd,
      timeoutMs,
      extraArgs,
    });
    if (!result.ok) {
      failures.push({ scenario: id, variant: login ? "login" : "no-profile", ...result.failure });
      continue;
    }
    samplesMs.push(result.run.durationMs);
    if (i === 0) {
      firstSample = result.run.durationMs;
    }
  }
  const stats = computeStats(samplesMs, { firstSample });
  // 可审计性：记录精确 script 与输出指纹（首测样本的）。
  const probe = await runShellScenario({ shell, login, script, check, cwd, timeoutMs, extraArgs });
  if (probe.ok) {
    Object.assign(
      stats,
      { script: probe.run ? script : script },
      outputFingerprint(probe.run.stdout),
    );
  } else {
    failures.push({ scenario: id, variant: login ? "login" : "no-profile", ...probe.failure });
  }
  return { id, stats };
}

async function benchShortScenarios({ args, failures }) {
  const result = {};
  for (const scenario of SHORT_SCENARIOS) {
    result[scenario.id] = {};
    for (const login of [false, true]) {
      // no-profile 显式禁用 rc/profile；login 保持 -l 默认语义。
      const extraArgs = login ? [] : ["--noprofile", "--norc"];
      const { stats } = await benchScenario({
        id: scenario.id,
        script: scenario.script,
        check: scenario.check,
        shell: args.shell,
        login,
        cwd: args.workspace,
        samples: args.samplesShort,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        failures,
        extraArgs,
      });
      result[scenario.id][login ? "login" : "no-profile"] = stats;
    }
  }
  return result;
}

/** git ls-files（可用 --git 显式路径），返回 setup 信息。 */
async function gitListFiles({ shell, workspace, git, failures }) {
  const script = `${shQuote(git)} ls-files`;
  const result = await runShellScenario({
    shell,
    login: false,
    script,
    check: { exitCode: 0, nonEmptyStdout: true },
    cwd: workspace,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    extraArgs: ["--noprofile", "--norc"],
  });
  if (!result.ok) {
    failures.push({ scenario: "setup-git-ls-files", variant: "no-profile", ...result.failure });
    return null;
  }
  return { script, stdout: result.run.stdout };
}

async function benchWorkspaceScenarios({ args, git, rg, failures }) {
  const result = {};
  const lsResult = await gitListFiles({
    shell: args.shell,
    workspace: args.workspace,
    git,
    failures,
  });
  const trackedLines = lsResult ? lsResult.stdout.split("\n") : [];

  for (const scenario of WORKSPACE_SCENARIOS) {
    // --git 显式路径对 git-status / git-ls-files 一致使用，保证两侧同一二进制。
    const script =
      args.git !== null ? scenario.script.replace(/^git /, `${shQuote(git)} `) : scenario.script;
    const { stats } = await benchScenario({
      id: scenario.id,
      script,
      check: scenario.check,
      shell: args.shell,
      login: false,
      cwd: args.workspace,
      samples: args.samplesWorkspace,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      failures,
      extraArgs: ["--noprofile", "--norc"],
    });
    result[scenario.id] = { "no-profile": stats };
  }

  if (rg === null) {
    result["rg-tracked-sources"] = {
      "no-profile": { skipped: true, reason: "rg not available (pass --rg or install rg)", n: 0 },
    };
  } else {
    const files = pickRgSourceFiles(trackedLines);
    if (files.length === 0) {
      result["rg-tracked-sources"] = {
        "no-profile": { skipped: true, reason: "no tracked source files found", n: 0 },
      };
    } else {
      const script = `${shQuote(rg)} ${shQuote(RG_PATTERN)} ${files.map(shQuote).join(" ")}`;
      const { stats } = await benchScenario({
        id: "rg-tracked-sources",
        script,
        check: { exitCode: 0, nonEmptyStdout: true },
        shell: args.shell,
        login: false,
        cwd: args.workspace,
        samples: args.samplesWorkspace,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        failures,
        extraArgs: ["--noprofile", "--norc"],
      });
      stats.files = files;
      result["rg-tracked-sources"] = { "no-profile": stats };
    }
  }

  // 大目录搜索样本：固定目录 + 固定 pattern，代表真实工作区 I/O 规模。
  if (rg === null) {
    result["rg-large-dirs"] = { "no-profile": { skipped: true, reason: "rg not available", n: 0 } };
  } else {
    const script = `${shQuote(rg)} -l ${shQuote(RG_LARGE_DIRS_PATTERN)} ${RG_LARGE_DIRS.map(shQuote).join(" ")}`;
    const { stats } = await benchScenario({
      id: "rg-large-dirs",
      script,
      check: { exitCode: 0, nonEmptyStdout: true },
      shell: args.shell,
      login: false,
      cwd: args.workspace,
      samples: args.samplesWorkspace,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      failures,
      extraArgs: ["--noprofile", "--norc"],
    });
    result["rg-large-dirs"] = { "no-profile": stats };
  }
  return result;
}

/** task 命令文件场景：每条目 warmup 1 + 3 样本，直接 argv spawn，env 不序列化。 */
async function benchTaskCommands({ taskCommands, workspace, failures }) {
  const result = {};
  for (const task of taskCommands) {
    const samplesMs = [];
    let firstSample = null;
    for (let i = -1; i < 3; i += 1) {
      const env = task.env === null ? undefined : { ...process.env, ...task.env };
      const run = await spawnOnce({
        file: task.file,
        args: task.args,
        cwd: task.cwd ?? workspace,
        env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: ADAPTER_OUTPUT_LIMIT_BYTES,
      });
      if (run.spawnError !== null || run.timedOut || run.exitCode !== 0 || run.truncated) {
        failures.push({
          scenario: `task:${task.name}`,
          variant: "task",
          kind:
            run.spawnError !== null
              ? "spawn-error"
              : run.truncated
                ? "output-limit"
                : run.timedOut
                  ? "timeout"
                  : "nonzero-exit",
          detail: (
            run.spawnError ??
            (run.truncated
              ? `output exceeded ${ADAPTER_OUTPUT_LIMIT_BYTES} bytes`
              : `exit ${run.exitCode}: ${run.stderr.slice(0, 200)}`)
          ).slice(0, 300),
        });
        continue;
      }
      if (i >= 0) {
        samplesMs.push(run.durationMs);
        if (i === 0) {
          firstSample = run.durationMs;
        }
      }
    }
    result[task.name] = {
      ...computeStats(samplesMs, { firstSample }),
      file: task.file,
      args: task.args,
    };
  }
  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    await validateArgs(args);
  } catch (error) {
    if (error instanceof ArgError) {
      fail(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const startedAt = Date.now();
  const failures = [];
  const tempDir = path.join(args.output, `.bench-agent-linux-tmp-${process.pid}-${startedAt}`);
  await mkdir(args.output, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const metadata = buildMetadata({ args, startedAt });
  const git = args.git ?? "git";

  let rg = null;
  try {
    rg = await resolveRg(args.rg);
  } catch (error) {
    failures.push({
      scenario: "resolve-rg",
      variant: "setup",
      kind: "spawn-error",
      detail: error.message,
    });
  }
  metadata.binaries.rg = rg;

  const result = {
    ...metadata,
    samples: {},
    adapter: null,
    taskCommands: null,
    failures,
    tempDir,
  };

  result.samples.short = await benchShortScenarios({ args, failures });
  result.samples.workspace = await benchWorkspaceScenarios({ args, git, rg, failures });

  if (args.adapterModule !== null) {
    result.adapter = await benchAdapter({
      args,
      adapterModule: args.adapterModule,
      tempDir,
      failures,
    });
  } else {
    result.adapter = {
      module: null,
      imported: false,
      importError: null,
      scenarios: {},
      probes: [],
      skipped: true,
      skipReason: "--adapter-module not specified",
    };
  }

  if (args.taskCommandFile !== null) {
    try {
      const taskCommands = parseTaskCommands(await readFile(args.taskCommandFile, "utf8"));
      result.taskCommands = await benchTaskCommands({
        taskCommands,
        workspace: args.workspace,
        failures,
      });
      result.method = `${METHOD_SHELL}+${METHOD_TASK}`;
    } catch (error) {
      if (error instanceof ArgError) {
        failures.push({
          scenario: "task-command-file",
          variant: "parse",
          kind: "correctness",
          detail: error.message,
        });
      } else {
        throw error;
      }
    }
  }

  result.finishedAt = new Date().toISOString();
  result.failures = failures;
  const outPath = path.join(args.output, "bench-agent-linux-result.json");
  // 临时目录：adapter 产物保留时记录路径；空目录则删除（只删本轮创建目录）。
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(tempDir);
    if (entries.length === 0) {
      await rm(tempDir, { recursive: true, force: true });
      result.tempDir = null;
    }
  } catch {
    // ignore
  }
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`bench-agent-linux: result written to ${outPath}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  fail(`unexpected error: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
