#!/usr/bin/env node
/**
 * pre-push 门禁缓存：同一「推送范围 + 工具链环境」已经完整通过时跳过重复门禁。
 *
 * 背景：`.husky/pre-push` 每次都跑 `verify:pre-push`（scripts/git-gate/run-pre-push.mjs：
 * 文件策略 + 改动文件 lint/fmt + architecture:check + 强相关单测）。即便只跑强相关集，
 * 在 Windows 挂载盘上仍要数分钟；重试、补文档提交这类场景不该把同一批提交反复从头跑。
 *
 * 边界（有意保守）：
 * - 只缓存**完整通过**的结果；失败一律不写、并清掉同键旧记录。
 * - 键 = 推送范围（远端 sha..本地 sha）+ scope + node/pnpm 版本 + 平台 + 缓存格式版本。
 * - 工作区有未提交的 tracked 改动时不使用缓存（affected 单测读的是工作区内容）。
 * - 无法从 stdin 确定推送范围时不使用缓存（例如手工执行 hook）。
 * - 只写在 `.git/` 下的本地目录，不入库、不共享。
 * - `ZCODE_PREPUSH_NO_CACHE=1` 强制重跑；删除记录同样会重跑。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 缓存语义变更时递增，避免旧记录被误用。 */
export const CACHE_FORMAT_VERSION = 2;

const GATE_ARGS = ["run", "verify:pre-push"];

/**
 * 解析 git 传给 pre-push 的 stdin。
 * 每行形如：`<local ref> <local sha> <remote ref> <remote sha>`；新分支的 remote sha 全零。
 */
export function parsePrePushInput(stdin) {
  const lines = String(stdin ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parts = line.split(/\s+/u);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    if (!/^[0-9a-f]{40}$/u.test(localSha)) continue;
    if (!/^[0-9a-f]{40}$/u.test(remoteSha)) continue;
    entries.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      // 新分支的 remote sha 为全零串，直接作为 base 参与键计算：没有可比较的
      // 历史范围，但键本身仍然稳定，同一次新分支推送可以命中。
      baseSha: remoteSha,
    });
  }
  return entries;
}

/** 推送范围、门禁范围与工具链环境的稳定指纹。 */
export function computeCacheKey({
  baseSha,
  headSha,
  nodeVersion,
  pnpmVersion,
  platform,
  scope = "strong",
  cacheFormatVersion = CACHE_FORMAT_VERSION,
}) {
  const material = [
    `v${cacheFormatVersion}`,
    `base=${baseSha}`,
    `head=${headSha}`,
    `scope=${scope}`,
    `node=${nodeVersion}`,
    `pnpm=${pnpmVersion}`,
    `platform=${platform}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

export function cacheRecordPath(cacheDir, key) {
  return join(cacheDir, `${key}.json`);
}

export function readPassRecord(cacheDir, key) {
  const path = cacheRecordPath(cacheDir, key);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record || record.cacheFormatVersion !== CACHE_FORMAT_VERSION) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export function writePassRecord(cacheDir, key, record) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheRecordPath(cacheDir, key), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function removeRecord(cacheDir, key) {
  rmSync(cacheRecordPath(cacheDir, key), { force: true });
}

/**
 * 是否可以使用缓存。返回 { action: "hit" | "run", reason }。
 * 任何不确定的情况都返回 run（宁可贵，不可漏测）。
 */
export function decideGateOutcome({ entries, record, worktreeClean, disabled }) {
  if (disabled) return { action: "run", reason: "ZCODE_PREPUSH_NO_CACHE=1 强制重跑" };
  if (entries.length === 0) return { action: "run", reason: "无法从 stdin 确定推送范围" };
  if (!worktreeClean)
    return { action: "run", reason: "工作区有未提交改动，affected 单测读的是工作区" };
  if (!record) return { action: "run", reason: "该推送范围没有通过记录" };
  return { action: "hit", reason: "同一推送范围与工具链环境已完整通过" };
}

function packageManagerArgv(env) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && /[\\/]pnpm[\\/]/iu.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...GATE_ARGS], shell: false };
  }
  if (process.platform === "win32") {
    // Windows 下 pnpm 是 .cmd，必须交给 shell 解析；这里用整条命令串而不是
    // (命令 + args + shell:true)，后者会触发 Node 的 DEP0190 弃用告警。
    return { command: `pnpm ${GATE_ARGS.join(" ")}`, args: [], shell: true };
  }
  return { command: "pnpm", args: GATE_ARGS, shell: false };
}

function defaultGitStatusPorcelain({ cwd }) {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

function defaultSpawnGate({ env }) {
  const { command, args, shell } = packageManagerArgv(env);
  const result = spawnSync(command, args, { env, stdio: "inherit", shell });
  return result.status ?? 1;
}

/**
 * 执行门禁（带缓存）。所有外部依赖都可注入，便于测试。
 * 返回进程退出码。
 */
export async function runPrePushGate({
  env = process.env,
  now = () => new Date(),
  spawnGate = defaultSpawnGate,
  gitStatusPorcelain = defaultGitStatusPorcelain,
  cwd = process.cwd(),
} = {}) {
  const cacheDir = env.ZCODE_PREPUSH_CACHE_DIR || join(cwd, ".git", "zcode-prepush-cache");
  const entries = parsePrePushInput(env.ZCODE_PRE_PUSH_STDIN ?? "");
  const disabled = env.ZCODE_PREPUSH_NO_CACHE === "1";
  const scope = env.ZCODE_GATE_SCOPE?.trim() || "strong";

  const head = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const key = head
    ? computeCacheKey({
        baseSha: head.baseSha,
        headSha: head.localSha,
        nodeVersion: process.version,
        pnpmVersion: env.npm_config_user_agent ?? "unknown",
        platform: process.platform,
        scope,
      })
    : undefined;

  const porcelain = disabled ? null : gitStatusPorcelain({ cwd });
  const decision = decideGateOutcome({
    entries,
    record: key ? readPassRecord(cacheDir, key) : undefined,
    worktreeClean: porcelain !== null && porcelain.trim() === "",
    disabled,
  });

  if (decision.action === "hit") {
    const record = readPassRecord(cacheDir, key);
    console.log(
      `[pre-push] 门禁缓存命中：${head.baseSha.slice(0, 8)}..${head.localSha.slice(0, 8)}` +
        `（${record.finishedAt}，node ${record.nodeVersion}）→ 跳过 lint/architecture/测试。`,
    );
    console.log(
      "[pre-push] 强制重跑：ZCODE_PREPUSH_NO_CACHE=1 git push（或删除 .git/zcode-prepush-cache）",
    );
    return 0;
  }

  console.log(`[pre-push] 运行完整门禁（${decision.reason}）。`);
  const status = spawnGate({ env, cwd });
  if (status === 0 && key) {
    writePassRecord(cacheDir, key, {
      cacheFormatVersion: CACHE_FORMAT_VERSION,
      baseSha: head.baseSha,
      headSha: head.localSha,
      scope,
      nodeVersion: process.version,
      pnpmVersion: env.npm_config_user_agent ?? "unknown",
      platform: process.platform,
      finishedAt: now().toISOString(),
    });
    console.log("[pre-push] 门禁通过，已记录该推送范围（后续同一范围可跳过重复门禁）。");
  } else if (key) {
    // 失败绝不缓存；并清掉同键旧记录，避免历史通过记录掩盖当前失败。
    removeRecord(cacheDir, key);
  }
  return status;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runPrePushGate()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("[pre-push] 门禁缓存包装失败，按未通过处理：", error);
      process.exitCode = 1;
    });
}
