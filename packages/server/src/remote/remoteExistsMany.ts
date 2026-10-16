// 远端文件存在性批量探测：一次远端往返替代逐文件 exists。
// 规格见 packages/server/specs/remote-deploy-batch-checks.spec.md。
// 批量只做加速：输出异常时调用方退化为逐个 exists，不得改变答案。
import type { IRemoteBackend } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";

/** 构造单次 POSIX shell 批量探测命令：每条路径输出一行 Y/N。 */
export function buildPosixExistsManyCommand(remotePaths: string[]): string {
  return remotePaths
    .map(
      (remotePath) =>
        `if [ -f ${quotePosixShellArg(remotePath)} ]; then printf 'Y\\n'; else printf 'N\\n'; fi`,
    )
    .join("\n");
}

/** 解析批量探测输出；行数或取值非法即抛错，由调用方退化为串行。 */
export function parsePosixExistsManyOutput(output: string, expectedCount: number): boolean[] {
  const flags = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (flags.length !== expectedCount) {
    throw new Error(`exists-many 输出行数不符: expected=${expectedCount} actual=${flags.length}`);
  }
  return flags.map((flag) => {
    if (flag === "Y") return true;
    if (flag === "N") return false;
    throw new Error(`exists-many 输出非法: ${JSON.stringify(flag)}`);
  });
}

/**
 * 批量检查远端文件存在性；结果与逐个 backend.exists 同序同义。
 * backend 未实现 existsMany 时按原顺序串行 fallback。
 */
export async function remoteExistsMany(
  backend: IRemoteBackend,
  remotePaths: string[],
): Promise<boolean[]> {
  if (remotePaths.length === 0) {
    return [];
  }
  if (backend.existsMany) {
    return backend.existsMany(remotePaths);
  }
  const results: boolean[] = [];
  for (const remotePath of remotePaths) {
    results.push(await backend.exists(remotePath));
  }
  return results;
}
