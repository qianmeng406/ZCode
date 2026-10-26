import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

/**
 * Project Memory 目录名的唯一推导规则（node-only）。
 *
 * 为什么必须只有一份：CLI（core 的 project-memory）与本地 Host（services 的设置页读写）
 * 都要把「工作区」映射到同一个磁盘目录名 `<slug>-<hash>`。规则一旦分叉，已有记忆会静默失联——
 * 读不到、却会在旁边新建一份空目录。所以 core 的 resolveProjectMemoryRoot 与 services 的
 * memoryService 都调用这里。
 *
 * 放在 `@zcode/shared/node` 而不是根 barrel：它依赖 node:crypto / node:path，
 * 不能进 renderer 包。
 */
export interface ProjectMemoryKeyInput {
  workspacePath: string;
  /** 显式工作区身份（远端/受管工作区）优先作为 hash 来源，此时 slug 固定为 project。 */
  workspaceIdentity?: string;
  /** 与 node 的 process.platform 同值；win32 的路径大小写不敏感，先折叠。 */
  platform: string;
}

export function resolveProjectMemoryWorkspaceId(input: ProjectMemoryKeyInput): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  // resolve() 用宿主平台语义：Windows 上真实记忆目录名含反斜杠与盘符，
  // 这里必须与 CLI 计算时逐字节一致，不能自行归一成 POSIX 分隔符。
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource = workspaceIdentity
    ? workspaceIdentity
    : input.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath;
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = workspaceIdentity
    ? "project"
    : sanitizeProjectMemorySlug(basename(normalizedWorkspacePath) || "project");
  return `${slug}-${hash}`;
}

export function sanitizeProjectMemorySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
