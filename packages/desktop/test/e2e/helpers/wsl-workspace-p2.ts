/* eslint-disable max-lines -- WSL P2 helper 集中维护 env 配置、wsl.exe 观察、Linux loopback replay 生命周期与 WSL 向导驱动，拆散会隐藏同一条真实链路边界。 */
// WSL 工作区第二阶段验收 helper（docs/research/wsl-workspace-acceptance.spec.md）。
// 与 ssh-remote-p0.ts 的关系：复用同一 RemoteConnectionDialog（TID_SSH_DIALOG/TID_SSH_SUCCESS）
// 与 remote tab 断言语义，但不复制 SSH client/replay tunnel —— WSL 侧通过 wsl.exe
// 直接观察 distro，并用 Linux loopback node 起 test-only replay，避免 NAT 下
// Windows localhost 从 Linux 不可达的假设。
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_REMOTE_KIND_WSL,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
  TID_WSL_DISTRO_SELECT,
  TID_WSL_USER_INPUT,
} from "@zcode/shared/test-ids";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { clickLastEnabledSSHDialogButton } from "./ssh-remote-p0.js";

export const WSL_CONNECT_TIMEOUT_MS = 10 * 60_000;
export const WSL_WORKSPACE_READY_TIMEOUT_MS = 2 * 60_000;
export const WSL_P2_ROUND_TIMEOUT_MS = 5 * 60_000;

const WSL_COMMAND = "wsl.exe";
const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;
const REPLAY_READY_TIMEOUT_MS = 30_000;

export function isWSLP2SpecEnabled(): boolean {
  return process.platform === "win32" && process.env.ZCODE_E2E_WSL_ACCEPTANCE?.trim() === "1";
}

/**
 * P2 配置显式化：distro/user/workspace/node 缺一不可；未配置或非 Windows 时
 * 调用方应显式 skip（blocked），不能回落默认值伪造通过。
 */
