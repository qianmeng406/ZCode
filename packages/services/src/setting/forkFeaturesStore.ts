import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FORK_FEATURE_KEYS,
  forkFeaturesSchema,
  formatLogPrefix,
  type ForkFeatures,
} from "@zcode/shared";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";

/**
 * fork 定制功能开关的独立落盘位置。
 *
 * 为什么不能继续放在 setting.json：正式版 ZCode 用的是自己的 AppSettings schema，
 * 启动后会把整份 setting.json 重写一遍，未知键被 strip 掉——于是每次开一次正式版，
 * fork 开关就全部回落到默认值（曾经真实发生过：13:14 与 13:15 两次写盘把
 * memoryFileEditing 等开关刷回 false）。把这份状态放到正式版根本不碰的文件里，
 * 读路径以文件为准、写路径不再往 setting.json 放副本，这条互相覆盖的链路就断了。
 */
export const FORK_FEATURES_FILE_NAME = "fork-features.json";

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("forkFeaturesStore", process.pid), ...args);

export interface ForkFeaturesFileRead {
  /** 文件是否存在于磁盘（即使内容损坏也算存在，避免每次读取都重复迁移）。 */
  readonly exists: boolean;
  /** 解析成功时的完整开关对象；文件缺失或损坏时为 undefined。 */
  readonly value?: ForkFeatures;
}

export function resolveForkFeaturesFilePath(settingsFile: string): string {
  return join(dirname(settingsFile), FORK_FEATURES_FILE_NAME);
}

/**
 * 从任意 JSON 值里取出开关对象。
 *
 * 只取已知键并丢弃未知键：更新版本的 fork 可能新增开关，旧版本读到不该把它判成坏文件。
 * 一个已知键都没有时返回 undefined（表示"用户从未写过开关"），迁移据此决定是否建文件。
 */
export function pickForkFeatures(value: unknown): ForkFeatures | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const picked: Record<string, boolean> = {};
  for (const key of FORK_FEATURE_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "boolean") picked[key] = candidate;
  }
  if (Object.keys(picked).length === 0) return undefined;
  return forkFeaturesSchema.parse(picked);
}

function buildCorruptBackupPath(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.corrupt-${timestamp}`;
}

async function quarantineCorruptFile(filePath: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptBackupPath(filePath);
  try {
    maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
    await rename(filePath, backupPath);
    log("invalid fork features json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 多个进程同时读到坏文件时，第一个已经完成隔离；这是预期结果，不刷错误日志。
      log("invalid fork features json already quarantined by another reader");
      return;
    }
    log("invalid fork features json backup failed. error:", renameError);
  }
}

/** 读取独立开关文件。任何失败都降级为 undefined，绝不让 `get()` 失败。 */
export async function readForkFeaturesFile(filePath: string): Promise<ForkFeaturesFileRead> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return { exists: false };
    }
    log("read failed, ignoring fork features file. error:", error);
    return { exists: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    await quarantineCorruptFile(filePath, error);
    return { exists: true };
  }

  const value = pickForkFeatures(parsed);
  if (!value) {
    // 空对象或结构不对：保留文件（可能是别的版本写的），按缺省处理。
    log("fork features file has no recognized keys, using defaults");
    return { exists: true };
  }
  return { exists: true, value };
}

export async function writeForkFeaturesFile(filePath: string, value: ForkFeatures): Promise<void> {
  const targetDir = dirname(filePath);
  maybeThrowInjectedFsFault({ operation: "mkdir", path: targetDir });
  await mkdir(targetDir, { recursive: true });
  maybeThrowInjectedFsFault({ operation: "writeFile", path: filePath });
  // 与 setting.json 同一套跨进程锁语义；Host 与 Electron Main 可能同时写。
  await withAtomicFileLock(filePath, () =>
    atomicWriteText(filePath, JSON.stringify(value, null, 2), { useFileLock: false }),
  );
}
