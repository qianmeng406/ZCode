import { readdirSync } from "node:fs";
import { extname, join as joinPath, win32 } from "node:path";

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

export function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

export function windowsExecutableCandidates(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string[] {
  const pathExts = getWindowsPathExts(env);
  const fileCandidates = windowsExtensionCandidates(file, pathExts);

  if (hasWindowsPathSeparator(file) || win32.isAbsolute(file)) {
    const basePath =
      !win32.isAbsolute(file) && cwd ? win32.resolve(cwd, file) : win32.normalize(file);
    return windowsExtensionCandidates(basePath, pathExts);
  }

  const dirs = splitWindowsPath(getWindowsEnvValue(env, "PATH") ?? "");
  return dirs.flatMap((dir) => fileCandidates.map((candidate) => win32.join(dir, candidate)));
}

/**
 * Windows PATH 的目录列表：按 `;` 拆分，去掉首尾的双引号，跳过空条目。
 * 修复原因：条目可以写成 `"C:\Program Files\Git\cmd"`，Node 按裸名启动时会去掉引号；
 * 原来带着引号拼路径，这样的目录里的程序都找不到。
 */
export function splitWindowsPath(value: string): string[] {
  return value
    .split(win32.delimiter)
    .map((entry) => entry.replace(/^"/, "").replace(/"$/, ""))
    .filter((entry) => entry.length > 0);
}

function windowsExtensionCandidates(file: string, pathExts: string[]): string[] {
  if (extname(file)) return [file];
  // 顺序即优先级。裸名必须排在最后：npm 全局目录里除了 `foo.cmd` 还有一个
  // 无扩展名的 POSIX shell 脚本 `foo`（#!/bin/sh）。Windows 的 CreateProcess
  // 不能直接执行它，spawn 只会 ENOENT——裸名排第一时，PATH 上的 "foo" 就永远
  // 解析成那个跑不起来的文件（实测 codebuddy / claude / codex 全部命中）。
  // PATHEXT 里的 .exe/.cmd 才是真正可执行的落点。
  return [...pathExts.map((extension) => `${file}${extension.toLowerCase()}`), file];
}

function getWindowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvValue(env, "PATHEXT");
  const values = raw
    ?.split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return values && values.length > 0 ? values : DEFAULT_WINDOWS_PATHEXT;
}

function hasWindowsPathSeparator(value: string): boolean {
  return value.includes("\\") || value.includes("/");
}

/**
 * 已知桌面应用的 CLI 安装位置（PATH 之外的兜底）。
 *
 * 有些 AI coding CLI 不往 PATH 上装，只藏在桌面版自己的 resources 里（与
 * WorkBuddy 内置 codebuddy 同款模式）。按裸名 spawn 时 PATH 全部未命中，这里
 * 给出最后的落点，探测（`--version`）与委派因此共享同一份解析。
 *
 * pattern 语义：首段是环境变量名（取值缺失则整条跳过），`*` 段匹配该层目录下的
 * 任一子目录（多版本共存时取数值语义最大的——版本目录如 `1.0.6-26091603`）。
 */
const KNOWN_WINDOWS_INSTALL_LOCATIONS: ReadonlyArray<{
  name: string;
  pattern: readonly string[];
}> = [
  {
    // 阿里 Qoder CLI CN：QwenWork 桌面版内置，实测 1.1.32（2026-11-09）。
    name: "qoderclicn",
    pattern: ["LOCALAPPDATA", "Programs", "QwenWorkCN", "*", "resources", "bin", "qoderclicn.exe"],
  },
  {
    // Qoder CLI 国际版：独立安装器落在用户主目录，实测 1.1.86（2026-11-10）。
    // 同目录还有 qodercli-<version>.exe，稳定名 qodercli.exe 优先。
    name: "qodercli",
    pattern: ["USERPROFILE", ".qoder", "bin", "qodercli", "qodercli.exe"],
  },
];

/**
 * 从已知安装位置展开裸命令的候选绝对路径（PATH 候选之后追加）。
 *
 * 只处理表里登记的裸名；带路径分隔符/绝对路径的 file 一律返回空。`listDir` 可
 * 注入以便测试。展开失败（env 缺失、目录不存在）逐段静默跳过——兜底路径永远
 * 不该让正常 spawn 报错。
 */
export function windowsKnownInstallCandidates(
  file: string,
  env: NodeJS.ProcessEnv,
  listDir: (path: string) => readonly string[] = (path) => readdirSync(path),
): string[] {
  if (hasWindowsPathSeparator(file) || extname(file)) return [];
  const entry = KNOWN_WINDOWS_INSTALL_LOCATIONS.find((candidate) => candidate.name === file);
  if (!entry) return [];
  const [envKey, ...rest] = entry.pattern;
  const base = envKey ? getWindowsEnvValue(env, envKey) : undefined;
  if (!base || rest.length === 0) return [];
  const wildcardIndex = rest.indexOf("*");
  // 无通配段时最后一段是**文件名**，不能拿去当目录校验（否则整条候选被丢弃）。
  const beforeWildcard = wildcardIndex >= 0 ? rest.slice(0, wildcardIndex) : rest.slice(0, -1);
  const suffix = wildcardIndex >= 0 ? rest.slice(wildcardIndex + 1) : rest.slice(-1);
  // 前缀段逐一 join：任一段不是目录（env 根不存在等）就整条放弃。
  let prefix = base;
  for (const segment of beforeWildcard) {
    prefix = joinPath(prefix, segment);
    if (!isDirectory(prefix, listDir)) return [];
  }
  const joinTail = (directory: string): string => {
    let current = directory;
    for (const segment of suffix) current = joinPath(current, segment);
    return current;
  };
  if (wildcardIndex < 0) return [joinTail(prefix)];
  let children: readonly string[];
  try {
    children = listDir(prefix);
  } catch {
    return [];
  }
  // 只展开子目录（安装根下还有 Updater.exe 这类文件，locale 排序里字母 > 数字，
  // 不过滤会排到版本目录前面变成首候选）。
  const directories = children.filter((child) => isDirectory(joinPath(prefix, child), listDir));
  // 版本目录数值语义取最大（"1.0.10" > "1.0.9"；同前缀时后缀段大者优先）。
  const ordered = [...directories].sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );
  return ordered.map((child) => joinTail(joinPath(prefix, child)));
}

function isDirectory(path: string, listDir: (path: string) => readonly string[]): boolean {
  try {
    listDir(path);
    return true;
  } catch {
    return false;
  }
}
