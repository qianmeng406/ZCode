import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createEncodedPowerShellArgs } from "../scripts/powershell-command.mjs";

/** 用 PowerShell GetFullPathName 展开 8.3 短路径（QIANME~1 → qianmengyys）。 */
function expandShortPathSync(value: string): string {
  if (process.platform !== "win32" || !value.includes("~")) {
    return value;
  }
  try {
    return execFileSync(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[IO.Path]::GetFullPath('${value.replace(/'/g, "''")}')`,
      ],
      { windowsHide: true, encoding: "utf-8" },
    ).trim();
  } catch {
    return value;
  }
}

import {
  buildWindowsStaleShortcutScript,
  composeWindowsShortcutScanRoots,
  isWindowsStaleShortcutCandidate,
  parseWindowsStaleShortcutRepairResult,
  repairWindowsStaleShortcuts,
  STALE_SHORTCUT_SCAN_LIMIT,
} from "../src/main/desktopWindowsStaleShortcutRepair.js";

describe("desktopWindowsStaleShortcutRepair", () => {
  it("候选判定只接受文件名精确等于 productName 且目标失效的快捷方式", () => {
    // 前缀匹配会让 production 的 "ZCode" 吞掉 Preview 的 "ZCode Preview"，互相改指。
    expect(
      isWindowsStaleShortcutCandidate("ZCode Preview", false, { productName: "ZCode Preview" }),
    ).toBe(true);
    expect(
      isWindowsStaleShortcutCandidate("zcode preview", false, { productName: "ZCode Preview" }),
    ).toBe(true);
    // 名字带后缀 ≠ 精确匹配；目标仍有效的快捷方式永不触碰。
    expect(
      isWindowsStaleShortcutCandidate("ZCode Preview (2)", false, { productName: "ZCode Preview" }),
    ).toBe(false);
    expect(
      isWindowsStaleShortcutCandidate("ZCode Preview", true, { productName: "ZCode Preview" }),
    ).toBe(false);
    // productName 为空时整体禁用，防止空串匹配所有链接。
    expect(isWindowsStaleShortcutCandidate("Anything", false, { productName: "" })).toBe(false);
  });

  it("扫描根覆盖任务栏固定项、开始菜单与双桌面，空目录被过滤", () => {
    const roots = composeWindowsShortcutScanRoots({
      appData: "C:\\Users\\u\\AppData\\Roaming",
      home: "C:\\Users\\u",
      publicDir: "C:\\Users\\Public",
    });
    expect(roots).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar",
      "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
      "C:\\Users\\u\\Desktop",
      "C:\\Users\\Public\\Desktop",
    ]);
    expect(composeWindowsShortcutScanRoots({ appData: "C:\\r", home: "", publicDir: "" })).toEqual([
      "C:\\r\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar",
      "C:\\r\\Microsoft\\Windows\\Start Menu\\Programs",
    ]);
  });

  it("脚本把动态值全部走 $zcodeArg 注入，且带 SHChangeNotify 刷新", () => {
    const script = buildWindowsStaleShortcutScript({ rootCount: 4 });
    expect(script).toContain("$roots = @($zcodeArg0, $zcodeArg1, $zcodeArg2, $zcodeArg3)");
    expect(script).toContain("$appName = $zcodeArg4");
    expect(script).toContain("$targetExe = $zcodeArg5");
    expect(script).toContain(`$limit = ${STALE_SHORTCUT_SCAN_LIMIT}`);
    // 目标仍有效必须 continue 跳过；写完必须回读校验并 SHChangeNotify。
    expect(script).toContain("Test-Path -LiteralPath $target");
    expect(script).toContain("SHChangeNotify(0x2000, 0x5");
    // 参数注入后必须与 createEncodedPowerShellArgs 的顺序一致。
    const args = createEncodedPowerShellArgs(script, [
      "r0",
      "r1",
      "r2",
      "r3",
      "ZCode",
      "C:\\x.exe",
    ]);
    expect(args).toHaveLength(5);
  });

  it("结果解析器读取 SCANNED 与多行 REPAIRED 行协议", () => {
    expect(
      parseWindowsStaleShortcutRepairResult(
        "SCANNED 12\r\nREPAIRED C:\\a.lnk\r\nREPAIRED C:\\b.lnk",
      ),
    ).toEqual({
      scanned: 12,
      repaired: ["C:\\a.lnk", "C:\\b.lnk"],
    });
    expect(parseWindowsStaleShortcutRepairResult("")).toEqual({ scanned: 0, repaired: [] });
  });

  it("非 win32 或非打包态直接返回 null，不启动 PowerShell", async () => {
    const result = await repairWindowsStaleShortcuts({
      appData: "C:\\r",
      home: "C:\\u",
      publicDir: "C:\\p",
      productName: "ZCode Preview",
      currentExecutablePath: "C:\\nowhere\\ZCode Preview.exe",
      isPackaged: false,
    });
    expect(result).toBeNull();
  });

  const isWindows = process.platform === "win32";
  (isWindows ? describe : describe.skip)("PowerShell 往返", () => {
    let tempRoot = "";

    beforeEach(() => {
      // mkdtempSync 在 8.3 短名启用的卷上返回 QIANME~1 形态；.lnk 保存时 Windows 会把
      // 目标展开成长路径，比较前先用 PowerShell GetFullPathName 统一到长路径形态
      // （realpathSync 不展开 8.3 短名，FSO COM 的 Path 也不展开）。
      tempRoot = expandShortPathSync(mkdtempSync(join(tmpdir(), "zcode-stale-shortcut-")));
    });

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    function makePinnedDir(): string {
      const pinned = join(
        tempRoot,
        "roaming",
        "Microsoft",
        "Internet Explorer",
        "Quick Launch",
        "User Pinned",
        "TaskBar",
      );
      mkdirSync(pinned, { recursive: true });
      return pinned;
    }

    function createShortcut(shortcutPath: string, targetPath: string, iconLocation = ""): void {
      writeFileSync(shortcutPath, "placeholder");
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      const script = [
        "$sh = New-Object -ComObject WScript.Shell",
        `$s = $sh.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
        `$s.TargetPath = '${targetPath.replace(/'/g, "''")}'`,
        iconLocation ? `$s.IconLocation = '${iconLocation.replace(/'/g, "''")}'` : "",
        "$s.Save()",
      ]
        .filter(Boolean)
        .join("; ");
      execFileSync(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true },
      );
    }

    function readShortcutTarget(shortcutPath: string): string {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      return execFileSync(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$sh = New-Object -ComObject WScript.Shell",
            `$s = $sh.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
            "[Console]::Out.Write($s.TargetPath)",
          ].join("; "),
        ],
        { windowsHide: true, encoding: "utf-8" },
      ).trim();
    }

    it("重写目标失效的本应用快捷方式，跳过有效项与其他应用项", async () => {
      const pinned = makePinnedDir();
      const realTarget = join(tempRoot, "real-target", "app.exe");
      mkdirSync(join(tempRoot, "real-target"), { recursive: true });
      writeFileSync(realTarget, "exe");
      const stalePath = join(pinned, "ZCode Preview.lnk");
      const validPath = join(pinned, "ZCode Preview OK.lnk");
      const otherAppPath = join(pinned, "ZCode Preview Bonus.lnk");
      createShortcut(stalePath, join(tempRoot, "deleted-build", "ZCode Preview.exe"));
      createShortcut(validPath, realTarget);
      createShortcut(otherAppPath, realTarget);

      const currentExe = join(tempRoot, "current", "ZCode Preview.exe");
      mkdirSync(join(tempRoot, "current"), { recursive: true });
      writeFileSync(currentExe, "exe");

      const result = await repairWindowsStaleShortcuts({
        appData: join(tempRoot, "roaming"),
        home: tempRoot,
        publicDir: join(tempRoot, "public"),
        productName: "ZCode Preview",
        currentExecutablePath: currentExe,
        isPackaged: true,
      });

      expect(result).not.toBeNull();
      // "ZCode Preview OK" / "ZCode Preview Bonus" 与 productName 不精确相等，必须跳过。
      // repaired 里的路径经 Windows 解析（8.3 短路径已展开），只按文件名断言成员。
      expect(result?.repaired).toHaveLength(1);
      expect(result?.repaired[0]?.endsWith("ZCode Preview.lnk")).toBe(true);
      // 读回目标会被 Windows 规范化，按真实路径比较而不是字符串字面量。
      const normalize = (value: string): string => value.toLowerCase();
      expect(normalize(readShortcutTarget(stalePath))).toBe(normalize(currentExe));
      expect(normalize(readShortcutTarget(validPath))).toBe(normalize(realTarget));
      expect(normalize(readShortcutTarget(otherAppPath))).toBe(normalize(realTarget));
    }, 30_000);
  });
});
