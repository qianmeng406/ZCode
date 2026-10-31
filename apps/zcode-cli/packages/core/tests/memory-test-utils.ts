import { createFileSystemError, type FileSystemPort } from "@zcode/contracts";

/**
 * 测试用文件系统按「路径形状」而不是「当前平台」匹配键。
 *
 * 产品代码一律用 node:path 解析路径，Windows 上 `/workspace/x` 会被解析成
 * `C:\workspace\x`；fixture 却按 POSIX 字面量写键。若这里按字面量匹配，整套
 * core 测试在 Windows 上会把「路径解析正确」误报成「文件不存在」（读不到、写不进去）。
 * 因此读写都先做与平台无关的规范化：统一分隔符并去掉盘符，两侧得到同一形状。
 */
const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:(?=[\\/])/;

function canonicalPath(path: string): string {
  return path.replace(/\\/g, "/").replace(DRIVE_PREFIX_PATTERN, "");
}

export class MemoryFileSystem implements FileSystemPort {
  readonly createdDirectories = new Set<string>();
  readonly readRequests: Array<{ maxBytes?: number; path: string }> = [];
  readonly searchFileRequests: Array<{ maxResults?: number; path: string; pattern: string }> = [];
  /** 原始键形状（保留测试写入时的写法）→ 内容。 */
  private readonly entries = new Map<string, { content: string; path: string }>();
  private readonly mtimes = new Map<string, number>();
  /** 对外仍是一个普通对象：按规范化路径读写，遍历时返回写入时的原始写法。 */
  readonly files: Record<string, string>;

  constructor(
    files: Record<string, string>,
    fileMtimes: Readonly<Record<string, number>> = {},
  ) {
    this.files = new Proxy({} as Record<string, string>, {
      get: (_target, property) =>
        typeof property === "string"
          ? this.entries.get(canonicalPath(property))?.content
          : undefined,
      set: (_target, property, value: string) => {
        if (typeof property !== "string") return false;
        this.entries.set(canonicalPath(property), { content: value, path: property });
        return true;
      },
      has: (_target, property) =>
        typeof property === "string" && this.entries.has(canonicalPath(property)),
      deleteProperty: (_target, property) => {
        if (typeof property !== "string") return false;
        return this.entries.delete(canonicalPath(property));
      },
      ownKeys: () => [...this.entries.values()].map((entry) => entry.path),
      getOwnPropertyDescriptor: (_target, property) => {
        if (typeof property !== "string") return undefined;
        const entry = this.entries.get(canonicalPath(property));
        if (!entry) return undefined;
        return { configurable: true, enumerable: true, value: entry.content, writable: true };
      },
    });
    for (const [path, content] of Object.entries(files)) this.files[path] = content;
    for (const [path, mtimeMs] of Object.entries(fileMtimes)) {
      this.mtimes.set(canonicalPath(path), mtimeMs);
    }
  }

  private contentOf(path: string): string | undefined {
    return this.entries.get(canonicalPath(path))?.content;
  }

  private mtimeOf(path: string): number | undefined {
    return this.mtimes.get(canonicalPath(path));
  }

  async createDirectory(request: { path: string }) {
    this.createdDirectories.add(request.path);
    return { path: request.path };
  }

  async stat(request: { path: string }) {
    if (this.createdDirectories.has(request.path)) {
      return { kind: "directory" as const, path: request.path, sizeBytes: 0 };
    }
    const content = this.contentOf(request.path);
    if (content === undefined) throw missingFile(request.path);
    return {
      kind: "file" as const,
      path: request.path,
      sizeBytes: Buffer.byteLength(content),
      mtimeMs: this.mtimeOf(request.path),
    };
  }

  async readTextFile(request: { path: string; encoding?: BufferEncoding; maxBytes?: number }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.contentOf(request.path);
    if (content === undefined) throw missingFile(request.path);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const maxBytes = request.maxBytes ?? sizeBytes;
    const truncated = sizeBytes > maxBytes;
    const returned = truncated ? content.slice(0, maxBytes) : content;
    return {
      bytesRead: Buffer.byteLength(returned, "utf8"),
      content: returned,
      encoding: request.encoding ?? "utf8",
      path: request.path,
      sizeBytes,
      truncated,
    };
  }

