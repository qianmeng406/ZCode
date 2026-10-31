/**
 * 测试断言用的路径归一。
 *
 * 产品代码一律经 node:path 解析，Windows 上 `/tmp/ws` 会变成 `\tmp\ws`；而大量上游用例
 * 用 POSIX 字面量写 workspace/期望值。断言前把两侧统一成 POSIX 形状，语义不变，
 * 也不会掩盖「产物用了错误分隔符」之外的真实差异（大小写、盘符前缀仍会暴露）。
 */
export function toPosixPath(value: string): string {
  // 同时去掉盘符：Linux 上 `/work/x` 与 Windows 上 `C:\work\x` 描述的是同一个 fixture 路径。
  return value.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");
}

/** 断言对象里的指定字段：归一后比较，其余字段保持严格。 */
export function withPosixPath<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K,
): T {
  const field = value[key];
  return typeof field === "string" ? ({ ...value, [key]: toPosixPath(field) } as T) : value;
}
