/* eslint-disable no-console -- 验收脚本以控制台输出为交付物。 */
// WSL 工作区第二阶段验收驱动（opt-in）：走公开 remote 入口 connectRemote + 标准 deployServer
// 部署链路（skipDeploy 不设置），对专属 WSL 用户/ext4 工作区验证隔离 HOME、RPC 文件写/读、
// Git、真实 terminal PTY（订阅后写、分拆 marker 防 echo 误判、pwd/同文件改写、明确等 exit）。
// 不改变部署与 exec 语义；backend.exec 仅用于有界只读资源观察。
// 规格见 docs/research/wsl-workspace-acceptance.spec.md。
// 用法: npx tsx packages/server/scripts/wsl-workspace-smoke.ts --distro Ubuntu-24.04
//   --user zcodewslp2 --workspace /home/zcodewslp2/workspace
//   --mock-cdn-dir <绝对路径> --output <结果json绝对路径>
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { ZCODE_VERSION, type GitFileChange } from "@zcode/shared";
import {
  connectRemote,
  createRemoteBackend,
  isWSLAvailable,
  listWSLDistros,
  type RemoteConnection,
} from "@zcode/server/remote";
import { parseSmokeArgs, type WslWorkspaceSmokeOptions } from "./wsl-workspace-smoke-args.js";
import { resolveEffectiveAssetsRoot } from "./wsl-workspace-smoke-assets.js";

interface CheckResult {
  name: string;
  status: "passed" | "failed";
  detail: string;
}

const checks: CheckResult[] = [];
const timings: Record<string, number> = {};
const resources: Record<string, string> = {};
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, status: ok ? "passed" : "failed", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// 远端一律是 POSIX 路径；shell 参数统一单引号转义，杜绝路径元字符注入。
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 有界只读远端命令：输出超上限即截断，超时即失败。 */
async function runCapture(
  backend: Awaited<ReturnType<typeof createRemoteBackend>>,
  command: string,
  timeoutMs = 20_000,
): Promise<string> {
  const maxChars = 64 * 1024;
  const stream = await backend.exec(command);
  let stdout = "";
  let stderr = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    if (stdout.length < maxChars) {
      stdout += chunk.toString();
    }
  });
  stream.stderr.on("data", (chunk: Buffer | string) => {
    if (stderr.length < maxChars) {
      stderr += chunk.toString();
    }
  });
  const exitCode = await new Promise<number>((resolveClose, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`远端命令超时(${timeoutMs}ms): ${command}`)),
      timeoutMs,
    );
    stream.onClose((code) => {
      clearTimeout(timer);
      resolveClose(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`远端命令失败(exit=${exitCode}): ${command}\n${stderr || stdout}`);
  }
  return stdout.trim();
}

