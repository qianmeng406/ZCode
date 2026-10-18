// ============================================================
// WSL FileSystem Adapter（session-linux-execution）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md「路径及能力」：
// "Bash/FileSystemPort 读取同一文件并维持 stale-write/revision 语义"。
//
// 会话执行环境切到 WSL 后，模型产出的文件工具路径是 Linux 会话视角的 POSIX
// 绝对路径（如 /home/user/proj/file）。控制端（Windows）的本地
// NodeFileSystemAdapter 会把这种路径 resolve 到 Windows 盘的 C:\home\...，
// 与 WSL bash 执行的同一路径不是同一文件——这正是"File Write → Linux Bash
// Read"一致性验收的失败点。
//
// 本适配器在 Windows 控制端把 POSIX 绝对路径映射到 WSL 发行版的 UNC 路径
// （\\wsl.localhost\<distro>\...），文件语义（revision/stale-write/原子写/
// 行尾规范化）全部委托内部 NodeFileSystemAdapter 在 UNC 上执行——UNC 就是
// WSL ext4 的同一文件。挂载盘路径（/mnt/<盘符>/...）不走 UNC（9p-over-drvfs 在
// Windows 侧 EPERM），回映射为 Windows 盘符路径交本地适配器（与 /mnt/c 是同一文件）。
// 非 POSIX（Windows 盘符/UNC）路径原样委托本地适配器，保证 Windows 侧真源行为不变。

import { isAbsolute, posix } from "node:path";
import {
  createFileSystemError,
  type FileSystemPort,
  type FileSystemCreateDirectoryRequest,
  type FileSystemCreateDirectoryResult,
  type FileSystemListDirectoryRequest,
  type FileSystemListDirectoryResult,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextResult,
  type FileSystemRemoveFileRequest,
  type FileSystemRemoveFileResult,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
  type FileSystemSearchTextRequest,
  type FileSystemSearchTextResult,
  type FileSystemStatRequest,
  type FileSystemStatResult,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
} from "@zcode/contracts";
import { createNodeFileSystemAdapter } from "./index.js";

/**
 * POSIX 绝对路径判定：在 win32 宿主上以 "/" 或 "\" 开头、不带盘符、
 * 也不是已有 UNC（\\server\share）的路径，视为 Linux 会话视角的绝对路径。
 * 注意 win32 path.isAbsolute("/home/x") 为 true，且工具层 path-policy 已把
 * "/home/x/y" 规范化成 "\home\x\y"，因此两种分隔符都要识别。
 */
export function isPosixAbsoluteGuestPath(path: string): boolean {
  if (path.length === 0) return false;
  if (isAbsolute(path)) {
    // win32: 盘符与 UNC 都是 isAbsolute；这两类是控制端真源路径，不是 guest 路径。
    if (/^[A-Za-z]:/.test(path)) return false;
    if (path.startsWith("\\\\") || path.startsWith("//")) return false;
    return true;
  }
  return false;
}

/** POSIX 绝对路径 → WSL 发行版 UNC 路径。保留 posix 规范化语义，分隔符统一反斜杠。 */
export function toWslUncPath(posixAbsolutePath: string, distro: string): string {
  const normalized = posix.normalize(posixAbsolutePath.replaceAll("\\", "/"));
  const segments = normalized.split("/").filter(Boolean);
  const suffix = segments.length > 0 ? `\\${segments.join("\\")}` : "";
  return `\\\\wsl.localhost\\${distro}${suffix}`;
}

/**
 * POSIX /mnt/<盘符>/… → Windows <盘符>:\…（drvfs 挂载盘回映射到 Windows 真源）。
 *
 * 事实（真实环境实测，见 lab provenance）：`\\wsl.localhost\<distro>\mnt\c\...` 是
 * 9p-over-drvfs，Windows 侧一律 EPERM——挂载盘不能走 UNC。而 /mnt/c/x 与 C:\x 本来就是
 * 同一份文件（spec「Windows 项目目录为唯一文件真源」「/mnt/c → C:\ 真源行为不变」），
 * 所以挂载盘路径必须回映射为 Windows 路径、交本地适配器，既正确又比 UNC 快。
 * 非 /mnt 的 POSIX 路径（如 /home/…，真实 ext4）仍走 UNC。
 */
