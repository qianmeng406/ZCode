// 远端小文件批量读取：一次远端往返替代逐文件 readFile。
// 规格见 packages/server/specs/remote-deploy-batch-checks.spec.md（第二批）。
// 批量只做加速：命令/解析异常时退化为逐个 readFile，null 仅表示单文件读失败。
// 协议：每路径一行 `Y:<base64>`（可读，空串表示空文件）或 `N`（缺失/不可读）；
// base64 工具不可用或读取失败输出 `T`，解析侧据此抛错触发逐个退化，不会误判为缺失。
// base64 直接编码文件字节（base64 < path），严格保留末尾换行等全部内容；
// 仅对编码字符串去除 base64 换行（默认 76 列折行）与 CR。
import type { IRemoteBackend } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";

/** 构造单次 POSIX shell 批量读取命令；异常内容不得进入日志，这里只输出状态行。 */
export function buildPosixReadFilesCommand(remotePaths: string[]): string {
  const segments = remotePaths.map((remotePath) => {
    const quoted = quotePosixShellArg(remotePath);
    return [
      "if [ -f " + quoted + " ]; then",
      "if encoded=$(base64 < " + quoted + " 2>/dev/null); then",
      `printf 'Y:'; printf %s "$encoded" | tr -d '\\r\\n'; printf '\\n'`,
      "else printf 'T\\n'; fi",
      "else printf 'N\\n'; fi",
    ].join("\n");
  });
  // Windows→WSL 会再次解释命令行引号；以 literal 脚本传输，避免含引号路径破坏批量命令。
  const octal = [...Buffer.from(segments.join("\n"), "utf8")]
    .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
  return `printf '%b' '${octal}' | sh`;
}

/** 解码 base64；必须为严格合法 base64，否则抛错。异常信息不携带内容原文。 */
function decodeBase64Strict(value: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("read-files base64 非法或截断");
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  // 严格校验：重编码必须与原文一致，防止非法字符被静默丢弃。
  if (Buffer.from(decoded, "utf8").toString("base64") !== value) {
    throw new Error("read-files base64 非法或截断");
  }
  return decoded;
}

/**
 * 解析批量读取输出；行数、状态前缀或 base64 非法即抛错，
 * 由调用方退化为逐个 readFile，不得改变答案。异常信息不携带文件内容。
 */
export function parsePosixReadFilesOutput(
  output: string,
  expectedCount: number,
): (string | null)[] {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.length > 0);
  if (lines.length !== expectedCount) {
    throw new Error(`read-files 输出行数不符: expected=${expectedCount} actual=${lines.length}`);
  }
  return lines.map((line) => {
    if (line === "N") {
      return null;
    }
    if (line.startsWith("Y:")) {
      return decodeBase64Strict(line.slice(2));
    }
    throw new Error(`read-files 输出状态非法: ${JSON.stringify(line.slice(0, 2))}`);
  });
}

/**
 * 批量读取远端小文件；结果与逐个 backend.readFile 同序，读取失败为 null。
 * backend 未实现 readFiles 时按原顺序串行 fallback，每个失败单独记为 null。
 * 批量返回长度或类型不符时明确拒绝，不静默少项。
 */
export async function remoteReadFiles(
  backend: IRemoteBackend,
  remotePaths: string[],
): Promise<(string | null)[]> {
  if (remotePaths.length === 0) {
    return [];
  }
  if (backend.readFiles) {
    let batched: (string | null)[];
    try {
      batched = await backend.readFiles(remotePaths);
    } catch {
      // 批量本身异常（命令/连接失败）时按原 readFile 逐项退化。
      // 必须直接调用原实例方法（保持 this、保留原型链上的 readFile），不能复制 backend。
      const results: (string | null)[] = [];
      for (const remotePath of remotePaths) {
        try {
          results.push(await backend.readFile(remotePath));
        } catch {
          results.push(null);
        }
      }
      return results;
    }
    if (!Array.isArray(batched) || batched.length !== remotePaths.length) {
      throw new Error(`readFiles 批量返回长度不符: expected=${remotePaths.length}`);
    }
    for (const item of batched) {
      if (item !== null && typeof item !== "string") {
        throw new Error("readFiles 批量返回非法项（应为字符串或 null）");
      }
    }
    return batched;
  }
  const results: (string | null)[] = [];
  for (const remotePath of remotePaths) {
    try {
      results.push(await backend.readFile(remotePath));
    } catch {
      results.push(null);
    }
  }
  return results;
}
