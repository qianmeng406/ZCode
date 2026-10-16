import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { IRemoteBackend } from "../src/remote/backend.js";
import {
  buildPosixReadFilesCommand,
  parsePosixReadFilesOutput,
  remoteReadFiles,
} from "../src/remote/remoteReadFiles.js";

const execFileAsync = promisify(execFile);

// Windows 盘符路径转为 POSIX 风格，供 bash 作为脚本参数使用。
const windowsToPosix = (value: string) => value.replaceAll("\\", "/");
const shell =
  process.platform === "win32"
    ? [
        process.env.ZCODE_TEST_BASH,
        ...(process.env.PATH ?? "")
          .split(";")
          .filter((path) => /[\\/]Git[\\/]/iu.test(path))
          .map((path) => join(path, "bash.exe")),
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
      ].find((path): path is string => Boolean(path && existsSync(path)))
    : "/bin/bash";

function unpackScript(command: string): string {
  const octal = command.match(/^printf '%b' '(.*)' \| sh$/u)?.[1];
  if (octal === undefined) throw new Error("expected literal script transport");
  return Buffer.from(
    [...octal.matchAll(/\\([0-7]{3})/gu)].map((match) => Number.parseInt(match[1]!, 8)),
  ).toString("utf8");
}

function stubBackend(overrides: Partial<IRemoteBackend>): IRemoteBackend {
  return {
    dispose: () => undefined,
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    exec: async () => {
      throw new Error("not used");
    },
    exists: async () => false,
    readFile: async () => "",
    ...overrides,
  };
}

