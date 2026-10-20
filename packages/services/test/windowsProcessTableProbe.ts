import { execFileSync } from "node:child_process";

// Windows 进程树清理依赖 powershell CIM 进程表；慢 WMI 主机（本机实测 3.6~4.1s）超过
// 产品预算（快照 1s / 异步 2.5s）时清理必然报「残留」，属环境能力限制而非产品缺陷。
// 用例用同一命令行做能力探针：1.5s 内可完成枚举才执行依赖清理的断言。
export function windowsProcessTableWithinBudget(): boolean {
  if (process.platform !== "win32") return true;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
      ],
      { timeout: 1_500, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