/** 先订阅再发送，避免快速 PTY 命令在 RPC write 返回前已经输出。 */
async function collectUntil(
  event: (listener: (data: string) => void) => { dispose(): void },
  isDone: (buffer: string) => boolean,
  timeoutMs: number,
  trigger: () => Promise<void>,
): Promise<string> {
  let buffer = "";
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      disposable.dispose();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`PTY 输出等待超时(${timeoutMs}ms): ${JSON.stringify(buffer.slice(-400))}`));
    }, timeoutMs);
    const disposable = event((data) => {
      buffer = (buffer + data).slice(-64 * 1024);
      if (isDone(buffer)) {
        cleanup();
        resolve(buffer);
      }
    });
    void trigger().catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function run(): Promise<void> {
  const options: WslWorkspaceSmokeOptions = parseSmokeArgs(process.argv.slice(2));
  const skipped = (notes: string[]) =>
    emitResult(options, "skipped", { checks, timings, resources }, notes);
  if (process.platform !== "win32") {
    await skipped([`非 Windows 平台(${process.platform})，WSL 驱动明确 skip`]);
    return;
  }
  if (!(await isWSLAvailable())) {
    await skipped(["wsl.exe 不可用，WSL 驱动明确 skip"]);
    return;
  }
  const distros = await listWSLDistros();
  if (!distros.some((item) => item.name === options.distro)) {
    throw new Error(
      `WSL 发行版不存在: ${options.distro}（已安装: ${distros.map((item) => item.name).join(", ") || "<none>"}）`,
    );
  }

  // 随包资源目录核验：按运行时版本映射（tsx 源码态 ZCODE_VERSION 为 0.0.0-dev）。
  const assets = await resolveEffectiveAssetsRoot(options.mockCdnDir);
  const effectiveAssetsDir = assets.root;
  const releaseDir = `${effectiveAssetsDir}/releases/${ZCODE_VERSION}`.replaceAll("\\", "/");
  try {
    if (!existsSync(`${releaseDir}/server/zcode-server.cjs`)) {
      throw new Error(`随包资源缺件: ${releaseDir}/server/zcode-server.cjs 不存在`);
    }
    console.log(`assets: ${effectiveAssetsDir}`);
    console.log(`target: ${options.distro} / ${options.user} / ${options.workspace}`);
    await driveChecks(options, effectiveAssetsDir, timings, resources);
  } finally {
    // 只清理 helper 自建的临时映射目录；原目录从不触碰。
    await assets.cleanup?.();
  }

  const failed = checks.filter((item) => item.status === "failed");
  await emitResult(
    options,
    failed.length > 0 ? "failed" : "passed",
    { checks, timings, resources },
    failed.map((item) => `${item.name}: ${item.detail}`),
  );
}

async function driveChecks(
  options: WslWorkspaceSmokeOptions,
  effectiveAssetsDir: string,
  timings: Record<string, number>,
  resources: Record<string, string>,
): Promise<void> {
  const target = { kind: "wsl" as const, distro: options.distro, user: options.user };
  const connectOptions = {
    mockCdnDir: effectiveAssetsDir,
    assetInstallMode: "local-download-upload" as const,
    clientId: "wsl-workspace-smoke",
    handshakeTimeout: 30_000,
  };
  // connectRemote 的 disposeAndWait 会一并 dispose backend，所以再连必须新建 backend 实例。
  let backend = await createRemoteBackend(target);
  let connection: RemoteConnection | null = null;
  try {
    const firstStart = Date.now();
    connection = await connectRemote(backend, connectOptions);
    timings.firstConnectMs = Date.now() - firstStart;
    record("首次 connectRemote（含标准部署）成功", true, `${timings.firstConnectMs}ms`);

    await verifySystemHome(connection, options, timings);
    const markerFile = `${options.workspace}/.zcodeignore`;
    await verifyFileWriteRead(connection, options.workspace, markerFile, timings);
    const pty = await verifyTerminalPty(connection, options, markerFile, timings);
    await verifyGit(connection, pty.repoDir, timings);

    // 有界只读资源观察：独立 exec，不影响已建立的 stdio/RPC 通道语义。
    try {
      const snapshot = await runCapture(
        backend,
        'id -u; free -m | awk \'NR==2{print $2" "$3}\'; ps -u "$USER" -o pid= | wc -l',
      );
      const [uid, mem, procCount] = snapshot.split("\n");
      resources.uid = uid?.trim() ?? "unknown";
      resources.memoryUsedTotalMb = mem?.trim() ?? "unknown";
      resources.userProcessCount = procCount?.trim() ?? "unknown";
    } catch (error) {
      resources.observationError = error instanceof Error ? error.message : String(error);
    }

    const firstCloseStart = Date.now();
    await connection.disposeAndWait({ timeoutMs: 10_000 });
    connection = null;
    timings.firstDisposeMs = Date.now() - firstCloseStart;
    record("首次 disposeAndWait 按 stdio 语义回收", true, `${timings.firstDisposeMs}ms`);

    backend = await createRemoteBackend(target);
    const reconnectStart = Date.now();
    connection = await connectRemote(backend, connectOptions);
    timings.reconnectMs = Date.now() - reconnectStart;
    record("再连 connectRemote 成功（幂等部署）", true, `${timings.reconnectMs}ms`);

    const reread = await connection.services.fileService.readTextFile({
      path: markerFile,
      length: 64,
    });
    record(
      "再连后同一 ext4 文件内容仍在",
      reread.content.includes("wsl-smoke-pty-rewritten"),
      reread.content.slice(0, 64),
    );

    const secondCloseStart = Date.now();
    await connection.disposeAndWait({ timeoutMs: 10_000 });
    connection = null;
    timings.reconnectDisposeMs = Date.now() - secondCloseStart;
  } finally {
    if (connection) {
      try {
        await connection.disposeAndWait({ timeoutMs: 10_000 });
      } catch (error) {
        console.warn("disposeAndWait 失败:", error);
      }
    }
    try {
      await backend.disposeAndWait();
    } catch (error) {
      console.warn("backend 释放失败:", error);
    }
  }
}