export function readWSLP2RuntimeConfig(caseMarker: string): WSLP2RuntimeConfig {
  const distro = process.env.ZCODE_E2E_WSL_DISTRO?.trim() || "";
  const user = process.env.ZCODE_E2E_WSL_USER?.trim() || "";
  const workspacePath = process.env.ZCODE_E2E_WSL_WORKSPACE_PATH?.trim() || "";
  const linuxNodePath = process.env.ZCODE_E2E_WSL_LINUX_NODE?.trim() || "";
  const missing = [
    ["ZCODE_E2E_WSL_DISTRO", distro],
    ["ZCODE_E2E_WSL_USER", user],
    ["ZCODE_E2E_WSL_WORKSPACE_PATH", workspacePath],
    ["ZCODE_E2E_WSL_LINUX_NODE", linuxNodePath],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${caseMarker}: WSL P2 缺少 env: ${missing.join(", ")}`);
  }
  for (const [name, value] of [
    ["ZCODE_E2E_WSL_WORKSPACE_PATH", workspacePath],
    ["ZCODE_E2E_WSL_LINUX_NODE", linuxNodePath],
  ] as const) {
    if (!value.startsWith("/")) {
      throw new Error(`${caseMarker}: ${name} 必须是 Linux 绝对路径`);
    }
    // 传给远端 sh 的值必须可安全单引号包裹。
    assertSafeShellValue(value, `${caseMarker}: ${name}`);
  }
  return {
    distro,
    user,
    workspacePath,
    linuxNodePath,
    hostForwardingProbe: false,
  };
}

export interface WSLP2RuntimeConfig {
  distro: string;
  user: string;
  workspacePath: string;
  /** Linux 侧 node 绝对路径，用于起 loopback replay。 */
  linuxNodePath: string;
  /** "loopback-forwarding" 表示 Windows 能 fetch Linux 127.0.0.1 端口（记录用，非验收断言）。 */
  hostForwardingProbe: boolean;
}

export function buildWSLTarget(config: WSLP2RuntimeConfig): RemoteTarget {
  return {
    kind: "wsl",
    distro: config.distro,
    user: config.user,
  };
}

export function buildWSLWorkspaceIdentity(config: WSLP2RuntimeConfig): string {
  return buildRemoteWorkspaceIdentity(config.workspacePath, buildWSLTarget(config));
}

/**
 * 远端 sh 单引号包裹安全性：拒绝单引号/NUL/换行，避免注入与参数截断。
 */
function assertSafeShellValue(value: string, context: string): void {
  // 单引号、换行、回车与 NUL 都会破坏远端 sh 的单引号包裹。
  const unsafeCharacters = ["'", "\n", "\r", "\u0000"];
  if (unsafeCharacters.some((character) => value.includes(character))) {
    throw new Error(`${context} 含 shell 不安全字符: ${JSON.stringify(value.slice(0, 32))}`);
  }
}

function quotePosixShellArg(value: string): string {
  assertSafeShellValue(value, "WSL P2: 值含 shell 不安全字符");
  return `'${value}'`;
}

/** Windows 侧执行 wsl.exe（显式 -d/-u，超时保护）。 */
export function runWSLCommand(
  config: Pick<WSLP2RuntimeConfig, "distro" | "user">,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      WSL_COMMAND,
      ["-d", config.distro, "-u", config.user, "--exec", "sh", "-c", command],
      { maxBuffer: WSL_EXEC_MAX_BUFFER, timeout: options.timeoutMs ?? 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        if (error && exitCode === null) {
          reject(error);
          return;
        }
        resolvePromise({
          code: exitCode,
          stderr: stderr.toString().replace(/\r/g, ""),
          stdout: stdout.toString().replace(/\r/g, ""),
        });
      },
    );
  });
}

/**
 * Linux loopback replay（anthropic-messages SSE，与 default e2e provider 的
 * apiFormat 一致）。脚本文件在 fixtures/upstream/wsl-p2/ 下独立维护，可单独
 * node --check 自测；由远端专属 node 执行，只监听 127.0.0.1，不开放公网。
 * 生命周期：远端脚本监听 stdin end 后自退出；helper 以 pipe stdin 保持存活，
 * close() 关闭 stdin 并验证进程退出，超时则按 PID 显式清理。
 */
export interface WSLReplayHandle {
  port: number;
  /** Linux 内自 probe 结果；false 说明 replay 没起来，必须 blocked。 */
  linuxLoopbackReachable: boolean;
  /** Windows 对同一 127.0.0.1:port 的 forwarding probe（仅记录，不作为验收条件）。 */
  windowsForwardingReachable: boolean;
  /** Linux HOME 下唯一 fixture 文件路径（由 replay 脚本输出）。 */
  fixturePath: string;
  requestLog: string[];
  close(): Promise<void>;
}

export const WSL_P2_FILE_MARKER = "E2E_WSLP2_FILE_MARKER_V1";
export const WSL_P2_BASH_APPEND_MARKER = "E2E_WSLP2_BASH_APPEND_V1";
export const WSL_P2_FINAL_MARKER = "E2E_WSLP2_ROUND_DONE";

export function resolveReplayScriptPath(): string {
  // fixtures 与 helper 同目录发布；require.resolve 保证打包/重定位后仍可定位。
  const require = createRequire(import.meta.url);
  return resolve(
    join(
      require.resolve("./ssh-remote-p0.js").replace(/ssh-remote-p0\.js$/u, ""),
      "../../fixtures/upstream/wsl-p2/wsl-p2-replay.mjs",
    ),
  );
}

export async function startWSLLoopbackReplay(
  config: WSLP2RuntimeConfig,
  runId: string,
): Promise<WSLReplayHandle> {
  if (!/^[a-z0-9]+$/u.test(runId)) throw new Error("WSL P2: 非法 runId");
  const scriptPath = resolveReplayScriptPath();
  const scriptBase64 = await (
    await import("node:fs/promises")
  )
    .readFile(scriptPath)
    .then((buffer) => buffer.toString("base64"));
  const quotedNode = quotePosixShellArg(config.linuxNodePath);
  const quotedRunId = quotePosixShellArg(runId);
  // 两步启动：base64 -d 需要 EOF 才能读完 stdin，不能兼任保活。
  // 步骤 1（runWSLCommand，stdin 已关闭）把脚本写到远端专属 HOME mktemp 唯一文件；
  // 步骤 2 另起 wsl.exe + node，stdin pipe 保持连接，远端脚本监听 end 后自退出。
  const remoteWriteScript = [
    `set -eu`,
    `mkdir -p "$HOME/.zcode-e2e-wslp2"`,
    `SCRIPT_DIR=$(mktemp -d "$HOME/.zcode-e2e-wslp2/replay-${runId}-XXXXXX")`,
    `SCRIPT_FILE="$SCRIPT_DIR/replay.mjs"`,
    `base64 -d > "$SCRIPT_FILE"`,
    `printf '%s\\n' "$SCRIPT_FILE"`,
  ].join(" && ");
  // wsl.exe 每次连接都输出 localhost forwarding 警告（UTF-16 混排）；统一在远端
  // 重定向 stderr 到 stdout 末行之外，保持 stdout 只有 SCRIPT_FILE 一行。
  // （警告仍会出现在 stderr，这里只依赖 stdout 末行路径。）

  const writeResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveWrite, rejectWrite) => {
      const writeChild = spawn(
        WSL_COMMAND,
        ["-d", config.distro, "-u", config.user, "--exec", "sh", "-c", remoteWriteScript],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      writeChild.stdout.setEncoding("utf8");
      writeChild.stderr.setEncoding("utf8");
      writeChild.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      writeChild.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      writeChild.stdin.write(`${scriptBase64}\n`);
      writeChild.stdin.end();
      writeChild.once("error", rejectWrite);
      writeChild.once("close", (code) => resolveWrite({ code, stdout, stderr }));
    },
  );
  if (writeResult.code !== 0) {
    throw new Error(
      `WSL P2: replay 脚本写入失败 code=${writeResult.code} ${writeResult.stderr.slice(0, 300)}`,
    );
  }
  const remoteScriptFile = writeResult.stdout.trim().split("\n").at(-1)?.trim();
  if (
    !remoteScriptFile ||
    !new RegExp(`/\\.zcode-e2e-wslp2/replay-${runId}-[a-zA-Z0-9]+/replay\\.mjs$`, "u").test(
      remoteScriptFile,
    )
  ) {
    throw new Error(`WSL P2: replay 脚本远端路径未返回: ${writeResult.stdout.slice(0, 200)}`);
  }

  const child = spawn(
    WSL_COMMAND,
    [
      "-d",
      config.distro,
      "-u",
      config.user,
      "--exec",
      "sh",
      "-c",
      `REPLAY_RUNID=${quotedRunId} REPLAY_WORKSPACE=${quotePosixShellArg(config.workspacePath)} exec ${quotedNode} ${quotePosixShellArg(remoteScriptFile)}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const requestLog: string[] = [];
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collectEvidence = (stream: NodeJS.ReadableStream) => {
    let pending = "";
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("REQ ") || line.startsWith("EVIDENCE ")) {
          requestLog.push(line.trim());
        }
      }
    });
  };
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer = (stdoutBuffer + chunk).slice(-65_536);
  });
  // console.log 在 stdout、console.error 在 stderr；按完整行收集，避免分块丢摘要。
  collectEvidence(child.stdout);
  collectEvidence(child.stderr);

  // stdin 保持打开（不写入、不 end）：远端脚本 resume stdin，end 时自退出。
  let port = 0;
  let fixturePath = "";
  try {
    const ready = await waitForReplayReady(() => stdoutBuffer, child);
    port = ready.port;
    fixturePath = ready.fixturePath;
  } catch (error) {
    await cleanupReplay(config, runId, child, remoteScriptFile);
    throw error;
  }

  // Linux 自 probe：replay 必须在 Linux loopback 真实可达，否则本轮 blocked。
  const linuxProbe = await runWSLCommand(
    config,
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/healthz || printf unreachable`,
    { timeoutMs: 20_000 },
  ).catch(() => ({ code: null, stdout: "", stderr: "probe-failed" }));
  const linuxLoopbackReachable = linuxProbe.stdout.includes("200");

  // Windows 对同一 loopback 的可达性只记录实测；可能随网络/forwarding 状态变化。
  const windowsForwardingReachable = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  })
    .then((response) => response.ok)
    .catch(() => false);

  return {
    port,
    linuxLoopbackReachable,
    windowsForwardingReachable,
    fixturePath,
    requestLog,
    close: async () => {
      // stdin end → 远端脚本监听 end 自退出；wsl.exe 进程随后退出。
      child.stdin.end();
      const exited = await Promise.race([
        new Promise<boolean>((resolvePromise) => {
          if (exitedChild(child)) {
            resolvePromise(true);
            return;
          }
          child.once("exit", () => resolvePromise(true));
        }),
        delay(8_000).then(() => false),
      ]);
      if (exitedChild(child)) {
        // 正常退出后清理本轮远端脚本目录（仅本轮 runId 路径）。
        await runWSLCommand(
          config,
          `rm -f ${quotePosixShellArg(remoteScriptFile)} && rmdir ${quotePosixShellArg(remoteScriptFile.slice(0, -"/replay.mjs".length))}`,
          { timeoutMs: 10_000 },
        ).then((result) => {
          if (result.code !== 0) throw new Error("WSL P2: owned replay 目录清理失败");
        });
        return;
      }
      if (!exited) {
        await cleanupReplay(config, runId, child, remoteScriptFile);
      }
    },
  };
}

function exitedChild(child: import("node:child_process").ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForReplayReady(
  readStdout: () => string,
  child: import("node:child_process").ChildProcess,
): Promise<{ port: number; fixturePath: string }> {
  const startedAt = Date.now();
  for (;;) {
    const stdout = readStdout();
    const portMatch = /REPLAY_PORT=(\d+)/u.exec(stdout);
    const fixtureMatch = /REPLAY_FIXTURE=(\S+)/u.exec(stdout);
    if (portMatch && fixtureMatch) {
      return { port: Number.parseInt(portMatch[1]!, 10), fixturePath: fixtureMatch[1]! };
    }
    if (child.exitCode !== null) {
      throw new Error(`WSL loopback replay 进程提前退出 code=${child.exitCode}`);
    }
    if (Date.now() - startedAt > REPLAY_READY_TIMEOUT_MS) {
      throw new Error(`WSL loopback replay ${REPLAY_READY_TIMEOUT_MS}ms 内没有输出端口`);
    }
    await delay(100);
  }
}

async function cleanupReplay(
  config: WSLP2RuntimeConfig,
  runId: string,
  child: import("node:child_process").ChildProcess,
  remoteScriptFile?: string,
): Promise<void> {
  child.kill();
  // 不按命令行模糊 pkill：可能命中观察用 sh 自身或其他进程。
  // wsl.exe 的 stdin 关闭后 fixture 应退出；失败时保留目录并交付精确路径。
  throw new Error(
    `WSL P2: replay 未正常退出，需核对本轮资源 run=${runId} path=${remoteScriptFile ?? "unknown"} distro=${config.distro}`,
  );
}

export async function openWSLRemoteDialogAndFill(
  config: WSLP2RuntimeConfig,
  caseMarker: string,
): Promise<void> {
  await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 空草稿没有显示 workspace 菜单`,
  });
  await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: workspace 菜单没有显示远程连接入口`,
  });
  await clickTestIdByWebDriver(TID_REMOTE_KIND_WSL, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 远程连接向导没有显示 WSL transport（非 Windows 或未启用时不应进入该用例）`,
  });
  await clickLastEnabledSSHDialogButton(caseMarker);
  await setWSLSettings(config, caseMarker);
  await clickLastEnabledSSHDialogButton(caseMarker);
}

