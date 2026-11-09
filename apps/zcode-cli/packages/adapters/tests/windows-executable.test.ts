import { describe, expect, it } from "vitest";
import {
  windowsExecutableCandidates,
  windowsKnownInstallCandidates,
} from "../src/exec/windows-executable.js";

/** 用目录表模拟 readdir：key = 目录绝对路径，value = 子项名列表。 */
function fakeListDir(directories: Record<string, readonly string[]>) {
  return (path: string): readonly string[] => {
    const entries = directories[path];
    if (!entries) throw new Error(`ENOENT: ${path}`);
    return entries;
  };
}

describe("windowsKnownInstallCandidates", () => {
  const env = { LOCALAPPDATA: "C:\\u\\AppData\\Local" } as unknown as NodeJS.ProcessEnv;
  const scanDir = "C:\\u\\AppData\\Local\\Programs\\QwenWorkCN";
  // 版本目录本身也要在目录表里（通配段展开时逐个 isDirectory 校验）。
  const listDir = fakeListDir({
    "C:\\u\\AppData\\Local\\Programs": ["QwenWorkCN", "Other"],
    [scanDir]: ["0.1.8-26081406", "1.0.6-26091603", "1.0.10-26100101"],
    [`${scanDir}\\0.1.8-26081406`]: [],
    [`${scanDir}\\1.0.6-26091603`]: [],
    [`${scanDir}\\1.0.10-26100101`]: [],
  });

  it("未知命令 / 带路径或扩展名 → 不参与（PATH 候选已覆盖）", () => {
    expect(windowsKnownInstallCandidates("codebuddy", env, listDir)).toEqual([]);
    expect(windowsKnownInstallCandidates("dir\\qoderclicn", env, listDir)).toEqual([]);
    expect(windowsKnownInstallCandidates("qoderclicn.exe", env, listDir)).toEqual([]);
  });

  it("env 根缺失 → 静默返回空，不影响正常 spawn", () => {
    expect(windowsKnownInstallCandidates("qoderclicn", {}, listDir)).toEqual([]);
  });

  it("前缀目录不存在 → 返回空", () => {
    const missing = fakeListDir({});
    expect(windowsKnownInstallCandidates("qoderclicn", env, missing)).toEqual([]);
  });

  it("多版本目录按数值语义取最大优先（1.0.10 > 1.0.6 > 0.1.8）", () => {
    expect(windowsKnownInstallCandidates("qoderclicn", env, listDir)).toEqual([
      `${scanDir}\\1.0.10-26100101\\resources\\bin\\qoderclicn.exe`,
      `${scanDir}\\1.0.6-26091603\\resources\\bin\\qoderclicn.exe`,
      `${scanDir}\\0.1.8-26081406\\resources\\bin\\qoderclicn.exe`,
    ]);
  });

  it("非版本子目录混入也不崩（顺序无承诺，exists 会逐个试）", () => {
    const mixed = fakeListDir({
      "C:\\u\\AppData\\Local\\Programs": ["QwenWorkCN"],
      [scanDir]: ["1.0.6-26091603", "unrelated"],
      [`${scanDir}\\1.0.6-26091603`]: [],
      [`${scanDir}\\unrelated`]: [],
    });
    const candidates = windowsKnownInstallCandidates("qoderclicn", env, mixed);
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(`${scanDir}\\1.0.6-26091603\\resources\\bin\\qoderclicn.exe`);
    expect(candidates).toContain(`${scanDir}\\unrelated\\resources\\bin\\qoderclicn.exe`);
  });

  it("安装根下的文件（如 Updater.exe）被过滤：readdir 失败 = 不是目录", () => {
    // 真实机器（2026-11-09）：QwenWorkCN 下除了版本目录还有一个文件 Updater.exe，
    // locale 排序字母 > 数字，不过滤它会变成首候选。
    const withFile = fakeListDir({
      "C:\\u\\AppData\\Local\\Programs": ["QwenWorkCN"],
      [scanDir]: ["1.0.6-26091603", "Updater.exe"],
      [`${scanDir}\\1.0.6-26091603`]: [],
      // Updater.exe 故意不在目录表里：readdir 失败 = 文件，被过滤。
    });
    expect(windowsKnownInstallCandidates("qoderclicn", env, withFile)).toEqual([
      `${scanDir}\\1.0.6-26091603\\resources\\bin\\qoderclicn.exe`,
    ]);
  });
});

describe("windowsExecutableCandidates 回归", () => {
  it("PATHEXT 优先于裸名（裸名是跑不起来的 POSIX sh 脚本）", () => {
    const candidates = windowsExecutableCandidates(
      "codebuddy",
      { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" } as unknown as NodeJS.ProcessEnv,
    );
    expect(candidates).toEqual([
      "C:\\a\\codebuddy.exe",
      "C:\\a\\codebuddy.cmd",
      "C:\\a\\codebuddy",
      "C:\\b\\codebuddy.exe",
      "C:\\b\\codebuddy.cmd",
      "C:\\b\\codebuddy",
    ]);
  });
});
