// Windows 快捷方式自愈：构建目录删除/迁移后，任务栏固定项与开始菜单里的 .lnk
// 继续指向已不存在的 exe，任务栏/开始菜单图标随即退化为空白图标（老问题）。
// NSIS 安装器只在安装阶段修复快捷方式，覆盖不了 unpacked 构建目录被重建的场景，
// 因此由应用启动时自行归一。只修复「文件名精确等于本应用 productName 且目标已
// 失效」的快捷方式，绝不触碰指向其他应用或目标仍有效的项，避免破坏用户的固定
// 关系；AUMID 不改写（同一 flavor 身份不变，固定关系随 .lnk 原样保留）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEncodedPowerShellArgs } from "../../scripts/powershell-command.mjs";

/** 单次自愈最多检查的 .lnk 数量；防止异常目录结构把启动期 PowerShell 拖爆。 */
export const STALE_SHORTCUT_SCAN_LIMIT = 512;

const POWERSHELL_TIMEOUT_MS = 20_000;

export interface WindowsShortcutScanDirs {
  /** Electron app.getPath("appData")，Roaming 根。 */
  appData: string;
  /** Electron app.getPath("home")，用户主目录。 */
  home: string;
  /** 公共用户目录（process.env.PUBLIC）；为空时跳过公共桌面。 */
  publicDir: string;
}

/**
 * 参与自愈的快捷方式位置：任务栏固定项、开始菜单、用户桌面与公共桌面。
 * 任务栏固定目录是隐含目录，Explorer 固定应用时会把 .lnk 拷进去；目标失效后
 * Windows 仍按旧 AUMI 渲染灰色图标，必须重写目标才能恢复。
 */