async function setWSLSettings(config: WSLP2RuntimeConfig, caseMarker: string): Promise<void> {
  // distro 下拉是 shadcn Select：值由 UI 从 ListWSLDistros 加载；显式 distro 必须出现在选项里。
  await clickTestIdByWebDriver(TID_WSL_DISTRO_SELECT, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: WSL distro 下拉没有出现`,
  });
  const picked = await browser
    .waitUntil(
      async () =>
        browser.execute((distroName) => {
          const options = Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"], [data-radix-collection-item]'),
          );
          const target = options.find((option) => option.textContent?.trim() === distroName);
          if (!target) return false;
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          target.click();
          return true;
        }, config.distro),
      {
        timeout: 30_000,
        interval: 200,
        timeoutMsg: `${caseMarker}: WSL distro 列表没有出现 ${config.distro}`,
      },
    )
    .catch(() => false);
  if (!picked) {
    throw new Error(`${caseMarker}: WSL distro 下拉选择失败`);
  }

  const userInput = $(`[data-testid="${TID_WSL_USER_INPUT}"]`);
  await userInput.waitForDisplayed({ timeout: 15_000 });
  // clear()+sendKeys 在重新打开的 React 受控输入上可能追加旧值。
  await setInputValueByTestIdDom(TID_WSL_USER_INPUT, config.user);
  expect(await userInput.getValue()).toBe(config.user);
}

export async function waitForWSLDirectoryStep(caseMarker: string): Promise<void> {
  let errorText = "";
  await browser.waitUntil(
    async () => {
      errorText = await browser.execute((errorTestId) => {
        const error = document.querySelector<HTMLElement>(`[data-testid="${errorTestId}"]`);
        return error?.getClientRects().length ? error.innerText.trim() : "";
      }, TID_SSH_ERROR);
      if (errorText) return true;
      const successShown = await browser.execute((successTestId) => {
        const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
        return Boolean(success?.getClientRects().length);
      }, TID_SSH_SUCCESS);
      return successShown;
    },
    {
      timeout: WSL_CONNECT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: WSL 部署/连接没有完成（未出现成功目录步骤或错误提示）`,
    },
  );
  if (errorText) {
    throw new Error(`${caseMarker}: WSL 连接失败: ${errorText}`);
  }
}

