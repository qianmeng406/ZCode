// git 输出的纯解析（与进程调用分离，便于单测）。
//
// 两种输入：
// - `git status --porcelain=v1`：每行 `XY <path>`，重命名是 `XY old -> new`；
// - `git diff --numstat`：每行 `<added>\t<deleted>\t<path>`，二进制为 `-\t-`。

/** 取被改动/新增/删除的文件路径（重命名取新名，去重保序）。 */
export function parsePorcelainStatus(statusText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of statusText.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line.length < 4) continue;
    // 前两列是状态码，第三列是空格；路径从第 4 个字符开始。
    let path = line.slice(3);
    const renameIndex = path.lastIndexOf(" -> ");
    if (renameIndex >= 0) path = path.slice(renameIndex + 4);
    // git 对含特殊字符的路径会加引号；这里只去掉外层引号，不尝试还原转义。
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** 解析 numstat：path → { added, deleted }（二进制/无法统计的按 0 计）。 */
export function parseNumstat(numstatText: string): Map<string, { added: number; deleted: number }> {
  const result = new Map<string, { added: number; deleted: number }>();
  for (const rawLine of numstatText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, deletedRaw] = parts;
    let path = parts.slice(2).join("\t");
    // 重命名在 numstat 里是 `old => new` 或 `dir/{old => new}`，取新名兜底匹配不到时也无妨。
    const arrow = path.lastIndexOf(" => ");
    if (arrow >= 0) path = path.slice(arrow + 4).replace(/[{}]/gu, "");
    const added = Number.parseInt(addedRaw ?? "", 10);
    const deleted = Number.parseInt(deletedRaw ?? "", 10);
    result.set(path, {
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return result;
}
