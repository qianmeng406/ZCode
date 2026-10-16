// bench-agent-linux 单测：参数校验、统计、task 命令解析、真实 e2e。
// 运行：node --test scripts/test/bench-agent-linux.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseTaskCommands,
  validateArgs,
  ArgError,
  DEFAULTS,
} from "../lib/bench-agent-linux-args.mjs";
import { computeStats, P95_MIN_N } from "../lib/bench-agent-linux-stats.mjs";
import {
  pickRgSourceFiles,
  shQuote,
  outputFingerprint,
  createBenchTraceId,
} from "../lib/bench-agent-linux-probes.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../bench-agent-linux.mjs", import.meta.url));

test("parseArgs defaults and validation", () => {
  const args = parseArgs([
    "--workspace",
    "C:/ws",
    "--output",
    "C:/out",
    "--shell",
    "C:/Git/usr/bin/bash.exe",
  ]);
  assert.equal(args.samplesShort, DEFAULTS.samplesShort);
  assert.equal(args.samplesWorkspace, DEFAULTS.samplesWorkspace);
  assert.equal(args.adapterModule, null);
});

test("parseArgs rejects relative paths, bad samples, unknown args", () => {
  assert.throws(
    () => parseArgs(["--workspace", "ws", "--output", "C:/o", "--shell", "/bin/bash"]),
    ArgError,
  );
  assert.throws(
    () => parseArgs(["--workspace", "C:/ws", "--output", "C:/o", "--shell", "bash"]),
    ArgError,
  );
  assert.throws(
    () =>
      parseArgs([
        "--workspace",
        "C:/ws",
        "--output",
        "C:/o",
        "--shell",
        "C:/b",
        "--samples-short",
        "0",
      ]),
    ArgError,
  );
  assert.throws(
    () =>
      parseArgs([
        "--workspace",
        "C:/ws",
        "--output",
        "C:/o",
        "--shell",
        "C:/b",
        "--samples-short",
        "abc",
      ]),
    ArgError,
  );
  assert.throws(
    () => parseArgs(["--workspace", "C:/ws", "--output", "C:/o", "--shell", "C:/b", "--wat", "x"]),
    ArgError,
  );
  assert.throws(() => parseArgs(["--workspace", "C:/ws", "--output", "C:/o", "--shell"]), ArgError);
});

test("validateArgs rejects missing workspace and shell", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "bench-test-"));
  try {
    const shell = path.join(tmp, "bash.exe");
    await writeFile(shell, "");
    await assert.rejects(
      validateArgs(
        parseArgs(["--workspace", path.join(tmp, "nope"), "--output", tmp, "--shell", shell]),
      ),
      ArgError,
    );
    await assert.rejects(
      validateArgs(
        parseArgs(["--workspace", tmp, "--output", tmp, "--shell", path.join(tmp, "no-shell")]),
      ),
      ArgError,
    );
    // 有效组合通过
    await validateArgs(parseArgs(["--workspace", tmp, "--output", tmp, "--shell", shell]));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("parseTaskCommands validates shapes and keeps env only in memory", () => {
  const envSentinel = "SECRET-BENCH-SENTINEL";
  const commands = parseTaskCommands(
    JSON.stringify([
      { name: "typecheck", file: "/usr/bin/tsc", args: ["--noEmit"] },
      { name: "with-env", file: "C:/x/node.exe", cwd: "C:/x", env: { FOO: envSentinel } },
    ]),
  );
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].args, ["--noEmit"]);
  assert.equal(commands[1].env.FOO, envSentinel);

  assert.throws(() => parseTaskCommands("[] []"), ArgError);
  assert.throws(() => parseTaskCommands("{}"), ArgError);
  assert.throws(() => parseTaskCommands(JSON.stringify([{ file: "/bin/x" }])), ArgError);
  assert.throws(
    () => parseTaskCommands(JSON.stringify([{ name: "n", file: "relative/path" }])),
    ArgError,
  );
  assert.throws(
    () => parseTaskCommands(JSON.stringify([{ name: "n", file: "/x", args: [1] }])),
    ArgError,
  );
  assert.throws(
    () => parseTaskCommands(JSON.stringify([{ name: "n", file: "/x", env: { A: 1 } }])),
    ArgError,
  );
});

test("computeStats: median/min/max/mean, p95 gating, firstSample, even median", () => {
  const stats = computeStats([5, 1, 3], { firstSample: 5 });
  assert.equal(stats.n, 3);
  assert.equal(stats.median, 3);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 5);
  assert.equal(stats.mean, 3);
  assert.equal(stats.firstSample, 5);
  assert.ok(!("p95" in stats), "p95 must be absent below n=20");

  const even = computeStats([4, 2]);
  assert.equal(even.median, 3);

  const samples = Array.from({ length: P95_MIN_N }, (_, i) => i + 1);
  const withP95 = computeStats(samples);
  assert.ok(withP95.p95 > 18 && withP95.p95 <= 20);

  assert.equal(computeStats([]).n, 0);
  assert.equal(computeStats([]).median, null);
});