describe("buildPosixReadFilesCommand", () => {
  it("对含引号/空格/换行路径做 shell 转义，逐路径输出 Y:<base64> 或 N", () => {
    const command = unpackScript(
      buildPosixReadFilesCommand(["/home/u/a'b.txt", "/home/u/c d.txt"]),
    );
    // quotePosixShellArg 使用 '"'"' 惯用法转义单引号。
    expect(command).toContain(`'/home/u/a'"'"'b.txt'`);
    expect(command).toContain(`'/home/u/c d.txt'`);
    expect(command).toContain("printf 'N\\n'");
    expect(command).toContain("base64");
  });

  it("每条路径生成一个 if 块，共两段", () => {
    const command = unpackScript(buildPosixReadFilesCommand(["/a", "/b"]));
    expect(command.match(/if \[ -f /gu)).toHaveLength(2);
  });
});

describe("parsePosixReadFilesOutput", () => {
  it("解析 Y:<base64> 与 N 行；空文件为空 base64", () => {
    // base64("") === ""
    const encoded = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const output = `Y:${encoded("1.2.3")}\nN\nY:\n`;
    expect(parsePosixReadFilesOutput(output, 3)).toEqual(["1.2.3", null, ""]);
  });

  it("容忍 CRLF 与尾行换行；空文本按 N 语义之外必须可读", () => {
    const encoded = Buffer.from("hi", "utf8").toString("base64");
    expect(parsePosixReadFilesOutput(`Y:${encoded}\r\nY:\r\n`, 2)).toEqual(["hi", ""]);
  });

  it("文件内容含换行与分隔符冒号也不破坏解析", () => {
    const encoded = Buffer.from("line1\nline2:tail\n", "utf8").toString("base64");
    expect(parsePosixReadFilesOutput(`Y:${encoded}\n`, 1)).toEqual(["line1\nline2:tail\n"]);
  });

  it("Unicode（中文/emoji）内容正确解码", () => {
    const encoded = Buffer.from("版本 v1 中文 🚀", "utf8").toString("base64");
    expect(parsePosixReadFilesOutput(`Y:${encoded}\n`, 1)).toEqual(["版本 v1 中文 🚀"]);
  });

  it("行数不符即抛错", () => {
    expect(() => parsePosixReadFilesOutput("Y:AA==\n", 2)).toThrow("行数不符");
    expect(() => parsePosixReadFilesOutput("", 1)).toThrow("行数不符");
  });

  it("状态前缀非法即抛错", () => {
    expect(() => parsePosixReadFilesOutput("X:AA==\n", 1)).toThrow("非法");
    expect(() => parsePosixReadFilesOutput("Y\n", 1)).toThrow("非法");
  });

  it("base64 非法或截断即抛错", () => {
    expect(() => parsePosixReadFilesOutput("Y:AA=A\n", 1)).toThrow("base64");
    expect(() => parsePosixReadFilesOutput("Y:!!\n", 1)).toThrow("base64");
    expect(() => parsePosixReadFilesOutput("Y:\nY:AA\n", 2)).toThrow(); // AA 长度非 4 倍数
  });
});

describe("remoteReadFiles", () => {
  it("空输入直接返回空数组", async () => {
    const backend = stubBackend({
      readFile: async () => {
        throw new Error("不应调用");
      },
    });
    expect(await remoteReadFiles(backend, [])).toEqual([]);
  });

  it("backend 实现 readFiles 时原样委托", async () => {
    const calls: string[][] = [];
    const backend = stubBackend({
      readFiles: async (paths: string[]) => {
        calls.push(paths);
        return paths.map((_, index) => (index === 1 ? null : `v${index}`));
      },
    });
    expect(await remoteReadFiles(backend, ["a", "b", "c"])).toEqual(["v0", null, "v2"]);
    expect(calls).toEqual([["a", "b", "c"]]);
  });

  it("未实现 readFiles 时按原顺序串行 readFile，失败记 null", async () => {
    const order: string[] = [];
    const backend = stubBackend({
      readFile: async (remotePath: string) => {
        order.push(remotePath);
        if (remotePath === "b") {
          throw new Error("missing");
        }
        return `text-${remotePath}`;
      },
    });
    expect(await remoteReadFiles(backend, ["a", "b", "c"])).toEqual(["text-a", null, "text-c"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("批量返回长度不符时明确拒绝（不得静默少项）", async () => {
    const backend = stubBackend({
      readFiles: async () => ["only-one"],
    });
    await expect(remoteReadFiles(backend, ["a", "b"])).rejects.toThrow("长度");
  });

  it("批量返回含非字符串非 null 项时明确拒绝", async () => {
    const backend = stubBackend({
      readFiles: async () => ["ok", 42 as unknown as string],
    });
    await expect(remoteReadFiles(backend, ["a", "b"])).rejects.toThrow("非法");
  });

  it("批量抛错时逐项 readFile 退化，单个失败不影响其他", async () => {
    const order: string[] = [];
    const backend = stubBackend({
      readFiles: async () => {
        throw new Error("batch failed");
      },
      readFile: async (remotePath: string) => {
        order.push(remotePath);
        if (remotePath === "b") {
          throw new Error("missing");
        }
        return `text-${remotePath}`;
      },
    });
    expect(await remoteReadFiles(backend, ["a", "b", "c"])).toEqual(["text-a", null, "text-c"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("类实例（原型链方法）批量抛错时也能正确退化，不误判全 null", async () => {
    class BackendStub implements IRemoteBackend {
      readonly calls: string[] = [];
      dispose(): void {
        return undefined;
      }
      detect(): Promise<{ platform: string; arch: string }> {
        return Promise.resolve({ platform: "linux", arch: "x64" });
      }
      upload(): Promise<void> {
        return Promise.resolve();
      }
      exec(): Promise<never> {
        return Promise.reject(new Error("not used"));
      }
      exists(): Promise<boolean> {
        return Promise.resolve(false);
      }
      readFile(remotePath: string): Promise<string> {
        this.calls.push(remotePath);
        return Promise.resolve(`proto-${remotePath}`);
      }
      readFiles(): Promise<(string | null)[]> {
        return Promise.reject(new Error("batch failed"));
      }
    }
    const backend = new BackendStub();
    expect(await remoteReadFiles(backend, ["x", "y"])).toEqual(["proto-x", "proto-y"]);
    expect(backend.calls).toEqual(["x", "y"]);
  });
});

describe.skipIf(!shell)("buildPosixReadFilesCommand 真实 bash 执行", () => {
  let dir: string | null = null;

  afterAll(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("协议在真实 bash 下产出严格 Y:<base64>/N 行（Windows Git Bash / POSIX shell）", async () => {
    // Windows 显式选 Git Bash，不能误用 PATH 中的 WSL bash 启动器。
    dir = await mkdtemp(join(tmpdir(), "read-files-"));
    const versionPath = join(dir, "1.2.3.version");
    const emptyPath = join(dir, "empty.txt");
    const multiPath = join(dir, "multi.txt");
    const unicodePath = join(dir, "unicode.txt");
    const quotePath = join(dir, "quo'te d.txt");
    await writeFile(versionPath, "1.2.3\n");
    await writeFile(emptyPath, "");
    await writeFile(multiPath, "line1\nline2:tail\n");
    await writeFile(unicodePath, "版本 中文 🚀");
    await writeFile(quotePath, "q1'q2 v");

    const paths = [
      versionPath,
      emptyPath,
      multiPath,
      unicodePath,
      quotePath,
      join(dir, "missing.txt"),
    ].map(windowsToPosix);

    const command = buildPosixReadFilesCommand(paths);
    const { stdout } = await execFileAsync(shell!, ["-c", command], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(parsePosixReadFilesOutput(stdout, paths.length)).toEqual([
      "1.2.3\n",
      "",
      "line1\nline2:tail\n",
      "版本 中文 🚀",
      "q1'q2 v",
      null,
    ]);
  }, 30000);

  it("base64 缺失时命令输出非协议内容，解析抛错触发退化路径", async () => {
    const failureDir = await mkdtemp(join(tmpdir(), "read-files-no-base64-"));
    try {
      const file = join(failureDir, "present.txt");
      await writeFile(file, "must not become missing");
      const script = `base64() { return 127; }\n${unpackScript(buildPosixReadFilesCommand([windowsToPosix(file)]))}`;
      const octal = [...Buffer.from(script)]
        .map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
        .join("");
      const { stdout } = await execFileAsync(shell!, ["-c", `printf '%b' '${octal}' | sh`], {
        encoding: "utf8",
      });
      expect(stdout).toBe("T\n");
      expect(() => parsePosixReadFilesOutput(stdout, 1)).toThrow("非法");
    } finally {
      await rm(failureDir, { recursive: true, force: true });
    }
  }, 30000);
});
