import { describe, expect, it } from "vitest";
import type { IRemoteBackend } from "../src/remote/backend.js";
import {
  buildPosixExistsManyCommand,
  parsePosixExistsManyOutput,
  remoteExistsMany,
} from "../src/remote/remoteExistsMany.js";

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

describe("remoteExistsMany", () => {
  it("批量命令对含引号/空格路径做 shell 转义并逐路径输出 Y/N", () => {
    const command = buildPosixExistsManyCommand(["/home/u/a'b.txt", "/home/u/c d.txt"]);
    // quotePosixShellArg 使用 '"'"' 惯用法转义单引号。
    expect(command).toContain(`'/home/u/a'"'"'b.txt'`);
    expect(command).toContain(`'/home/u/c d.txt'`);
    expect(command.split("\n")).toHaveLength(2);
    expect(command).toContain("printf 'Y\\n'");
    expect(command).toContain("printf 'N\\n'");
  });

  it("解析 Y/N 输出，容忍 CRLF 与尾行", () => {
    expect(parsePosixExistsManyOutput("Y\nN\nY\n", 3)).toEqual([true, false, true]);
    expect(parsePosixExistsManyOutput("Y\r\nN\r\n", 2)).toEqual([true, false]);
  });

  it("行数不符或取值非法即抛错（由调用方退化串行）", () => {
    expect(() => parsePosixExistsManyOutput("Y\n", 2)).toThrow("行数不符");
    expect(() => parsePosixExistsManyOutput("Y\nX\n", 2)).toThrow("非法");
    expect(() => parsePosixExistsManyOutput("", 1)).toThrow("行数不符");
  });

  it("空输入直接返回空数组", async () => {
    const backend = stubBackend({
      exists: async () => {
        throw new Error("不应调用");
      },
    });
    expect(await remoteExistsMany(backend, [])).toEqual([]);
  });

  it("backend 实现 existsMany 时原样委托", async () => {
    const calls: string[][] = [];
    const backend = stubBackend({
      existsMany: async (paths: string[]) => {
        calls.push(paths);
        return paths.map((_, index) => index % 2 === 0);
      },
    });
    expect(await remoteExistsMany(backend, ["a", "b", "c"])).toEqual([true, false, true]);
    expect(calls).toEqual([["a", "b", "c"]]);
  });

  it("未实现 existsMany 时按原顺序串行 fallback", async () => {
    const order: string[] = [];
    const backend = stubBackend({
      exists: async (remotePath: string) => {
        order.push(remotePath);
        return remotePath === "b";
      },
    });
    expect(await remoteExistsMany(backend, ["a", "b", "c"])).toEqual([false, true, false]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