  async readBinaryFile(request: { path: string; maxBytes?: number }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.contentOf(request.path);
    if (content === undefined) throw missingFile(request.path);
    const buffer = Buffer.from(content, "utf8");
    if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: `File content (${buffer.byteLength}B) exceeds maximum allowed size (${request.maxBytes}B).`,
      });
    }
    return {
      bytesRead: buffer.byteLength,
      content: buffer,
      path: request.path,
      sizeBytes: buffer.byteLength,
    };
  }

  async readTextFileRange(request: {
    path: string;
    encoding?: BufferEncoding;
    offsetLine?: number;
    limitLines?: number;
    maxBytes?: number;
  }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.contentOf(request.path);
    if (content === undefined) throw missingFile(request.path);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (request.maxBytes !== undefined && sizeBytes > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: `File content (${sizeBytes}B) exceeds maximum allowed size (${request.maxBytes}B). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      });
    }
    const lines = content.length === 0 ? [] : content.split(/\r?\n/);
    const offsetLine = Math.max(0, Math.trunc(request.offsetLine ?? 0));
    const limitLines =
      request.limitLines === undefined ? undefined : Math.max(0, Math.trunc(request.limitLines));
    const selected =
      limitLines === undefined
        ? lines.slice(offsetLine)
        : lines.slice(offsetLine, offsetLine + limitLines);
    return {
      bytesRead: sizeBytes,
      content: selected.join("\n"),
      encoding: request.encoding ?? "utf8",
      lineCount: selected.length,
      path: request.path,
      sizeBytes,
      startLine: offsetLine + 1,
      totalLines: lines.length,
      truncated: false,
    };
  }

  async writeTextFile(request: { content: string; path: string }) {
    this.files[request.path] = request.content;
    return { bytesWritten: Buffer.byteLength(request.content, "utf8"), path: request.path };
  }

  async removeFile(request: { missingOk?: boolean; path: string }) {
    const existed = this.contentOf(request.path) !== undefined;
    if (!existed && request.missingOk !== true) throw missingFile(request.path);
    delete this.files[request.path];
    return { path: request.path, removed: existed };
  }

  async listDirectory(request: { path: string }) {
    const prefix = `${canonicalPath(request.path).replace(/\/+$/, "")}/`;
    const seen = new Set<string>();
    const entries = [...this.entries.keys()].flatMap((canonical) => {
      if (!canonical.startsWith(prefix)) return [];
      const rest = canonical.slice(prefix.length);
      const [name] = rest.split("/");
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const isDirectory = rest.includes("/");
      return [
        {
          kind: isDirectory ? ("directory" as const) : ("file" as const),
          name,
          path: `${prefix}${name}`,
        },
      ];
    });
    return {
      durationMs: 0,
      entries,
      numEntries: entries.length,
      path: request.path,
    };
  }

  async searchFiles(request: { maxResults?: number; path: string; pattern: string }) {
    this.searchFileRequests.push({
      maxResults: request.maxResults,
      path: request.path,
      pattern: request.pattern,
    });
    const prefix = `${canonicalPath(request.path).replace(/\/+$/, "")}/`;
    const files = [...this.entries.values()]
      .map((entry) => entry.path)
      .filter((path) => canonicalPath(path).startsWith(prefix))
      .filter((path) => !canonicalPath(path).slice(prefix.length).includes("/"))
      .filter((path) => (request.pattern === "*.md" ? path.endsWith(".md") : true))
      .slice(0, request.maxResults);
    return {
      durationMs: 0,
      files,
      numFiles: files.length,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }

  async searchText(request: {
    outputMode?: "content" | "files_with_matches" | "count";
    path: string;
    pattern: string;
  }) {
    return {
      durationMs: 0,
      entries: [],
      files: [],
      mode: request.outputMode ?? "files_with_matches",
      numMatches: 0,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }
}

function missingFile(path: string): Error {
  return createFileSystemError({ code: "not_found", message: `missing: ${path}`, path });
}
