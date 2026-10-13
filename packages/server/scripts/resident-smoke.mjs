// 常驻远端 server 闭环冒烟（真实 bundle，不依赖 SSH）。
// 规格见 ../specs/remote-resident-server.md；验收条款见规格 §6。
//
// 前置：先构建远端单文件 bundle —— packages/server 下 `npx tsx build-remote.ts`。
// 运行：packages/server 下 `node scripts/resident-smoke.mjs`。
// 步骤：幂等启动 daemon → bridge 握手 → 断开 stdin（模拟桌面断开）→ 验证 daemon
// 存活 → 幂等重连同 pid → 新 bridge 再握手 → 显式停止。任一步失败以非 0 退出。
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "zcode-resident-smoke-"));
const bundle = join(fileURLToPath(new URL("../dist/remote/zcode-server.cjs", import.meta.url)));
const env = { ...process.env, ZCODE_SERVER_RUNTIME_ROOT: root };
const step = (message) => console.log("[step]", message);
const probe = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const run = async () => {
  // 1. --resident-start（幂等启动）
  execFileSync(process.execPath, [bundle, "--resident-start"], {
    env,
    stdio: "inherit",
    timeout: 40_000,
  });
  const status = JSON.parse(fs.readFileSync(join(root, "daemon.json"), "utf8"));
  step(`daemon started, pid=${status.pid} port=${status.port}`);

  // 2. bridge 握手 → 写 ack → 关 stdin（模拟桌面断开）
  const bridge = spawn(process.execPath, [bundle, "--resident-bridge"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridgeExit = new Promise((resolve) => bridge.once("exit", resolve));
  let hello = "";
  bridge.stdout.on("data", (chunk) => {
    hello += chunk.toString();
  });
  bridge.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (hello.includes("zcode-hello")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 15_000);
  });
  if (!hello.includes("zcode-hello")) {
    throw new Error("bridge handshake: no zcode-hello received");
  }
  step("hello received");
  bridge.stdin.write(
    `${JSON.stringify({ type: "zcode-hello-ack", version: "smoke", clientId: "smoke" })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  bridge.stdin.end();
  const exitCode = await Promise.race([
    bridgeExit,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8_000)),
  ]);
  if (exitCode !== 0) {
    throw new Error(`bridge did not exit cleanly after stdin EOF (got: ${exitCode})`);
  }
  step("bridge exited with 0 after stdin EOF");

  // 3. daemon 必须仍然存活（断开 ≠ 任务终止）
  if (!(await probe(status.port))) {
    throw new Error("daemon died after bridge disconnect");
  }
  step("daemon still alive after disconnect");

  // 4. 重连路径：--resident-start 幂等复用 + 新 bridge 再握手
  execFileSync(process.execPath, [bundle, "--resident-start"], {
    env,
    stdio: "ignore",
    timeout: 40_000,
  });
  const status2 = JSON.parse(fs.readFileSync(join(root, "daemon.json"), "utf8"));
  if (status2.pid !== status.pid) {
    throw new Error(`idempotent start respawned daemon (${status.pid} -> ${status2.pid})`);
  }
  step("idempotent start reuses same daemon");
  const bridge2 = spawn(process.execPath, [bundle, "--resident-bridge"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let hello2 = "";
  bridge2.stdout.on("data", (chunk) => {
    hello2 += chunk.toString();
  });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (hello2.includes("zcode-hello")) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 15_000);
  });
  if (!hello2.includes("zcode-hello")) {
    throw new Error("reconnect handshake: no zcode-hello received");
  }
  step("reconnect hello received");
  bridge2.kill();

  // 5. 显式停止
  execFileSync(process.execPath, [bundle, "--resident-stop"], {
    env,
    stdio: "inherit",
    timeout: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (await probe(status.port)) {
    throw new Error("daemon still alive after --resident-stop");
  }
  step("daemon stopped");
  step("SMOKE OK");
};

try {
  await run();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
