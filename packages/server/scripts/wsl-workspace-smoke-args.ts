import { isAbsolute, resolve } from "node:path";

/**
 * wsl-workspace-smoke 显式参数（opt-in 验收驱动，规格见 docs/research/wsl-workspace-acceptance.spec.md）。
 * 所有参数必须显式给出：不猜测 distro/user/workspace，也不从环境变量隐式继承。
 */
export interface WslWorkspaceSmokeOptions {
  /** WSL 发行版名，例如 Ubuntu-24.04。 */
  distro: string;
  /** WSL 内非 root 专属用户，例如 zcodewslp2。 */
  user: string;
  /** WSL 内 ext4 工作区 POSIX 绝对路径，例如 /home/zcodewslp2/workspace。 */
  workspace: string;
  /** Windows 本地随包资源目录（mockCdnDir），Windows 绝对路径。 */
  mockCdnDir: string;
  /** 结构化结果 JSON 输出文件，Windows 绝对路径。 */
  output: string;
}

const VALUE_FLAGS = ["--distro", "--user", "--workspace", "--mock-cdn-dir", "--output"] as const;

/** user/distro 会进入 wsl.exe -d/-u 参数与远端 shell 路径拼接，必须限定安全字符集。 */
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

// 控制字符（NUL/换行/回车等）会破坏 wsl.exe 参数与远端 shell 行；.. 段会逃出声明的工作区。
function hasUnsafePathChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}
function hasDotDotSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`参数 ${flag} 缺少值`);
  }
  return value;
}

export function parseSmokeArgs(argv: string[]): WslWorkspaceSmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const flag = VALUE_FLAGS.find((candidate) => candidate === arg);
    if (!flag) {
      throw new Error(`未知参数: ${arg}（支持: ${VALUE_FLAGS.join(" ")}）`);
    }
    if (values.has(flag)) {
      throw new Error(`参数 ${flag} 重复给出`);
    }
    values.set(flag, readValue(argv, index, flag));
    // 值本身不参与 flag 匹配：跳过一个位置。
    index += 1;
  }

  for (const flag of VALUE_FLAGS) {
    if (!values.has(flag)) {
      throw new Error(`缺少必填参数 ${flag}`);
    }
  }

  const distro = values.get("--distro")!;
  const user = values.get("--user")!;
  const workspace = values.get("--workspace")!;
  const mockCdnDir = values.get("--mock-cdn-dir")!;
  const output = values.get("--output")!;

  if (!DISTRO_PATTERN.test(distro)) {
    throw new Error(`--distro 含不安全字符: ${distro}`);
  }
  if (!USER_PATTERN.test(user)) {
    throw new Error(`--user 必须是合法 POSIX 用户名（字母/数字/_/-，字母或下划线开头）: ${user}`);
  }
  if (hasUnsafePathChars(workspace)) {
    throw new Error(`--workspace 含控制字符（NUL/换行等）`);
  }
  if (!workspace.startsWith("/") || workspace.includes("\\")) {
    throw new Error(`--workspace 必须是 WSL 内的 POSIX 绝对路径（以 / 开头）: ${workspace}`);
  }
  if (hasDotDotSegment(workspace)) {
    throw new Error(`--workspace 不允许 .. 路径段: ${workspace}`);
  }
  // 本地 Windows 路径先按原值校验绝对性，再 resolve 绝对化；
  // 反过来先 resolve 会把相对路径静默拼到 cwd，校验永远通过。
  if (!isAbsolute(mockCdnDir)) {
    throw new Error(`--mock-cdn-dir 必须是绝对路径: ${mockCdnDir}`);
  }
  if (!isAbsolute(output)) {
    throw new Error(`--output 必须是绝对路径: ${output}`);
  }

  return {
    distro,
    user,
    workspace,
    mockCdnDir: resolve(mockCdnDir),
    output: resolve(output),
  };
}
