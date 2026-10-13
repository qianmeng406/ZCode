/* eslint-disable no-console -- 验收脚本以控制台输出为交付物。 */
// 远端资源「随包本地分发」端到端验收：对真实 Linux 目标跑应用同一条部署链路，
// 只给 mockCdnDir（随包资源目录）、不传任何 CDN 字段，验证：
//   1) 全程没有任何 HTTP(S) 出网（CDN 请求）；
//   2) 远端拿到与本仓库源码一致的 server bundle（含 fork 的 resident 改动）；
//   3) 本地资源缺件时报错清晰且不回退官方 CDN。
//
// 用法（仓库根目录）：
//   npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl [--distro Ubuntu-24.04]
//   npx tsx packages/server/scripts/remote-local-assets-check.ts --ssh <host> --user <name>
//       [--port 22] [--password-file <path> | --password-env <name> | --password <pw>]
//       [--private-key <path>] [--private-key-passphrase <pw>]
//   可选：--local-assets <dir>（默认 packages/desktop/dist-remote-assets-local）
//
// 凭据建议走 --password-file / --private-key：--password 会出现在本机命令行的进程列表里。
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import type { RemoteTarget } from "@zcode/shared";
import { createRemoteBackend, deployServer } from "@zcode/server/remote";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote";

const repoRoot = resolve(import.meta.dirname, "../../..");

interface Options {
  transport: "wsl" | "ssh";
  distro?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  localAssetsDir: string;
  /** 全量重传（默认 false：与真实应用一致，按版本增量补齐）。 */
  force?: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {};
  const readValue = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`缺少 ${name} 的参数值`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--wsl") {
      options.transport = "wsl";
      continue;
    }
    if (arg === "--ssh") {
      options.transport = "ssh";
      options.host = readValue(index, "--ssh");
      index += 1;
      continue;
    }
    if (arg === "--distro") {
      options.distro = readValue(index, "--distro");
      index += 1;
      continue;
    }
    if (arg === "--user") {
      options.user = readValue(index, "--user");
      index += 1;
      continue;
    }
    if (arg === "--port") {
      options.port = Number(readValue(index, "--port"));
      index += 1;
      continue;
    }
    if (arg === "--password") {
      options.password = readValue(index, "--password");
      index += 1;
      continue;
    }
    if (arg === "--password-file") {
      // 从文件读密码：避免密码出现在命令行参数、进程列表和终端回显里。
      const passwordFile = readValue(index, "--password-file");
      options.password = readFileSync(passwordFile, "utf8").replace(/[\r\n]+$/, "");
      index += 1;
      continue;
    }
    if (arg === "--password-env") {
      const envName = readValue(index, "--password-env");
      const password = process.env[envName];
      if (!password) {
        throw new Error(`环境变量 ${envName} 为空`);
      }
      options.password = password;
      index += 1;
      continue;
    }
    if (arg === "--private-key") {
      options.privateKeyPath = readValue(index, "--private-key");
      index += 1;
      continue;
    }
    if (arg === "--private-key-passphrase") {
      options.privateKeyPassphrase = readValue(index, "--private-key-passphrase");
      index += 1;
      continue;
    }
    if (arg === "--local-assets") {
      options.localAssetsDir = readValue(index, "--local-assets");
      index += 1;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  if (!options.transport) {
    throw new Error("必须指定 --wsl 或 --ssh <host>");
  }
  if (options.transport === "ssh" && !options.host) {
    throw new Error("--ssh 需要主机地址");
  }
  options.localAssetsDir ??= join(repoRoot, "packages/desktop/dist-remote-assets-local");
  return options as Options;
}