export function composeWindowsShortcutScanRoots(dirs: WindowsShortcutScanDirs): string[] {
  const roots = [
    join(dirs.appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
    join(dirs.appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    dirs.home ? join(dirs.home, "Desktop") : "",
    dirs.publicDir ? join(dirs.publicDir, "Desktop") : "",
  ];
  return roots.filter((root) => root.length > 0);
}

export interface WindowsStaleShortcutCandidateOptions {
  productName: string;
}

/**
 * 纯逻辑镜像：与 PowerShell 脚本里的修复判定保持同一条规则。
 * 名字必须精确等于 productName（大小写不敏感）——用前缀匹配会让 production 的
 * "ZCode" 吞掉 Preview 的 "ZCode Preview" 链接，把两个身份互相改指。
 */
export function isWindowsStaleShortcutCandidate(
  linkName: string,
  targetExists: boolean,
  options: WindowsStaleShortcutCandidateOptions,
): boolean {
  if (!options.productName) return false;
  return linkName.toLowerCase() === options.productName.toLowerCase() && !targetExists;
}

interface WindowsStaleShortcutScriptOptions {
  rootCount: number;
  scanLimit?: number;
}

/**
 * 生成自愈脚本。参数约定：`$zcodeArg0..N-1` 是扫描根目录，`$zcodeArgN` 是
 * productName，`$zcodeArgN+1` 是当前可执行文件路径（与 createEncodedPowerShellArgs
 * 的注入顺序一致）。输出是行协议：`SCANNED <n>` 与零或多行 `REPAIRED <path>`。
 */
export function buildWindowsStaleShortcutScript(
  options: WindowsStaleShortcutScriptOptions,
): string {
  const scanLimit = options.scanLimit ?? STALE_SHORTCUT_SCAN_LIMIT;
  const rootIndexes = Array.from({ length: options.rootCount }, (_, index) => `$zcodeArg${index}`);
  const appNameArg = `$zcodeArg${options.rootCount}`;
  const targetExeArg = `$zcodeArg${options.rootCount + 1}`;
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue';
Add-Type -Namespace Win32 -Name ShellNotify -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int wEventId, int uFlags, string dwItem1, IntPtr dwItem2);';
$sh = New-Object -ComObject WScript.Shell;
$roots = @(${rootIndexes.join(", ")});
$appName = ${appNameArg};
$targetExe = ${targetExeArg};
$limit = ${scanLimit};
$scanned = 0;
$repaired = New-Object System.Collections.Generic.List[string];
$paths = New-Object System.Collections.Generic.List[string];
foreach ($root in $roots) {
  if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { continue; }
  $found = Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | Select-Object -First $limit;
  foreach ($item in $found) { $paths.Add($item.FullName); }
}
foreach ($path in $paths) {
  if ($scanned -ge $limit) { break; }
  $scanned = $scanned + 1;
  $linkName = [IO.Path]::GetFileNameWithoutExtension($path);
  if (-not $linkName.Equals($appName, [StringComparison]::OrdinalIgnoreCase)) { continue; }
  $shortcut = $sh.CreateShortcut($path);
  if ($null -eq $shortcut) { continue; }
  $target = $shortcut.TargetPath;
  if (-not [string]::IsNullOrWhiteSpace($target) -and (Test-Path -LiteralPath $target)) { continue; }
  $shortcut.TargetPath = $targetExe;
  $shortcut.IconLocation = ($targetExe + ',0');
  $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($targetExe);
  $shortcut.Save();
  $rewritten = $sh.CreateShortcut($path);
  // 不能用 TargetPath 与 $targetExe 做字符串比较：保存 .lnk 时 Windows 会把 8.3 短路径
  // 解析成长路径（QIANME~1 → qianmengyys），字符串形态对不上会把成功的修复误判为失败。
  // 成功判定只看回读目标非空且真实存在。
  if (($null -ne $rewritten) -and (-not [string]::IsNullOrWhiteSpace($rewritten.TargetPath)) -and (Test-Path -LiteralPath $rewritten.TargetPath)) {
    $repaired.Add($path);
    [Win32.ShellNotify]::SHChangeNotify(0x2000, 0x5, $path, [IntPtr]::Zero);
  }
}
[Console]::Out.Write('SCANNED ' + $scanned);
foreach ($p in $repaired) { [Console]::Out.Write([Environment]::NewLine + 'REPAIRED ' + $p); }
`;
}

export interface WindowsStaleShortcutRepairResult {
  scanned: number;
  repaired: string[];
}

export function parseWindowsStaleShortcutRepairResult(
  stdout: string,
): WindowsStaleShortcutRepairResult {
  let scanned = 0;
  const repaired: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SCANNED ")) {
      scanned = Number(trimmed.slice("SCANNED ".length)) || 0;
    } else if (trimmed.startsWith("REPAIRED ")) {
      repaired.push(trimmed.slice("REPAIRED ".length));
    }
  }
  return { scanned, repaired };
}

export interface WindowsStaleShortcutRepairOptions extends WindowsShortcutScanDirs {
  scanRoots?: readonly string[];
  productName: string;
  currentExecutablePath: string;
  isPackaged: boolean;
}

function runPowerShell(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(powershell, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: timeoutMs,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`powershell exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * 启动期自愈入口：只处理打包态（开发态的 process.execPath 是仓库共享的 Electron
 * 运行时，把用户快捷方式改指到它，下一次构建后又会失效）。失败一律吞掉返回 null，
 * 自愈失败不能影响主进程启动。
 */
export async function repairWindowsStaleShortcuts(
  options: WindowsStaleShortcutRepairOptions,
): Promise<WindowsStaleShortcutRepairResult | null> {
  if (process.platform !== "win32" || options.isPackaged !== true) {
    return null;
  }
  if (!options.productName || !existsSync(options.currentExecutablePath)) {
    return null;
  }
  const scanRoots = options.scanRoots ?? composeWindowsShortcutScanRoots(options);
  if (scanRoots.length === 0) {
    return null;
  }
  const script = buildWindowsStaleShortcutScript({ rootCount: scanRoots.length });
  const stdout = await runPowerShell(
    createEncodedPowerShellArgs(script, [
      ...scanRoots,
      options.productName,
      options.currentExecutablePath,
    ]),
    POWERSHELL_TIMEOUT_MS,
  );
  return parseWindowsStaleShortcutRepairResult(stdout);
}
