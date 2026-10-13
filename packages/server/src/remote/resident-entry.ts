// ============================================================
// Resident server entry dispatch（zcode-server.cjs 的常驻子命令）。
// 供 entry-stdio 在 --version 校验后分发；stdio 模式路径不受影响。
// ============================================================
import { homedir } from "node:os";
import { join } from "node:path";
import { formatLogPrefix } from "@zcode/shared";
import { disposeServiceResourcesAndWait, getAppConfigDir } from "@zcode/services/node";
import { createStdioServices } from "../stdioServices.js";
import { ensureRemoteServerDeviceMid } from "../stdioDeviceMid.js";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "../bundledZCodeBuiltinProviderConfig.js";
import { runResidentStdioBridge } from "./resident-bridge.js";
import {
  ensureResidentDaemonRunning,
  runResidentDaemonServe,
  stopResidentDaemon,
} from "./resident-daemon.js";
import type { ResidentArgvCommand } from "./resident-protocol.js";

const log = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-server:resident", process.pid), ...args);

function resolveRuntimeRoot(): string {
  return process.env.ZCODE_SERVER_RUNTIME_ROOT?.trim() || join(homedir(), ".zcode", "server");
}

/** daemon 自我复刻的脚本路径；仅支持部署后的单文件 bundle（dev 下 tsx 无法被 node 直接执行）。 */
function resolveSelfScriptPath(): string {
  const scriptPath = process.argv[1]?.trim() || "";
  if (!scriptPath || !/\.(cjs|js)$/u.test(scriptPath)) {
    throw new Error(
      `Resident daemon requires the deployed single-file bundle (got: ${scriptPath || "empty"})`,
    );
  }
  return scriptPath;
}

export async function runResidentEntryCommand(command: ResidentArgvCommand): Promise<number> {
  switch (command) {
    case "start":
      return await runStartCommand();
    case "serve":
      return await runServeCommand();
    case "bridge":
      return await runBridgeCommand();
    case "stop":
      return await runStopCommand();
  }
}

async function runStartCommand(): Promise<number> {
  await ensureResidentDaemonRunning({
    runtimeRoot: resolveRuntimeRoot(),
    scriptPath: resolveSelfScriptPath(),
    env: process.env,
    log,
  });
  return 0;
}

async function runServeCommand(): Promise<number> {
  // daemon 持有任务事实：单点未捕获异常不能静默带走进程（任务对手机端表现为
  // 全部挂起）。兜底只记日志并继续——连接级错误已在 ChannelServer 内就地回错，
  // 走到这里的是真正未预见的路径，保活优于死亡。
  process.on("uncaughtException", (error) => {
    log("resident daemon uncaughtException (kept alive):", error);
  });
  process.on("unhandledRejection", (reason) => {
    log("resident daemon unhandledRejection (kept alive):", reason);
  });
  // 与 stdio 入口同序：先确保远端设备身份，再物化 provider 配置、创建服务。
  await ensureRemoteServerDeviceMid({ log });
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const { services } = createStdioServices({
    env: process.env,
    zcodeBuiltinProviderConfigFilePath,
  });
  const handle = await runResidentDaemonServe({
    runtimeRoot: resolveRuntimeRoot(),
    services,
    log,
  });

  // SIGTERM = 显式停止（--resident-stop / 未来 UI 入口）。退出前必须遵守
  // ServiceCollection 的异步回收契约，避免 workspace Agent 进程树残留。
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`resident daemon stopping (${reason})`);
    void (async () => {
      try {
        await handle.close();
      } finally {
        await disposeServiceResourcesAndWait(services);
        process.exit(0);
      }
    })();
  };
  process.once("SIGTERM", () => shutdown("sigterm"));
  process.once("SIGINT", () => shutdown("sigint"));

  // 常驻：只有 shutdown 路径会结束进程。
  return await new Promise<number>(() => undefined);
}

async function runBridgeCommand(): Promise<number> {
  return await runResidentStdioBridge({
    runtimeRoot: resolveRuntimeRoot(),
    io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  });
}

async function runStopCommand(): Promise<number> {
  const stopped = await stopResidentDaemon({ runtimeRoot: resolveRuntimeRoot(), log });
  log(stopped ? "resident daemon stopped" : "resident daemon not running");
  return 0;
}
