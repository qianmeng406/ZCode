import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ensureResidentDaemonRunning, stopResidentDaemon } from "../src/remote/resident-daemon.js";
import {
  isPidAlive,
  readResidentDaemonStatus,
  residentDaemonStatusPath,
  writeResidentDaemonStatus,
} from "../src/remote/resident-protocol.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-resident-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function spawnStub() {
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawnImpl = ((
    _script: unknown,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawnImpl };
}

test("isPidAlive：当前进程存活；不可能存在的 pid 判死", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999_999_999), false);
});

test("daemon.json 读写往返；坏文件按缺席处理", async () => {
  await withTempRoot(async (root) => {
    const statusPath = residentDaemonStatusPath(root);
    assert.equal(await readResidentDaemonStatus(statusPath), undefined);

    await writeResidentDaemonStatus(statusPath, {
      pid: process.pid,
      port: 45678,
      version: "3.14.3",
      startedAt: 1,
    });
    const status = await readResidentDaemonStatus(statusPath);
    assert.equal(status?.pid, process.pid);
    assert.equal(status?.port, 45678);
    assert.equal(status?.version, "3.14.3");

    await writeFile(statusPath, "{not-json", "utf8");
    assert.equal(await readResidentDaemonStatus(statusPath), undefined);
  });
});

test("ensure：已存活 daemon 直接复用，不再 spawn", async () => {
  await withTempRoot(async (root) => {
    const { calls, spawnImpl } = spawnStub();
    await writeResidentDaemonStatus(residentDaemonStatusPath(root), {
      pid: process.pid,
      port: 45678,
      version: "3.14.3",
      startedAt: 1,
    });
    const status = await ensureResidentDaemonRunning({
      runtimeRoot: root,
      scriptPath: "/remote/zcode-server.cjs",
      env: process.env,
      log: () => undefined,
      spawnImpl,
      probe: async () => true,
    });
    assert.equal(status.port, 45678);
    assert.equal(calls.length, 0);
  });
});

test("ensure：陈旧状态（探活失败）→ spawn 自身 serve 并等待新状态就绪", async () => {
  await withTempRoot(async (root) => {
    const { calls, spawnImpl } = spawnStub();
    const statusPath = residentDaemonStatusPath(root);
    await writeResidentDaemonStatus(statusPath, {
      pid: 999_999_999,
      port: 1,
      version: "old",
      startedAt: 0,
    });

    // 模拟 daemon 启动完成后写状态文件 + 探活成功。
    let probeCount = 0;
    const result = ensureResidentDaemonRunning({
      runtimeRoot: root,
      scriptPath: "/remote/zcode-server.cjs",
      env: { ZCODE_ENV: "production" },
      log: () => undefined,
      spawnImpl,
      probe: async () => {
        probeCount += 1;
        return probeCount > 2;
      },
      waitTimeoutMs: 2_000,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await writeResidentDaemonStatus(statusPath, {
      pid: process.pid,
      port: 45679,
      version: "3.14.3",
      startedAt: 2,
    });
    const status = await result;

    assert.equal(status.port, 45679);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["/remote/zcode-server.cjs", "--resident-serve"]);
    // daemon 继承 start 命令注入的运行时 env。
    assert.equal(calls[0]?.env?.ZCODE_ENV, "production");
  });
});

test("ensure：spawn 报错立即失败，不等超时", async () => {
  await withTempRoot(async (root) => {
    const spawnImpl = (() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      setTimeout(() => child.emit("error", new Error("EACCES")), 10);
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(
      ensureResidentDaemonRunning({
        runtimeRoot: root,
        scriptPath: "/remote/zcode-server.cjs",
        env: process.env,
        log: () => undefined,
        spawnImpl,
        waitTimeoutMs: 5_000,
      }),
      /Resident daemon failed to spawn: EACCES/,
    );
  });
});

test("ensure：daemon 一直不就绪 → 超时失败", async () => {
  await withTempRoot(async (root) => {
    const { spawnImpl } = spawnStub();
    await assert.rejects(
      ensureResidentDaemonRunning({
        runtimeRoot: root,
        scriptPath: "/remote/zcode-server.cjs",
        env: process.env,
        log: () => undefined,
        spawnImpl,
        probe: async () => false,
        waitTimeoutMs: 200,
      }),
      /did not become ready within 200ms/,
    );
  });
});

test("stop：优雅终止后清理状态文件；无状态文件返回 false", async () => {
  await withTempRoot(async (root) => {
    const statusPath = residentDaemonStatusPath(root);
    const signals: string[] = [];
    await writeResidentDaemonStatus(statusPath, {
      pid: process.pid,
      port: 45678,
      version: "3.14.3",
      startedAt: 1,
    });
    const stopped = await stopResidentDaemon({
      runtimeRoot: root,
      log: () => undefined,
      signalImpl: (pid, signal) => {
        signals.push(signal);
        void pid;
      },
      // 第一次 SIGTERM 后即判死，走优雅路径。
      isAliveImpl: () => false,
    });
    assert.equal(stopped, true);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(await readResidentDaemonStatus(statusPath), undefined);

    assert.equal(await stopResidentDaemon({ runtimeRoot: root, log: () => undefined }), false);
  });
});

test("stop：SIGTERM 宽限内仍存活 → 追加 SIGKILL", async () => {
  await withTempRoot(async (root) => {
    const statusPath = residentDaemonStatusPath(root);
    await writeResidentDaemonStatus(statusPath, {
      pid: 999_999_999,
      port: 1,
      version: "3.14.3",
      startedAt: 1,
    });
    const signals: string[] = [];
    await stopResidentDaemon({
      runtimeRoot: root,
      log: () => undefined,
      signalImpl: (_pid, signal) => {
        signals.push(signal);
      },
      isAliveImpl: () => true, // 永不死：强制走 SIGKILL 兜底
    });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(await readResidentDaemonStatus(statusPath), undefined);
  });
});