test("shQuote and outputFingerprint", () => {
  assert.equal(shQuote("simple"), "'simple'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote("a b"), "'a b'");
  const fp = outputFingerprint("hello");
  assert.equal(fp.stdoutBytes, 5);
  assert.match(fp.stdoutHash, /^[0-9a-f]{64}$/);
  const id1 = createBenchTraceId();
  const id2 = createBenchTraceId();
  assert.notEqual(id1, id2);
});

test("pickRgSourceFiles filters to source extensions", () => {
  const files = pickRgSourceFiles([
    "README.md",
    "src/a.ts",
    "docs/x.md",
    "src/deep/b.mjs",
    "img.png",
    "c.tsx",
    "d.ts",
    "e.ts",
    "f.ts",
  ]);
  assert.deepEqual(files, ["src/a.ts", "src/deep/b.mjs", "c.tsx", "d.ts", "e.ts", "f.ts"]);
});

/** 通用 bash 探测：优先环境变量，其次 PATH 与常见安装位置；找不到返回 null。 */
async function findBash() {
  const candidates = [
    process.env.BENCH_TEST_BASH,
    process.platform === "win32" ? "bash.exe" : "bash",
    process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "/bin/bash",
    process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/usr/bin/bash",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["-c", ":"]);
      // CLI 要求 --shell 为绝对路径；PATH 探测命中的裸名需经 where/which 解析。
      if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
        return candidate;
      }
      const probeCmd = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(probeCmd, [candidate]);
      const resolved = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)[0];
      return resolved ?? null;
    } catch {
      // try next
    }
  }
  return null;
}

/** 通用 git 探测。 */
async function findGit() {
  const candidates = [
    "git",
    process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "/usr/bin/git",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

test("e2e: real run on a tiny clean git workspace produces valid JSON, exit 0, no env leak", async (t) => {
  const shell = await findBash();
  if (shell === null) {
    t.skip("no bash found on this machine; skipping real integration test");
    return;
  }
  const git = await findGit();
  if (git === null) {
    t.skip("no git found on this machine; skipping real integration test");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "bench-e2e-"));
  const workspace = path.join(root, "ws");
  const output = path.join(root, "out");
  await mkdir(workspace, { recursive: true });
  const envSentinel = "BENCH-SECRET-DO-NOT-PRINT";
  try {
    // 干净 git 仓库：预置 rg-large-dirs 固定三目录的 marker 源文件，全部场景应可命中。
    const runGit = async (...args) => execFileAsync(git, args, { cwd: workspace });
    await runGit("init");
    await runGit("config", "user.email", "bench@example.com");
    await runGit("config", "user.name", "bench");
    for (const dir of [
      "packages/rpc/src",
      "apps/zcode-cli/packages/adapters/src",
      "packages/shared/src",
    ]) {
      await mkdir(path.join(workspace, dir), { recursive: true });
      await writeFile(
        path.join(workspace, dir, "marker.ts"),
        "export const marker = 1;\nimport path from 'node:path';\n",
      );
    }
    await runGit("add", ".");
    await runGit("commit", "-m", "init");

    // task 命令：用 node 跑一个空脚本
    const taskScript = path.join(root, "empty.mjs");
    await writeFile(taskScript, "// no-op\n");
    const taskFile = path.join(root, "tasks.json");
    await writeFile(
      taskFile,
      JSON.stringify([
        {
          name: "noop-task",
          file: process.execPath,
          args: [taskScript],
          env: { BENCH_SENTINEL: envSentinel },
        },
      ]),
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        CLI,
        "--workspace",
        workspace,
        "--output",
        output,
        "--shell",
        shell,
        "--samples-short",
        "2",
        "--samples-workspace",
        "1",
        "--task-command-file",
        taskFile,
      ],
      { env: { ...process.env, BENCH_SENTINEL: envSentinel }, timeout: 180000 },
    );
    assert.match(stdout, /result written to/);
    assert.equal(stderr, "");

    const result = JSON.parse(
      await readFile(path.join(output, "bench-agent-linux-result.json"), "utf8"),
    );
    assert.equal(result.schema, "bench-agent-linux/v1");
    assert.equal(result.workspace, workspace);
    assert.ok(result.startedAt && result.finishedAt);
    // 预置目录后所有场景应通过；rg 不可用的机器 rg 场景记 skipped（不进 failures）。
    assert.deepEqual(result.failures, []);
    const rgEntries = result.samples.workspace["rg-tracked-sources"]["no-profile"];
    const rgAvailable = !rgEntries.skipped;

    // short 场景 no-profile/login 都有样本
    for (const id of ["noop", "printf-marker", "printf-pipe-grep"]) {
      for (const variant of ["no-profile", "login"]) {
        const entry = result.samples.short[id][variant];
        assert.equal(entry.n, 2, `${id}/${variant} samples`);
        assert.equal(typeof entry.firstSample, "number");
        assert.ok(!("p95" in entry));
      }
    }
    // workspace 场景
    assert.equal(result.samples.workspace["git-status-porcelain"]["no-profile"].n, 1);
    assert.equal(result.samples.workspace["git-ls-files"]["no-profile"].n, 1);
    if (rgAvailable) {
      assert.equal(rgEntries.n, 1, "rg scenario should pass on seeded workspace");
      assert.ok(rgEntries.files.length > 0);
      assert.ok(rgEntries.stdoutHash && rgEntries.stdoutBytes > 0);
      const large = result.samples.workspace["rg-large-dirs"]["no-profile"];
      assert.equal(large.n, 1, "rg-large-dirs should pass with seeded dirs");
      assert.ok(large.stdoutHash && large.stdoutBytes > 0);
    } else {
      assert.equal(typeof rgEntries.reason, "string");
    }
    // env 泄漏防护
    const raw = JSON.stringify(result);
    assert.ok(!raw.includes(envSentinel), "planted env sentinel must not leak into result JSON");
    // task 命令
    assert.ok(result.taskCommands["noop-task"]);
    assert.equal(result.taskCommands["noop-task"].n, 3);
    assert.ok(!JSON.stringify(result.taskCommands).includes(envSentinel));
    // adapter 未指定时 skipped
    assert.equal(result.adapter.skipped, true);
    assert.equal(result.tempDir, null);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
