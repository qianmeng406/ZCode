// bench-agent-linux 参数解析与校验。独立模块便于单元测试；无运行时依赖。
import { stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  samplesShort: 30,
  samplesWorkspace: 5,
};

export class ArgError extends Error {}

function requireAbsolute(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgError(`missing required ${name}`);
  }
  // Windows 盘符与 POSIX 根都视为绝对路径；用 path.isAbstract 判断的平台语义在
  // win32 下载 Linux 路径会失败，因此手动兼容两种形态。
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith("/")) {
    throw new ArgError(`${name} must be an absolute path: ${value}`);
  }
  return value;
}

function parseIntArg(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ArgError(`${name} must be an integer in [${min}, ${max}], got: ${value}`);
  }
  return n;
}

/**
 * 解析已知参数；未知参数报错。返回普通对象。
 */
export function parseArgs(argv) {
  const args = {
    workspace: null,
    output: null,
    shell: null,
    adapterModule: null,
    node: null,
    git: null,
    rg: null,
    samplesShort: DEFAULTS.samplesShort,
    samplesWorkspace: DEFAULTS.samplesWorkspace,
    taskCommandFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new ArgError(`missing value for ${key}`);
    }
    switch (key) {
      case "--workspace":
        args.workspace = value;
        break;
      case "--output":
        args.output = value;
        break;
      case "--shell":
        args.shell = value;
        break;
      case "--adapter-module":
        args.adapterModule = value;
        break;
      case "--node":
        args.node = value;
        break;
      case "--git":
        args.git = value;
        break;
      case "--rg":
        args.rg = value;
        break;
      case "--samples-short":
        args.samplesShort = value;
        break;
      case "--samples-workspace":
        args.samplesWorkspace = value;
        break;
      case "--task-command-file":
        args.taskCommandFile = value;
        break;
      default:
        throw new ArgError(`unknown argument: ${key}`);
    }
    i += 1;
  }
  requireAbsolute(args.workspace, "--workspace");
  requireAbsolute(args.output, "--output");
  requireAbsolute(args.shell, "--shell");
  args.samplesShort = parseIntArg(args.samplesShort, "--samples-short", 1, 1000);
  args.samplesWorkspace = parseIntArg(args.samplesWorkspace, "--samples-workspace", 1, 1000);
  for (const key of ["adapterModule", "node", "git", "rg", "taskCommandFile"]) {
    if (args[key] !== null) {
      requireAbsolute(
        args[key],
        `--${key === "taskCommandFile" ? "task-command-file" : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
    }
  }
  return args;
}

/**
 * 异步存在性校验：workspace 必须存在且为目录，shell 必须存在且为文件，
 * task-command-file 必须存在。
 */
export async function validateArgs(args) {
  const wsStat = await stat(args.workspace).catch(() => null);
  if (!wsStat || !wsStat.isDirectory()) {
    throw new ArgError(`--workspace does not exist or is not a directory: ${args.workspace}`);
  }
  const shellStat = await stat(args.shell).catch(() => null);
  if (!shellStat || !shellStat.isFile()) {
    throw new ArgError(`--shell does not exist or is not a file: ${args.shell}`);
  }
  if (args.taskCommandFile !== null) {
    const tfStat = await stat(args.taskCommandFile).catch(() => null);
    if (!tfStat || !tfStat.isFile()) {
      throw new ArgError(`--task-command-file does not exist: ${args.taskCommandFile}`);
    }
  }
}

/**
 * 解析 --task-command-file 的 JSON 内容。数组元素：
 * {name: string, file: absolute, args?: string[], cwd?: string, env?: Record<string,string>}
 * env 值只保留在解析结果里用于 spawn，绝不序列化进结果 JSON。
 */
export function parseTaskCommands(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new ArgError(`task command file is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ArgError("task command file must contain a JSON array");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ArgError(`task command #${index} must be an object`);
    }
    const { name, file, args, cwd, env } = entry;
    if (typeof name !== "string" || name.trim() === "") {
      throw new ArgError(`task command #${index} needs a non-empty string name`);
    }
    if (
      typeof file !== "string" ||
      (!path.isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file) && !file.startsWith("/"))
    ) {
      throw new ArgError(`task command "${name}" file must be an absolute path`);
    }
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
      throw new ArgError(`task command "${name}" args must be an array of strings`);
    }
    if (
      cwd !== undefined &&
      (typeof cwd !== "string" ||
        (!path.isAbsolute(cwd) && !/^[A-Za-z]:[\\/]/.test(cwd) && !cwd.startsWith("/")))
    ) {
      throw new ArgError(`task command "${name}" cwd must be an absolute path`);
    }
    if (
      env !== undefined &&
      (typeof env !== "object" ||
        env === null ||
        Object.values(env).some((v) => typeof v !== "string"))
    ) {
      throw new ArgError(`task command "${name}" env must be a Record<string, string>`);
    }
    return { name, file, args: args ?? [], cwd: cwd ?? null, env: env ?? null };
  });
}