export function toWindowsDrivePath(posixAbsolutePath: string): string | undefined {
  const normalized = posix.normalize(posixAbsolutePath.replaceAll("\\", "/"));
  const matched = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(normalized);
  if (!matched) return undefined;
  const drive = matched[1].toUpperCase();
  const rest = matched[2] ?? "";
  const segments = rest.split("/").filter(Boolean);
  return segments.length > 0 ? `${drive}:\\${segments.join("\\")}` : `${drive}:\\`;
}

export interface WslFileSystemAdapterOptions {
  /** 会话批准的 WSL 发行版名（session execution environment 的 distro）。 */
  distro: string;
  /** 挂载 guest 路径的底层适配器；缺省新建 NodeFileSystemAdapter。 */
  delegate?: FileSystemPort;
}

export class WslFileSystemAdapter implements FileSystemPort {
  private readonly delegate: FileSystemPort;

  constructor(private readonly options: WslFileSystemAdapterOptions) {
    if (!options.distro.trim()) {
      throw new Error("WslFileSystemAdapter requires a non-empty distro name");
    }
    this.delegate = options.delegate ?? createNodeFileSystemAdapter();
  }

  private toGuestPath(path: string): string {
    if (!isPosixAbsoluteGuestPath(path)) return path;
    // 挂载盘（/mnt/c/...）：回映射到 Windows 真源路径，本地适配器读写同一份文件。
    const windowsPath = toWindowsDrivePath(path);
    if (windowsPath) return windowsPath;
    return toWslUncPath(path, this.options.distro);
  }

  /** guest 路径请求统一改写后委托；结果 path 回写成调用方原始形态。 */
  private async delegateCall<T extends { path: string }>(
    originalPath: string,
    operation: (mappedPath: string) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation(this.toGuestPath(originalPath));
      if (result.path !== originalPath && typeof result.path === "string") {
        // UNC 上的 stat/realpath 可能改写大小写；回写调用方请求形态，
        // core 的 readFileState / 展示层以请求路径为键。
        return { ...result, path: originalPath };
      }
      return result;
    } catch (error) {
      // 底层错误携带的是映射后路径；诊断要指回调用方请求的 guest 路径。
      if (error instanceof Error && error.name === "FileSystemPortError") {
        const portError = error as Error & { path?: string; code?: string };
        if (portError.path !== undefined && portError.path !== originalPath) {
          const rewritten = createFileSystemError({
            code: (portError.code ?? "io_error") as never,
            path: originalPath,
            message: portError.message.replace(portError.path, originalPath),
            cause: error,
          });
          throw rewritten;
        }
      }
      throw error;
    }
  }

  createDirectory(
    request: FileSystemCreateDirectoryRequest,
  ): Promise<FileSystemCreateDirectoryResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.createDirectory({ ...request, path }),
    );
  }

  stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
    return this.delegateCall(request.path, (path) => this.delegate.stat({ ...request, path }));
  }

  readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.readTextFile({ ...request, path }),
    );
  }

  readBinaryFile(request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.readBinaryFile({ ...request, path }),
    );
  }

  readTextFileRange(
    request: FileSystemReadTextRangeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemReadTextRangeResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.readTextFileRange({ ...request, path }, options),
    );
  }

  writeTextFile(request: FileSystemWriteTextRequest): Promise<FileSystemWriteTextResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.writeTextFile({ ...request, path }),
    );
  }

  removeFile(
    request: FileSystemRemoveFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemRemoveFileResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.removeFile({ ...request, path }, options),
    );
  }

  listDirectory(
    request: FileSystemListDirectoryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemListDirectoryResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.listDirectory({ ...request, path }, options),
    );
  }

  searchFiles(
    request: FileSystemSearchFilesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchFilesResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.searchFiles({ ...request, path }, options),
    );
  }

  searchText(
    request: FileSystemSearchTextRequest,
    options?: { signal?: AbortSignal },
  ): Promise<FileSystemSearchTextResult> {
    return this.delegateCall(request.path, (path) =>
      this.delegate.searchText({ ...request, path }, options),
    );
  }
}

export function createWslFileSystemAdapter(
  options: WslFileSystemAdapterOptions,
): WslFileSystemAdapter {
  return new WslFileSystemAdapter(options);
}
