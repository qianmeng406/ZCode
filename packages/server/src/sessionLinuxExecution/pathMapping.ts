/**
 * 会话级本机 Linux 执行 — 路径映射与同文件验证。
 *
 * 规格见 docs/research/session-linux-execution.spec.md「路径及能力」：
 * - Linux 端只做 wslpath -u → realpath → wslpath -w roundtrip，一次 prepare 内完成，不是每命令。
 * - 同文件证据来自 roundtrip：Host 侧用 fs.realpath + win32 case folding 严格比较；
 *   Linux 端不做 Windows UNC 读取（Linux 无法 access UNC）。
 * - 不可映射/越界一律拒绝。
 */
import { posix } from "node:path";

export interface LinuxPathMapperDeps {
  /**
   * 在 Linux 端执行一条命令并返回 stdout。prepare 期间通过持久 stdio
   * server 的执行能力调用一次，不是每命令新建 wsl.exe。
   */
  execLinux: (command: string, args: string[]) => Promise<string>;
  existsDirLinux?: (linuxPath: string) => Promise<boolean>;
}

export interface MappedWorkspacePaths {
  /** 输入的 Windows 项目根。 */
  originalWindowsPath: string;
  /** Linux 端 realpath 后的项目根。 */
  linuxPath: string;
  /** wslpath -w roundtrip 回来的 Windows 形式路径。 */
  mappedWindowsPath: string;
}

export type PathMappingErrorCode = "path_unmappable" | "path_not_found" | "path_not_directory";

export class PathMappingError extends Error {
  readonly code: PathMappingErrorCode;
  constructor(code: PathMappingErrorCode, message: string) {
    super(message);
    this.name = "PathMappingError";
    this.code = code;
  }
}

function trimStdout(value: string): string {
  return value.replace(/\r/g, "").replace(/\n+$/, "").trim();
}

/** 两个 Windows 路径的规范化比较：realpath 后做 win32 大小写折叠比较（Host 侧调用）。 */
export function windowsPathsEquivalent(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const normalized = value.replaceAll("/", "\\").replace(/\\+$/, "");
    // 路径分段大小写折叠；逐段折叠以保留 win32 语义（全部小写比较即可，win32 不区分大小写）。
    return normalized.toLowerCase();
  };
  return normalize(a) === normalize(b);
}

/** Linux 端 cwd 越界检查：resolved cwd 必须位于授权工作区 linuxPath 内。 */
export function isLinuxCwdWithinWorkspace(cwd: string, workspaceLinuxPath: string): boolean {
  const normalize = (value: string): string => {
    const withTrailingSlash = posix.normalize(value);
    return withTrailingSlash.length > 1 ? withTrailingSlash.replace(/\/+$/, "") : withTrailingSlash;
  };
  const base = normalize(workspaceLinuxPath);
  const target = normalize(cwd);
  if (target === base) {
    return true;
  }
  return target.startsWith(base.endsWith("/") ? base : `${base}/`);
}

/**
 * Linux 端 prepare 期间的一次性映射：wslpath -u → realpath → wslpath -w。
 * 通过 deps.existsDirLinux（Linux stat）验证存在且为目录。
 */
export async function mapWorkspacePaths(
  deps: LinuxPathMapperDeps,
  windowsPath: string,
): Promise<MappedWorkspacePaths> {
  let candidateLinuxPath: string;
  try {
    candidateLinuxPath = trimStdout(await deps.execLinux("wslpath", ["-u", windowsPath]));
  } catch (error) {
    throw new PathMappingError(
      "path_unmappable",
      `wslpath -u failed for ${windowsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!candidateLinuxPath) {
    throw new PathMappingError("path_unmappable", `wslpath -u returned empty for ${windowsPath}`);
  }

  let resolvedLinuxPath: string;
  try {
    resolvedLinuxPath = trimStdout(await deps.execLinux("realpath", [candidateLinuxPath]));
  } catch (error) {
    throw new PathMappingError(
      "path_not_found",
      `realpath failed for ${candidateLinuxPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const existsDir = deps.existsDirLinux ?? (async () => true);
  if (!(await existsDirLinuxChecked(existsDir, resolvedLinuxPath))) {
    throw new PathMappingError(
      "path_not_directory",
      `resolved path is not an existing directory: ${resolvedLinuxPath}`,
    );
  }

  let mappedWindowsPath: string;
  try {
    mappedWindowsPath = trimStdout(await deps.execLinux("wslpath", ["-w", resolvedLinuxPath]));
  } catch (error) {
    throw new PathMappingError(
      "path_unmappable",
      `wslpath -w failed for ${resolvedLinuxPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!mappedWindowsPath) {
    throw new PathMappingError(
      "path_unmappable",
      `wslpath -w returned empty for ${resolvedLinuxPath}`,
    );
  }

  return {
    originalWindowsPath: windowsPath,
    linuxPath: resolvedLinuxPath,
    mappedWindowsPath,
  };
}

async function existsDirLinuxChecked(
  existsDir: NonNullable<LinuxPathMapperDeps["existsDirLinux"]>,
  linuxPath: string,
): Promise<boolean> {
  try {
    return await existsDir(linuxPath);
  } catch {
    return false;
  }
}

/**
 * Host Windows 侧同文件校验：realpath 双方 + 大小写折叠比较 + 存在性。
 * 不比较跨文件系统 dev/ino（Windows NTFS 与 WSL UNC provider 的编号不可比）。
 */
export async function verifySameFileOnWindows(
  deps: {
    realpathNative: (path: string) => Promise<string>;
    statIsDirectory: (path: string) => Promise<boolean>;
  },
  original: string,
  mapped: string,
): Promise<boolean> {
  try {
    const [originalReal, mappedReal] = await Promise.all([
      deps.realpathNative(original),
      deps.realpathNative(mapped),
    ]);
    if (!windowsPathsEquivalent(originalReal, mappedReal)) {
      return false;
    }
    return await deps.statIsDirectory(mapped);
  } catch {
    return false;
  }
}
