import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";
/** 写入/删除被 fork 开关挡住；此时不会触碰文件系统。 */
export const FORK_FEATURE_DISABLED_ERROR_CODE = "FORK_FEATURE_DISABLED";
/** 索引文件（MEMORY.md）不允许删除：删掉它等于丢掉整个 workspace 的记忆目录结构。 */
export const PROJECT_MEMORY_INDEX_PROTECTED_ERROR_CODE = "PROJECT_MEMORY_INDEX_PROTECTED";

export type ProjectMemoryEditFeature = "memoryFileEditing";

export interface MemoryServiceOptions {
  /**
   * fork 开关读取器。缺省视为关闭（fail-closed）：没有注入时写入口一律拒绝，
   * 保证「未接线」不会意外获得写能力。
   */
  isForkFeatureEnabled?: (feature: ProjectMemoryEditFeature) => boolean | Promise<boolean>;
}

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /**
   * 加载指定 agent 的 memory 文件
   * @param workspacePath workspace 路径
   * @param agentId agent ID (如 'claude', 'gemini' 等)
   */
  loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }>;

  /**
   * 保存 memory 配置
   */
  saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void>;

  /**
   * 清除 memory 内容
   */
  clearMemory(params: { workspacePath: string; agentId: string }): Promise<void>;

  /**
   * 获取用户级 memory 目录路径，并确保目录存在
   */
  getUserMemoryDirectory(): Promise<{ path: string }>;

  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;

  /**
   * 覆盖写入一个 Project Memory 文件（新增或替换正文）。
   *
   * `expectedUpdatedAt` 是 CAS：与磁盘现值不一致时抛
   * `PROJECT_MEMORY_FILE_CHANGED`，避免覆盖 UI 打开后被 Memory Agent 改过的正文。
   */
  writeProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    content: string;
    expectedUpdatedAt?: number;
  }): Promise<{ updatedAt: number; size: number }>;

  /**
   * 删除一个 Project Memory 条目，并移除索引里指向它的链接行。
   * 索引文件本身受保护（`PROJECT_MEMORY_INDEX_PROTECTED`）。
   */
  deleteProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    expectedUpdatedAt?: number;
  }): Promise<{ indexUpdated: boolean }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
