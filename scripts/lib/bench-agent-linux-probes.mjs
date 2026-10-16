// bench-agent-linux 场景定义、底层异步 spawn 与 adapter 探针。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

export const METHOD_SHELL = "shell-native-spawn";
export const METHOD_ADAPTER = "adapter-node-execution";
export const METHOD_TASK = "task-file-spawn";
export const METHOD_CAVEAT = "shell-native timings are not full agent measurements";

export const SHORT_SCENARIOS = [
  { id: "noop", script: ":", check: { exitCode: 0 } },
  { id: "printf-marker", script: "printf marker", check: { exitCode: 0, stdout: "marker" } },
  {
    id: "printf-pipe-grep",
    script: "printf 'a\\nb\\nc' | grep b",
    check: { exitCode: 0, stdout: "b" },
  },
];

export const WORKSPACE_SCENARIOS = [
  {
    id: "git-status-porcelain",
    script: "git status --porcelain --untracked-files=normal",
    check: { exitCode: 0, emptyStdout: true },
  },
  { id: "git-ls-files", script: "git ls-files", check: { exitCode: 0, nonEmptyStdout: true } },
];

export const RG_PATTERN = "import|export";
export const RG_LARGE_DIRS_PATTERN = "export";
export const RG_LARGE_DIRS = [
  "packages/rpc/src",
  "apps/zcode-cli/packages/adapters/src",
  "packages/shared/src",
];

/** rg 固定输入的 source 扩展白名单：git ls-files 输出里挑 source 文件。 */
const RG_SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
]);

export function pickRgSourceFiles(lines, limit = 8) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => RG_SOURCE_EXTENSIONS.has(path.extname(l)))
    .slice(0, limit);
}

/** POSIX 单引号 shell 引用；单引号本身按 ' -> '\'' 转义。 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 输出 hash/bytes，供双方比对。 */
export function outputFingerprint(stdout) {
  return {
    stdoutHash: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
  };
}

/** 单次异步 spawn：performance.now 计时（Date.now 1ms 粒度会把 Linux 快路径记成 0）。 */
export function spawnOnce({
  file,
  args,
  cwd,
  env = undefined,
  timeoutMs = 60000,
  input = null,
  maxOutputBytes = 4 * 1024 * 1024,
}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let child;
    try {
      // POSIX 用 detached + 进程组 kill(-pid) 杀整棵树；Windows 用 taskkill /T /F。
      child = spawn(file, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        spawnError: error.message,
        timedOut: false,
        cancelled: false,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      });
      return;
    }
    let timedOut = false;
    let truncated = false;
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    /** 杀整个进程树：POSIX 进程组信号；Windows taskkill /T /F。 */
    const killTree = () => {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      } catch {
        // ignore
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const collect = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes) {
        truncated = true;
        killTree();
        return;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      collect(chunk);
      if (!truncated) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      collect(chunk);
      if (!truncated) stderr += chunk;
    });
    // 硬兜底：超时上限后强制结算，kill 并销毁流，避免句柄挂起。
    const hardTimer = setTimeout(
      () => {
        killTree();
        try {
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
        } catch {
          // ignore
        }
        resolve({
          timedOut,
          truncated,
          spawnError: null,
          cancelled: false,
          exitCode: null,
          signal: "hard-limit",
          stdout,
          stderr,
          durationMs: performance.now() - startedAt,
        });
      },
      timeoutMs * 2 + 5000,
    );
    hardTimer.unref?.();
    const finish = (result) => {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      resolve({ timedOut, truncated, ...result, durationMs: performance.now() - startedAt });
    };
    child.on("error", (error) => {
      finish({
        spawnError: error.message,
        cancelled: false,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        spawnError: null,
        cancelled: false,
        exitCode: code,
        signal: signal ?? null,
        stdout,
        stderr,
      });
    });
    if (input !== null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** 执行一个 shell 场景脚本并做正确性校验。成功返回 {ok:true, ...}，失败 {ok:false, failure}。 */
export async function runShellScenario({
  shell,
  login,
  script,
  check,
  cwd,
  timeoutMs,
  extraArgs = [],
}) {
  const args = login ? ["-l", "-c", script] : [...extraArgs, "-c", script];
  const run = await spawnOnce({ file: shell, args, cwd, timeoutMs });
  if (run.spawnError !== null) {
    return { ok: false, failure: { kind: "spawn-error", detail: run.spawnError }, run };
  }
  if (run.timedOut) {
    return { ok: false, failure: { kind: "timeout", detail: `timeout ${timeoutMs}ms` }, run };
  }
  if (run.truncated) {
    return { ok: false, failure: { kind: "output-limit", detail: "output truncated" }, run };
  }
  const out = run.stdout.trim();
  if (check.exitCode !== undefined && run.exitCode !== check.exitCode) {
    return {
      ok: false,
      failure: {
        kind: "nonzero-exit",
        detail: `exit ${run.exitCode}: ${run.stderr.slice(0, 200)}`,
      },
      run,
    };
  }
  if (check.stdout !== undefined && out !== check.stdout) {
    return {
      ok: false,
      failure: {
        kind: "correctness",
        detail: `stdout mismatch: ${JSON.stringify(out.slice(0, 80))}`,
      },
      run,
    };
  }
  if (check.emptyStdout && out !== "") {
    return {
      ok: false,
      failure: {
        kind: "correctness",
        detail: `expected empty stdout, got: ${JSON.stringify(out.slice(0, 120))}`,
      },
      run,
    };
  }
  if (check.nonEmptyStdout && out === "") {
    return { ok: false, failure: { kind: "correctness", detail: "empty stdout" }, run };
  }
  return { ok: true, run };
}

/** 生成唯一 toolCallId / trace 属性。 */
export function createBenchTraceId() {
  return `bench-${Date.now().toString(36)}-${createHash("sha1")
    .update(String(process.pid) + String(Math.random()) + String(performance.now()))
    .digest("hex")
    .slice(0, 12)}`;
}

/** 定位 rg（优先 --rg 显式路径；否则探测 PATH 里的 rg）。 */
export async function resolveRg(explicitRg) {
  if (explicitRg !== null) {
    await assertExecutableFile(explicitRg, "rg");
    return explicitRg;
  }
  const candidates = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  for (const candidate of candidates) {
    const hit = await new Promise((resolve) => {
      const child = spawn(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? candidate : null));
    });
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

/** --node/--git/--rg 可执行存在性检查（不做扩展名校验，Windows 无扩展 PE 可用）。 */
export async function assertExecutableFile(p, label) {
  try {
    await access(p);
  } catch {
    throw new Error(`--${label} path not accessible: ${p}`);
  }
}

// adapter 请求构造/导入/探针移至 bench-agent-linux-adapter.mjs，此处 re-export 保持兼容。
export {
  importAdapterModule,
  buildAdapterRequest,
  runAdapterProbes,
} from "./bench-agent-linux-adapter.mjs";