function buildTarget(options: Options): RemoteTarget {
  if (options.transport === "wsl") {
    return { kind: "wsl", ...(options.distro ? { distro: options.distro } : {}) };
  }
  return {
    kind: "ssh",
    host: options.host!,
    ...(options.port ? { port: options.port } : {}),
    username: options.user ?? "root",
    ...(options.password ? { password: options.password } : {}),
    ...(options.privateKeyPath ? { privateKeyPath: options.privateKeyPath } : {}),
    ...(options.privateKeyPassphrase ? { privateKeyPassphrase: options.privateKeyPassphrase } : {}),
  };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function runCapture(backend: IRemoteBackend, command: string): Promise<string> {
  const stream = await backend.exec(command);
  let stdout = "";
  let stderr = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  stream.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number>((resolveClose) => {
    stream.onClose((code) => resolveClose(code));
  });
  if (exitCode !== 0) {
    throw new Error(`远端命令失败(exit=${exitCode}): ${command}\n${stderr || stdout}`);
  }
  return stdout.trim();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// wsl.exe 的输出可能带额外终结字符/编码差异，直接字符串相等比较容易假失败；
// 统一按 64 位十六进制摘要提取后再比。
function extractSha256(output: string): string | null {
  return output.match(/[0-9a-f]{64}/)?.[0] ?? null;
}

// tsx 直跑源码时 bundler 的 __ZCODE_VERSION__ 未注入，ZCODE_VERSION 退化成 "0.0.0-dev"，
// 而随包资源目录是按真实版本命名的（如 releases/3.14.3），部署链路会按 ZCODE_VERSION 去找。
// 这里把真实 release 目录映射成运行时看到的版本号（junction），让源码态验收与打包态行为一致。
function resolveEffectiveAssetsRoot(localAssetsDir: string): string {
  // Windows junction 必须用绝对目标路径：传入相对路径时 link 会指向错误位置，
  // 表现为"目录明明在却读不到文件"。这里统一绝对化。
  const absoluteAssetsDir = resolve(localAssetsDir);
  const releasesRoot = join(absoluteAssetsDir, "releases");
  if (existsSync(join(releasesRoot, ZCODE_VERSION))) {
    return absoluteAssetsDir;
  }

  const versionDirs = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
  if (versionDirs.length === 0) {
    return absoluteAssetsDir;
  }

  const mappedRoot = join(tmpdir(), `zcode-local-assets-version-map-${process.pid}`);
  const mappedReleases = join(mappedRoot, "releases");
  rmSync(mappedRoot, { recursive: true, force: true });
  mkdirSync(mappedReleases, { recursive: true });
  for (const versionDir of versionDirs) {
    symlinkSync(join(releasesRoot, versionDir), join(mappedReleases, versionDir), "junction");
  }
  symlinkSync(join(releasesRoot, versionDirs[0]!), join(mappedReleases, ZCODE_VERSION), "junction");

  // 映射后立即自校验：link 建失败时必须在部署前就停下，否则会误报"随包资源缺失"。
  const probePath = join(mappedReleases, ZCODE_VERSION, "server", "zcode-server.cjs");
  if (!existsSync(probePath)) {
    throw new Error(`版本目录映射失败，无法读取 ${probePath}`);
  }
  console.log(
    `[assets] 运行时版本号为 ${ZCODE_VERSION}，已把 releases/${versionDirs[0]} 映射为 releases/${ZCODE_VERSION}`,
  );
  return mappedRoot;
}

// 出网守卫：本地资源模式下若有任何 fetch，就在此暴露出来。
const fetchAttempts: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : (input as URL | Request).toString();
  fetchAttempts.push(url);
  return originalFetch(input, init);
}) as typeof fetch;

const options = parseArgs(process.argv.slice(2));
// mockCdnDir 必须用「运行时能看到的版本布局」那一份；打包态下二者本来就是同一个目录。
const effectiveAssetsDir = resolveEffectiveAssetsRoot(options.localAssetsDir);
const releaseDir = join(effectiveAssetsDir, "releases", ZCODE_VERSION);

console.log("=== 远端资源本地分发端到端验收 ===");
console.log(`transport: ${options.transport}`);
console.log(`localAssetsDir: ${options.localAssetsDir}`);
console.log(`effectiveAssetsDir: ${effectiveAssetsDir}`);
console.log(`releaseDir: ${releaseDir}`);

record(
  "本地资源树存在（随包目录布局）",
  existsSync(join(releaseDir, "server/zcode-server.cjs")),
  releaseDir,
);
if (results.some((item) => !item.ok)) {
  process.exit(1);
}

