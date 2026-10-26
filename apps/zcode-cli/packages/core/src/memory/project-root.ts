import { join } from "node:path";
import { resolveProjectMemoryWorkspaceId } from "@zcode/shared/node";

interface ProjectMemoryRootInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

export function resolveProjectMemoryRoot(input: ProjectMemoryRootInput): string {
  // 目录名规则住在 @zcode/shared/node：设置页（本地 Host）也要算同一个 id，
  // 两份实现分叉会让已有记忆静默失联。
  const workspaceId = resolveProjectMemoryWorkspaceId({
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    platform: process.platform,
  });
  return join(input.cliStorageRoot, "memories", "projects", workspaceId, "memory");
}
