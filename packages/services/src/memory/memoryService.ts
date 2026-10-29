import type { Memory, MemoryConfig } from "@zcode/shared";
import { resolveProjectMemoryWorkspaceId } from "@zcode/shared/node";
import {
  FORK_FEATURE_DISABLED_ERROR_CODE,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_INDEX_PROTECTED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
  type IMemoryService,
  type MemoryServiceOptions,
  type ProjectMemoryEditFeature,
  type ProjectMemoryFileSummary,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";
import { getZCodeDataRootDir } from "#src/paths.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;
const PROJECT_MEMORY_WRITE_MAX_BYTES = 5 * 1024 * 1024;
// Windows 保留设备名：写成文件后资源管理器/部分 API 无法打开，且可能被重定向到设备。
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// readProjectMemoryFileFromStableHandle 的 updatedAt 是 mtimeNs / 1e6，CAS 比对留 1ms 浮点余量。
const MTIME_COMPARISON_TOLERANCE_MS = 1;

function createMemoryFileError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${path}`);
  }
}

async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // 只校验 workspace 子目录时，projectsRoot symlink 会让 list/read 跟随到本地数据目录外。
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // 文件确实不存在时继续透传原始 ENOENT；只有大小写别名能命中时才拒绝读取。
    await lstat(requestedFilePath);
    throw new Error(`Project Memory file name does not match exactly: ${fileName}`);
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${targetPath}`);
  }
}

