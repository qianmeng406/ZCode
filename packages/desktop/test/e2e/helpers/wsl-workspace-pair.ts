import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runWSLCommand, type WSLP2RuntimeConfig } from "./wsl-workspace-p2.js";

function readPairConfig(): { dir: string; label: "A" | "B"; port: number } | null {
  const portText = process.env.ZCODE_E2E_WSL_PAIR_ROUTER_PORT;
  if (!portText) return null;
  const port = Number(portText);
  const dir = process.env.ZCODE_E2E_WSL_PAIR_BARRIER_DIR?.trim();
  const label = process.env.ZCODE_E2E_WSL_PAIR_LABEL;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !dir ||
    (label !== "A" && label !== "B")
  ) {
    throw new Error("WSL pair: router/barrier/label 配置无效");
  }
  return { port, dir, label };
}

export async function registerWSLPairReplay(
  config: WSLP2RuntimeConfig,
  runId: string,
  replayPort: number,
): Promise<number> {
  const pair = readPairConfig();
  if (!pair) return replayPort;
  if (
    !/^r[a-z0-9]+$/u.test(runId) ||
    !Number.isInteger(replayPort) ||
    replayPort < 1 ||
    replayPort > 65535
  ) {
    throw new Error("WSL pair: replay 注册参数无效");
  }
  const result = await runWSLCommand(
    config,
    `curl -fsS --max-time 5 http://127.0.0.1:${pair.port}/register/${runId}/${replayPort}`,
  );
  if (result.code !== 0) throw new Error("WSL pair: Linux loopback router 注册失败");
  return pair.port;
}

async function waitForFile(file: string): Promise<void> {
  const start = Date.now();
  while (true) {
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    if (exists) return;
    if (Date.now() - start > 120_000) throw new Error("WSL pair: peer barrier timed out");
    await delay(100);
  }
}

/** 两次 UI 取消先全部完成，再创建正常连接，避免全用户 PID 观察互相误判。 */
export async function waitForWSLPairCancellationBarrier(): Promise<void> {
  const pair = readPairConfig();
  if (!pair) return;
  await writeFile(join(pair.dir, `${pair.label}-cancelled`), "ready\n", { flag: "wx" });
  await Promise.all(["A", "B"].map((label) => waitForFile(join(pair.dir, `${label}-cancelled`))));
}

/** A 在 B 的独立桌面进程真正退出后继续 UI 关闭/重连，而非只等待 B 的模型答复。 */
export async function waitForWSLPairPeerExit(): Promise<boolean> {
  const pair = readPairConfig();
  if (!pair || pair.label !== "A") return false;
  await waitForFile(join(pair.dir, "B-exited"));
  return true;
}