/**
 * directory step 复用 SSH 选择器语义（TID_SSH_SUCCESS 容器 + 路径输入框 + 目录项按钮）。
 */
export async function selectWSLWorkspaceDirectory(
  config: WSLP2RuntimeConfig,
  caseMarker: string,
): Promise<void> {
  const normalizedPath = config.workspacePath.replace(/\/+$/, "") || "/";
  const lastSlash = normalizedPath.lastIndexOf("/");
  const parentPath = lastSlash === 0 ? "/" : normalizedPath.slice(0, lastSlash);
  const directoryName = normalizedPath.slice(lastSlash + 1);
  if (!directoryName) {
    throw new Error(`${caseMarker}: WSL P2 暂不支持选择根目录`);
  }

  const pathInput = $(`[data-testid="${TID_SSH_SUCCESS}"] input[type="text"]`);
  await pathInput.waitForDisplayed({ timeout: 30_000 });
  await pathInput.setValue(parentPath);
  await browser.keys("Enter");

  await browser.waitUntil(
    async () =>
      browser.execute(
        (successTestId, expectedName) => {
          const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
          const entry = Array.from(
            success?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => button.innerText.trim() === expectedName);
          if (!entry) return false;
          entry.click();
          return true;
        },
        TID_SSH_SUCCESS,
        directoryName,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: WSL 父目录没有显示目标目录 ${directoryName}`,
    },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (successTestId, expectedPath) => {
          const input = document
            .querySelector<HTMLElement>(`[data-testid="${successTestId}"]`)
            ?.querySelector<HTMLInputElement>('input[type="text"]');
          return input?.value === expectedPath;
        },
        TID_SSH_SUCCESS,
        normalizedPath,
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: WSL directory browser 没有进入目标路径`,
    },
  );
  await clickLastEnabledSSHDialogButton(caseMarker);
  await browser.waitUntil(
    () =>
      browser.execute(
        (dialogTestId) => !document.querySelector(`[data-testid="${dialogTestId}"]`),
        TID_SSH_DIALOG,
      ),
    {
      timeout: WSL_WORKSPACE_READY_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${caseMarker}: 选择 WSL 目录后向导没有关闭`,
    },
  );
  await waitForWorkspaceApp(config.workspacePath, WSL_WORKSPACE_READY_TIMEOUT_MS);
}

/** 远端 ext4 真实读回 fixture 文件内容（wsl.exe，非产品 RPC）。 */
export async function readWSLFixtureFile(
  config: WSLP2RuntimeConfig,
  fixturePath: string,
): Promise<string> {
  const result = await runWSLCommand(config, `cat ${quotePosixShellArg(fixturePath)}`, {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `WSL P2: 远端 fixture 读回失败 code=${result.code} stderr=${result.stderr.slice(0, 200)}`,
    );
  }
  return result.stdout;
}