/** 新建文件还没有真实路径可 realpath，只能把父目录的解析结果与根目录比对。 */
async function assertContainedProjectMemoryDirectory(
  projectsRoot: string,
  directoryPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const directoryRealPath = await realpath(directoryPath);
  const relativePath = relative(projectsRootRealPath, directoryRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${directoryPath}`);
  }
}

function assertWritableProjectMemoryFileName(fileName: string): void {
  if (fileName !== fileName.trim() || /[<>:"|?*\u0000-\u001f]/.test(fileName)) {
    throw new Error(`Invalid Project Memory file name: ${fileName}`);
  }
  if (fileName.endsWith(".") || WINDOWS_RESERVED_NAME_PATTERN.test(fileName)) {
    throw new Error(`Project Memory file name is reserved: ${fileName}`);
  }
}

/**
 * 大小写不敏感文件系统上，`foo.md` 与磁盘上的 `Foo.md` 是同一个文件。
 * 精确校验只覆盖「已存在的同名文件」，新建路径必须自己挡住别名写入。
 */
async function assertNoCaseAliasCollision(memoryRoot: string, fileName: string): Promise<void> {
  const entries = await readdir(memoryRoot, { withFileTypes: true });
  const lowercaseName = fileName.toLocaleLowerCase();
  const alias = entries.find(
    (entry) => entry.name.toLocaleLowerCase() === lowercaseName && entry.name !== fileName,
  );
  if (alias) {
    throw new Error(
      `Project Memory file name ${fileName} collides with existing ${alias.name} (case alias)`,
    );
  }
}

function resolveMemoryUpdatedAt(mtimeNs: bigint): number {
  return Number(mtimeNs) / 1_000_000;
}

function assertExpectedUpdatedAt(
  fileName: string,
  actualUpdatedAt: number,
  expectedUpdatedAt: number | undefined,
): void {
  if (expectedUpdatedAt === undefined) return;
  if (Math.abs(actualUpdatedAt - expectedUpdatedAt) <= MTIME_COMPARISON_TOLERANCE_MS) return;
  throw createMemoryFileError(
    `Project Memory file changed on disk since it was read: ${fileName}`,
    PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  );
}

function lineLinksToProjectMemoryFile(line: string, fileName: string): boolean {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 兼容 `](name.md)`、`](<name.md>)` 与 `](sub/name.md)`；只认 markdown 链接，
  // 正文里提到的文件名不能成为删除理由。
  return new RegExp(`\\]\\(\\s*<?(?:[^)\\s]*[/\\\\])?${escaped}>?\\s*\\)`, "i").test(line);
}

/** 只摘掉指向被删文件的链接行，其余字节（含行尾、顺序、空行）原样保留。 */
export function removeProjectMemoryIndexLinks(
  indexContent: string,
  fileName: string,
): { content: string; removedLines: number } {
  const lines = indexContent.split("\n");
  const kept = lines.filter((line) => !lineLinksToProjectMemoryFile(line, fileName));
  return {
    content: kept.join("\n"),
    removedLines: lines.length - kept.length,
  };
}

function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserMemoryDir(): string {
  return join(resolveUserHomeDir(), ".claude", "memory");
}

/**
 * 获取 agent 对应的 memory 文件名
 */
function getMemoryFileName(_agentId: string): string {
  // 目前只支持 MEMORY.md，后续可以根据 agent 类型扩展
  return "MEMORY.md";
}

/**
 * 创建 Memory 服务实例
 */
export function createMemoryService(options: MemoryServiceOptions = {}): IMemoryService {
  async function isForkFeatureEnabled(feature: ProjectMemoryEditFeature): Promise<boolean> {
    const reader = options.isForkFeatureEnabled;
    return reader ? (await reader(feature)) === true : false;
  }

  async function assertMemoryFileEditingEnabled(): Promise<void> {
    if (!(await isForkFeatureEnabled("memoryFileEditing"))) {
      throw createMemoryFileError(
        "Project Memory file editing is disabled by settings",
        FORK_FEATURE_DISABLED_ERROR_CODE,
      );
    }
  }

  /**
   * 写入路径必须同时认「编辑」和「沉淀」两个开关。
   *
   * 一键沉淀走的就是 writeProjectMemoryFile：只开 memoryCapture 时如果这里只认
   * memoryFileEditing，用户会在确认对话框点保存后收到 FORK_FEATURE_DISABLED——
   * 两个功能各自独立可用，写入能力必须取并集。
   */
  async function assertMemoryFileWriteEnabled(): Promise<void> {
    const [editing, capture] = await Promise.all([
      isForkFeatureEnabled("memoryFileEditing"),
      isForkFeatureEnabled("memoryCapture"),
    ]);
    if (!editing && !capture) {
      throw createMemoryFileError(
        "Project Memory file writing is disabled by settings",
        FORK_FEATURE_DISABLED_ERROR_CODE,
      );
    }
  }
  async function loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();

      // 直接从用户级 ~/.claude/memory 目录读取
      const filePath = join(memoryDir, fileName);
      try {
        const content = await readFile(filePath, "utf-8");
        return {
          memory: {
            content: content || "",
            enabled: true,
          },
        };
      } catch {
        // 文件不存在，返回 null
        return { memory: null };
      }
    } catch (error) {
      console.error("Failed to load memory:", error);
      return { memory: null };
    }
  }

  async function saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void> {
    const { agentId, config } = params;

    try {
      // 直接保存到用户级 ~/.claude/memory 目录
      const memoryDir = getUserMemoryDir();
      await mkdir(memoryDir, { recursive: true });

      const fileName = getMemoryFileName(agentId);
      const filePath = join(memoryDir, fileName);
      await writeFile(filePath, config.content, "utf-8");
    } catch (error) {
      console.error("Failed to save memory:", error);
      throw error;
    }
  }

  async function clearMemory(params: { workspacePath: string; agentId: string }): Promise<void> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();
      const filePath = join(memoryDir, fileName);

      try {
        await writeFile(filePath, "", "utf-8");
      } catch {
        // 文件不存在，忽略错误
      }
    } catch (error) {
      console.error("Failed to clear memory:", error);
      throw error;
    }
  }

  async function getUserMemoryDirectory(): Promise<{ path: string }> {
    const memoryDir = getUserMemoryDir();
    try {
      await mkdir(memoryDir, { recursive: true });
    } catch {
      // 目录已存在
    }
    return { path: memoryDir };
  }

  async function listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    let projectsRoot: string;
    let projectEntries;
    try {
      projectsRoot = await requireProjectMemoriesRoot();
      projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const workspaces: ProjectMemoryWorkspaceSummary[] = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
        continue;
      }

      const workspaceId = projectEntry.name;
      const workspaceRoot = join(projectsRoot, workspaceId);
      const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
      if (!(await isPlainDirectory(workspaceRoot)) || !(await isPlainDirectory(memoryRoot))) {
        continue;
      }

      let memoryEntries;
      try {
        memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
      } catch (error) {
        // 目录检查后 Memory Agent 仍可能删除目录；catalog 快照只跳过已消失的 workspace。
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      const files: ProjectMemoryFileSummary[] = [];
      for (const memoryEntry of memoryEntries) {
        if (
          !memoryEntry.isFile() ||
          memoryEntry.isSymbolicLink() ||
          !isProjectMemoryFileName(memoryEntry.name)
        ) {
          continue;
        }

        const filePath = join(memoryRoot, memoryEntry.name);
        let fileMetadata;
        try {
          fileMetadata = await lstat(filePath);
        } catch (error) {
          // readdir 后事实文件可能被并发删除；它不再属于本次只读快照。
          if (isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
          continue;
        }
        files.push({
          name: memoryEntry.name,
          path: filePath,
          kind: memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME ? "index" : "item",
          size: fileMetadata.size,
          updatedAt: fileMetadata.mtimeMs,
        });
      }

      if (files.length === 0) {
        continue;
      }

      files.sort(compareProjectMemoryFiles);
      workspaces.push({
        id: workspaceId,
        label: resolveWorkspaceLabel(workspaceId),
        updatedAt: Math.max(...files.map((file) => file.updatedAt)),
        files,
      });
    }

    workspaces.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
    );
    return workspaces;
  }

  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // Bugfix：大小写不敏感文件系统会让请求名称命中不同大小写的磁盘文件，绕过 catalog 白名单。
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  /**
   * 写/删共用的目标解析：名字、容器、真实路径、大小写别名、CAS 前置条件都在这里一次性判定，
   * 之后的写入不再接受任何未校验的路径片段。
   */
  async function resolveWritableProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{
    projectsRoot: string;
    memoryRoot: string;
    filePath: string;
    existingUpdatedAt: number | undefined;
  }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }
    assertWritableProjectMemoryFileName(params.fileName);

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);
    await assertContainedProjectMemoryDirectory(projectsRoot, memoryRoot);

    const filePath = join(memoryRoot, params.fileName);
    let existingUpdatedAt: number | undefined;
    try {
      // 必须走精确名校验：大小写不敏感文件系统上 lstat("case.md") 会命中 "Case.md"，
      // 只按 lstat 判断存在性就会静默覆盖另一个文件。
      const exactPath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
      const metadata = await lstat(exactPath, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`Project Memory file is not a regular file: ${params.fileName}`);
      }
      existingUpdatedAt = resolveMemoryUpdatedAt(metadata.mtimeNs);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      await assertNoCaseAliasCollision(memoryRoot, params.fileName);
    }
    return { projectsRoot, memoryRoot, filePath, existingUpdatedAt };
  }

  async function resolveProjectMemoryWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ workspaceId: string }> {
    return {
      workspaceId: resolveProjectMemoryWorkspaceId({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        platform: process.platform,
      }),
    };
  }

  async function writeProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    content: string;
    expectedUpdatedAt?: number;
  }): Promise<{ updatedAt: number; size: number }> {
    await assertMemoryFileWriteEnabled();
    const size = Buffer.byteLength(params.content, "utf8");
    if (size > PROJECT_MEMORY_WRITE_MAX_BYTES) {
      throw createMemoryFileError(
        `Project Memory file exceeds the 5 MiB limit: ${params.fileName}`,
        PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
      );
    }

    const target = await resolveWritableProjectMemoryFile(params);
    assertExpectedUpdatedAt(
      params.fileName,
      target.existingUpdatedAt ?? Number.NaN,
      params.expectedUpdatedAt,
    );

    await atomicWriteText(target.filePath, params.content);
    const written = await lstat(target.filePath, { bigint: true });
    return { updatedAt: resolveMemoryUpdatedAt(written.mtimeNs), size };
  }

  async function deleteProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    expectedUpdatedAt?: number;
  }): Promise<{ indexUpdated: boolean }> {
    await assertMemoryFileEditingEnabled();
    if (params.fileName === PROJECT_MEMORY_INDEX_FILE_NAME) {
      throw createMemoryFileError(
        "The Project Memory index file cannot be deleted",
        PROJECT_MEMORY_INDEX_PROTECTED_ERROR_CODE,
      );
    }

    const target = await resolveWritableProjectMemoryFile(params);
    // 只删已存在的文件：删除不存在的条目说明 UI 状态过期，按 CAS 冲突处理。
    if (target.existingUpdatedAt === undefined) {
      throw createMemoryFileError(
        `Project Memory file does not exist: ${params.fileName}`,
        PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
      );
    }
    assertExpectedUpdatedAt(params.fileName, target.existingUpdatedAt, params.expectedUpdatedAt);
    await assertContainedProjectMemoryPath(target.projectsRoot, target.filePath);

    // 先摘索引再删文件：索引写失败时条目仍在，用户能看到并重试；反过来会留下死链接。
    const indexUpdated = await removeIndexLinksFor(target.memoryRoot, params.fileName);
    await unlink(target.filePath);
    return { indexUpdated };
  }

  async function removeIndexLinksFor(memoryRoot: string, fileName: string): Promise<boolean> {
    const indexPath = join(memoryRoot, PROJECT_MEMORY_INDEX_FILE_NAME);
    let indexContent: string;
    try {
      indexContent = await readFile(indexPath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
    const { content, removedLines } = removeProjectMemoryIndexLinks(indexContent, fileName);
    if (removedLines === 0) return false;
    await atomicWriteText(indexPath, content);
    return true;
  }

  return {
    loadMemory,
    saveMemory,
    clearMemory,
    getUserMemoryDirectory,
    listProjectMemories,
    readProjectMemoryFile,
    resolveProjectMemoryWorkspace,
    writeProjectMemoryFile,
    deleteProjectMemoryFile,
  };
}