async function verifySystemHome(
  connection: RemoteConnection,
  options: WslWorkspaceSmokeOptions,
  timings: Record<string, number>,
): Promise<void> {
  const infoStart = Date.now();
  const info = await connection.services.systemService.info();
  timings.systemInfoMs = Date.now() - infoStart;
  const expectedHome = `/home/${options.user}`;
  record(
    "远端 system HOME 为专属隔离用户",
    info.platform === "linux" && info.homedir === expectedHome,
    `platform=${info.platform} homedir=${info.homedir}`,
  );
}

async function verifyFileWriteRead(
  connection: RemoteConnection,
  workspace: string,
  markerFile: string,
  timings: Record<string, number>,
): Promise<void> {
  const writeStart = Date.now();
  const markerContent = `wsl-smoke-marker ${new Date().toISOString()}\n`;
  // FileService 公开 RPC 里唯一的通用工作区写入入口是 .zcodeignore 原子写。
  await connection.services.fileService.writeWorkspaceFileSearchIgnore({
    rootPath: workspace,
    content: markerContent,
  });
  const slice = await connection.services.fileService.readTextFile({
    path: markerFile,
    length: 128,
  });
  timings.fileWriteReadMs = Date.now() - writeStart;
  record(
    "RPC 文件写入后读回一致（同一 ext4 路径）",
    slice.content === markerContent && slice.isBinary === false,
    `path=${slice.path} bytes=${slice.bytesRead}`,
  );
}

async function verifyTerminalPty(
  connection: RemoteConnection,
  options: WslWorkspaceSmokeOptions,
  markerFile: string,
  timings: Record<string, number>,
): Promise<{ repoDir: string }> {
  const ptyStart = Date.now();
  const created = await connection.services.terminalService.create({
    cols: 80,
    rows: 24,
    cwd: options.workspace,
  });
  const dataEvent = connection.services.terminalService.onDynamicData(created.id);
  const write = (data: string) =>
    connection.services.terminalService.write({ id: created.id, data });
  const marker = `WSL_SMOKE_${Date.now()}`;
  const repoDir = `${options.workspace}/wsl-smoke-git-${Date.now()}`;
  let exited = false;
  try {
    // 命令行里拆分 marker，只有真实输出才会出现完整值；还需 RPC 读回验证文件。
    const output = await collectUntil(
      dataEvent,
      (buffer) => buffer.includes(marker) && buffer.includes("wsl-smoke-pty-rewritten"),
      30_000,
      () =>
        write(
          `printf 'PWD_%s=%s\\n' ${shQuote(marker)} "$PWD"; printf 'WSL_%s\\n' ${shQuote(marker.slice(4))}; ` +
            `printf '%s\\n' "wsl-smoke-pty-""rewritten" > ${shQuote(markerFile)}; cat ${shQuote(markerFile)}\n`,
        ),
    );
    const pwdEvidence = `PWD_${marker}=${options.workspace}`;
    record(
      "真实 PTY pwd 为指定工作区",
      output.includes(pwdEvidence),
      output.includes(pwdEvidence) ? pwdEvidence : JSON.stringify(output.slice(-800)),
    );
    record("真实 PTY marker 输出", output.includes(marker), marker);
    const reread = await connection.services.fileService.readTextFile({
      path: markerFile,
      length: 128,
    });
    record("真实 PTY 同文件改写成功", reread.content === "wsl-smoke-pty-rewritten\n", markerFile);
    const gitOutput = await collectUntil(
      dataEvent,
      (buffer) => buffer.includes("DONE_GIT_SETUP") || buffer.includes("GIT_SETUP_FAILED"),
      30_000,
      () =>
        write(
          `mkdir ${shQuote(repoDir)} && cd ${shQuote(repoDir)} && git init -q && ` +
            `git config user.email smoke@example.invalid && git config user.name smoke && ` +
            `echo hello > tracked.txt && echo DONE_GIT_"SETUP" || echo GIT_SETUP_"FAILED"\n`,
        ),
    );
    if (gitOutput.includes("GIT_SETUP_FAILED")) throw new Error(`smoke 仓库建立失败: ${repoDir}`);
    // dispose 会先移除 exitEmitter，因此用 shell 自然 exit 来验证退出事件。
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        reject(new Error("PTY exit 超时"));
      }, 5_000);
      const subscription = connection.services.terminalService.onDynamicExit(created.id)(
        (value) => {
          clearTimeout(timer);
          subscription.dispose();
          exited = true;
          resolve(value);
        },
      );
      void write("exit 0\n").catch((error) => {
        clearTimeout(timer);
        subscription.dispose();
        reject(error);
      });
    });
    record("真实 PTY 自然 exit 上报", code === 0, `exit=${code}`);
    timings.ptyMs = Date.now() - ptyStart;
    return { repoDir };
  } finally {
    if (!exited) await connection.services.terminalService.dispose({ id: created.id });
  }
}

