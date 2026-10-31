/**
 * 审查队列的逐条已读状态：只存在本机浏览器存储里，不进协议、不跟随到其他设备。
 *
 * 记录级 `acknowledgedAt` 语义是"这张审查卡片用户已确认"，粒度太粗；队列需要的是
 * "这条发现我看过了"。因此用 `reviewId + fingerprint` 做键，存一份有界集合。
 */

const REVIEWED_STORAGE_PREFIX = "zcode:oracle-review-queue:reviewed:v1";
const REVIEWED_MAX_KEYS = 500;
const SCHEMA_VERSION = 1;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // 隐私模式 / 禁用存储：静默退化为不持久化。
    return null;
  }
}

export function reviewedQueueStorageKey(workspaceKey: string, sessionId: string): string {
  return `${REVIEWED_STORAGE_PREFIX}:${workspaceKey}:${sessionId}`;
}

export function readReviewedQueueKeys(
  workspaceKey: string,
  sessionId: string,
  storage: StorageLike | null = defaultStorage(),
): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(reviewedQueueStorageKey(workspaceKey, sessionId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const record = parsed as { schemaVersion?: unknown; keys?: unknown };
    if (record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.keys)) return new Set();
    return new Set(
      record.keys.filter((key): key is string => typeof key === "string" && key.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function writeReviewedQueueKeys(
  workspaceKey: string,
  sessionId: string,
  keys: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    // 有界保留：只留最近写入的条目，避免长期会话无限增长。
    const bounded = [...keys].slice(-REVIEWED_MAX_KEYS);
    storage.setItem(
      reviewedQueueStorageKey(workspaceKey, sessionId),
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, keys: bounded }),
    );
  } catch {
    // 配额/权限失败不影响队列本身。
  }
}

export function addReviewedQueueKeys(
  workspaceKey: string,
  sessionId: string,
  keys: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): Set<string> {
  const current = readReviewedQueueKeys(workspaceKey, sessionId, storage);
  let changed = false;
  for (const key of keys) {
    if (!current.has(key)) {
      current.add(key);
      changed = true;
    }
  }
  if (changed) writeReviewedQueueKeys(workspaceKey, sessionId, current, storage);
  return current;
}

export function clearReviewedQueueKeys(
  workspaceKey: string,
  sessionId: string,
  storage: StorageLike | null = defaultStorage(),
): Set<string> {
  const empty = new Set<string>();
  writeReviewedQueueKeys(workspaceKey, sessionId, empty, storage);
  return empty;
}