const backend = await createRemoteBackend(buildTarget(options));
let deployError: unknown = null;
try {
  const env: RemoteEnvironment = await backend.detect();
  console.log(`remote env: ${env.platform}-${env.arch}`);
  record("远端平台 arch 与本地资源匹配", true, `${env.platform}-${env.arch}`);

  const localServerBundle = join(releaseDir, "server/zcode-server.cjs");
  const localServerSha = sha256File(localServerBundle);

  // 只给 mockCdnDir：不传 remoteCdnBaseUrl / remoteCdnBaseUrls / remoteCacheDir，
  // 与打包版默认（resources/remote-assets 命中本地分支）完全一致。
  // 默认不带 force：与真实应用一致，已一致的组件按版本跳过（断点续传式的增量补齐）；
  // --force 才全量重传。
  const deployed = await deployServer(backend, env, {
    mockCdnDir: effectiveAssetsDir,
    assetInstallMode: "local-download-upload",
    ...(options.force ? { force: true } : {}),
  });
  record("deployServer 完成", true, `deployed=${deployed}${options.force ? " (force)" : ""}`);

  // 验证合并为一次远端 exec：跨公网的 SSH 链路对多轮小命令不友好
  // （实测连续多次 exec 会出现读到空输出的抖动），一次批量取回全部证据更稳。
  const verifyScript = [
    'BASE="$HOME/.zcode/server"',
    'echo "server_sha=$(sha256sum "$BASE/zcode-server.cjs" | awk \'{print $1}\')"',
    'echo "resident_markers=$(grep -c \'resident-daemon\\|resident-entry\' "$BASE/zcode-server.cjs" || true)"',
    'echo "node_version=$("$BASE/node" --version 2>/dev/null || true)"',
    'echo "glm_count=$(find "$BASE/agents" -name zcode.cjs 2>/dev/null | wc -l)"',
    'echo "pty_present=$([ -f "$BASE/build/Release/pty.node" ] && echo yes || echo no)"',
    'echo "tools_count=$(find "$BASE/tools" -type f \\( -name rg -o -name ugrep -o -name bfs \\) 2>/dev/null | wc -l)"',
  ].join("\n");

  const verify: Record<string, string> = {};
  for (const line of (await runCapture(backend, verifyScript)).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      verify[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
  }

  const remoteSha = extractSha256(verify.server_sha ?? "");
  record(
    "远端 server bundle 与本地随包产物 sha256 一致",
    remoteSha === localServerSha,
    `local=${localServerSha.slice(0, 16)}… remote=${(remoteSha ?? "<null>").slice(0, 16)}…`,
  );

  const residentMarkers = verify.resident_markers ?? "";
  record(
    "远端 server bundle 含 fork 常驻改动（resident-daemon/entry）",
    Number(residentMarkers) > 0,
    `markers=${residentMarkers}`,
  );

  const nodeVersion = verify.node_version ?? "";
  record("远端 node 运行时可直接执行", /^v\d+/.test(nodeVersion), nodeVersion);

  const glmCount = verify.glm_count ?? "";
  record("远端 glm agent bundle 已落地", Number(glmCount) > 0, `matches=${glmCount}`);

  const ptyExists = verify.pty_present ?? "";
  record("远端 node-pty 预编译已落地", ptyExists === "yes", ptyExists);

  const toolsCount = verify.tools_count ?? "";
  record("远端随包搜索工具已落地", Number(toolsCount) >= 3, `matches=${toolsCount}`);
} catch (error) {
  deployError = error;
  record("部署链路未抛错", false, String(error));
}

record(
  "全程无任何 HTTP(S) 出网（无 CDN 请求）",
  fetchAttempts.length === 0,
  fetchAttempts.length === 0 ? "0 次 fetch" : fetchAttempts.join(", "),
);

// 负向：本地资源缺件时必须明确报错，而不是静默回退官方 CDN。
try {
  const env = await backend.detect();
  const emptyAssetsDir = join(repoRoot, "packages/desktop/dist-remote-assets-local-missing");
  await deployServer(backend, env, { mockCdnDir: emptyAssetsDir, force: true });
  record("缺件时应失败", false, "未抛错（不符合预期）");
} catch (error) {
  const message = String(error);
  record(
    "缺件时 fail-fast 且错误指向本地资源树",
    /本地远端资源树缺少该组件|local remote asset not found/.test(message),
    message.split("\n")[0]!.slice(0, 200),
  );
}

record(
  "负向用例同样无 CDN 出网",
  fetchAttempts.length === 0,
  fetchAttempts.length === 0 ? "0 次 fetch" : fetchAttempts.join(", "),
);

backend.dispose();

const failed = results.filter((item) => item.ok === false);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  for (const item of failed) {
    console.log(`- ${item.name}: ${item.detail}`);
  }
  if (deployError) {
    console.log("\n--- 部署错误详情 ---");
    console.log(String(deployError));
  }
  process.exit(1);
}
console.log("全部通过：本地随包资源可完整部署到远端，且全程未访问 CDN。");