async function verifyGit(
  connection: RemoteConnection,
  repoDir: string,
  timings: Record<string, number>,
): Promise<void> {
  const gitStart = Date.now();
  const summary = await connection.services.gitService.getRepositorySummary({
    workspacePath: repoDir,
  });
  const changes: GitFileChange[] = await connection.services.gitService.getChanges({
    workspacePath: repoDir,
    sourceId: "unstaged",
  });
  const tracked = changes.find((change) => change.path.endsWith("tracked.txt"));
  if (tracked && !tracked.isStaged) {
    await connection.services.gitService.stagePaths({
      workspacePath: repoDir,
      paths: [tracked.path],
    });
  }
  const staged: GitFileChange[] = await connection.services.gitService.getChanges({
    workspacePath: repoDir,
    sourceId: "staged",
  });
  timings.gitMs = Date.now() - gitStart;
  record(
    "Git 仓库摘要与分支可读",
    summary.repoRoot === repoDir && summary.isGitAvailable,
    `repoRoot=${summary.repoRoot} branch=${summary.branchName ?? "<null>"}`,
  );
  record(
    "Git 未跟踪变更可见并可 stage",
    Boolean(tracked) && staged.some((change) => change.path.endsWith("tracked.txt")),
    `unstaged=${changes.length} staged=${staged.length}`,
  );
}

interface SmokeReport {
  checks: CheckResult[];
  timings: Record<string, number> | null;
  resources: Record<string, string> | null;
}

async function emitResult(
  options: WslWorkspaceSmokeOptions,
  status: "passed" | "failed" | "skipped",
  report: SmokeReport,
  notes: string[],
): Promise<void> {
  const payload = {
    status,
    distro: options.distro,
    user: options.user,
    workspace: options.workspace,
    zcodeVersion: ZCODE_VERSION,
    finishedAt: new Date().toISOString(),
    ...report,
    ...(notes.length > 0 ? { notes } : {}),
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\n=== 结果: ${status} ===`);
  for (const note of notes) {
    console.log(`- ${note}`);
  }
  console.log(`结构化结果已写入: ${options.output}`);
  if (status === "failed") {
    process.exitCode = 1;
  }
}

run().catch(async (error: unknown) => {
  console.error("驱动执行失败:", error instanceof Error ? error.message : error);
  const message = error instanceof Error ? error.message : String(error);
  try {
    const options = parseSmokeArgs(process.argv.slice(2));
    await emitResult(options, "failed", { checks, timings, resources }, [message]);
  } catch {
    // 参数本身非法时无法写出结构化结果；非零退出即可。
  }
  process.exitCode = 1;
});
