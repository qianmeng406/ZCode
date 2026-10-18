import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFileSystemPortError } from "@zcode/contracts";
import {
  createWslFileSystemAdapter,
  isPosixAbsoluteGuestPath,
  toWindowsDrivePath,
  toWslUncPath,
} from "../src/fs/wsl-file-system-adapter.js";
import { createNodeFileSystemAdapter } from "../src/fs/index.js";

// ============================================================
// WSL FileSystem Adapter（session-linux-execution 路径修复）
// ============================================================
// 根因回归：会话切到 WSL 后，Write/Edit/Read 仍走控制端本地 fs，
// POSIX 绝对路径 /home/u/f 被落盘到 Windows 盘 C:\home\u\f，与 WSL bash
// 执行的同一 Linux 路径不是同一文件 → 回放轮权限弹窗 1Hz 死循环。
// 适配器必须把 POSIX 绝对路径映射到 \\wsl.localhost\<distro>\... UNC，
// Windows 盘符/UNC 路径原样委托本地适配器（/mnt/c 真源行为不变）。

describe("isPosixAbsoluteGuestPath", () => {
  it("recognizes posix absolute paths in both separators", () => {
    expect(isPosixAbsoluteGuestPath("/home/user/file")).toBe(true);
    // 工具层 path-policy 在 win32 上会把 /home/x 规范化成 \home\x；
    // win32 isAbsolute 对它是 true，但无盘符且非 UNC → 仍是 guest 路径。
    expect(isPosixAbsoluteGuestPath("\\home\\user\\file")).toBe(true);
    expect(isPosixAbsoluteGuestPath("/")).toBe(true);
  });

  it("keeps windows drive and UNC paths as control-side paths", () => {
    expect(isPosixAbsoluteGuestPath("C:\\proj\\file")).toBe(false);
    expect(isPosixAbsoluteGuestPath("c:/proj/file")).toBe(false);
    expect(isPosixAbsoluteGuestPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\f")).toBe(false);
    expect(isPosixAbsoluteGuestPath("//wsl$/Ubuntu/home/u")).toBe(false);
    expect(isPosixAbsoluteGuestPath("relative/file")).toBe(false);
  });
});

describe("toWslUncPath", () => {
  it("maps posix absolute paths to the distro UNC root form", () => {
    expect(toWslUncPath("/home/zcodewslp2/workspace/marker.txt", "Ubuntu-24.04")).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\home\\zcodewslp2\\workspace\\marker.txt",
    );
    expect(toWslUncPath("/a/b/../c", "Ubuntu-24.04")).toBe(
      "\\\\wsl.localhost\\Ubuntu-24.04\\a\\c",
    );
  });
});

describe("toWindowsDrivePath", () => {
  it("maps /mnt/<drive>/... back to the Windows drive path (drvfs truth source)", () => {
    // 挂载盘不能走 UNC（9p-over-drvfs 在 Windows 侧 EPERM），必须回映射到真源路径。
    expect(toWindowsDrivePath("/mnt/c/Users/me/proj/file.txt")).toBe(
      "C:\\Users\\me\\proj\\file.txt",
    );
    expect(toWindowsDrivePath("/mnt/d/a/b/../c")).toBe("D:\\a\\c");
    expect(toWindowsDrivePath("/mnt/c")).toBe("C:\\");
    expect(toWindowsDrivePath("/mnt/c/")).toBe("C:\\");
  });

  it("leaves non-mounted posix paths and windows paths for UNC/local handling", () => {
    expect(toWindowsDrivePath("/home/u/file")).toBeUndefined();
    expect(toWindowsDrivePath("/tmp/x")).toBeUndefined();
    expect(toWindowsDrivePath("/mnt/wsl/x")).toBeUndefined();
    expect(toWindowsDrivePath("C:\\proj\\x")).toBeUndefined();
  });
});

describe("WslFileSystemAdapter delegation", () => {
  it("routes posix guest paths through the distro UNC mapping and returns the caller path shape", async () => {
    const seenPaths: string[] = [];
    const delegate = createNodeFileSystemAdapter();
    const probe = new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          const request = args[0] as { path?: string } | undefined;
          if (request?.path !== undefined) seenPaths.push(request.path);
          return (value as (...fnArgs: Array<unknown>) => unknown).apply(target, args);
        };
      },
    });
    const adapter = createWslFileSystemAdapter({ distro: "Ubuntu-24.04", delegate: probe });

    await adapter.writeTextFile({
      path: "/tmp/probe/nonexistent-dir/file.txt",
      content: "hello\n",
      createParents: true,
    });

    expect(seenPaths[0]).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\tmp\\probe\\nonexistent-dir\\file.txt");
  });

  it("maps mounted-drive posix paths to the Windows truth source before delegating", async () => {
    const seenPaths: string[] = [];
    const delegate = createNodeFileSystemAdapter();
    const probe = new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          const request = args[0] as { path?: string } | undefined;
          if (request?.path !== undefined) seenPaths.push(request.path);
          return (value as (...fnArgs: Array<unknown>) => unknown).apply(target, args);
        };
      },
    });
    const adapter = createWslFileSystemAdapter({ distro: "Ubuntu-24.04", delegate: probe });
    const dir = await mkdtemp(join(tmpdir(), "wsl-fs-adapter-mnt-"));
    const windowsPath = join(dir, "mnt.txt");
    await writeFile(windowsPath, "mnt", "utf8");
    // 同一份文件的 Linux 视图（/mnt/c/...）必须落到 Windows 真源，而不是 UNC。
    const guestPath = "/mnt/" + windowsPath[0]!.toLowerCase() + windowsPath.slice(2).replaceAll("\\", "/");
    const result = await adapter.stat({ path: guestPath });
    expect(seenPaths[0]!.toLowerCase()).toBe(windowsPath.toLowerCase());
    expect(result.path).toBe(guestPath);
  });

  it("delegates windows drive paths unchanged", async () => {
    const seenPaths: string[] = [];
    const delegate = createNodeFileSystemAdapter();
    const probe = new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: Array<unknown>) => {
          const request = args[0] as { path?: string } | undefined;
          if (request?.path !== undefined) seenPaths.push(request.path);
          return (value as (...fnArgs: Array<unknown>) => unknown).apply(target, args);
        };
      },
    });
    const adapter = createWslFileSystemAdapter({ distro: "Ubuntu-24.04", delegate: probe });

    const dir = await mkdtemp(join(tmpdir(), "wsl-fs-adapter-"));
    const filePath = join(dir, "local.txt");
    await writeFile(filePath, "local", "utf8");
    const result = await adapter.stat({ path: filePath });

    expect(seenPaths[0]!.toLowerCase()).toBe(filePath.toLowerCase());
    expect(result.path).toBe(filePath);
    expect(result.kind).toBe("file");
  });

  it("round-trips write/read on the guest path against a real distro UNC when available", async () => {
    // 真实 WSL UNC 依赖发行版在线；离线环境下跳过（CI/单测不要求 WSL 存活）。
    const distro = process.env.ZCODE_TEST_WSL_DISTRO?.trim() || "";
    if (!distro) return;
    const adapter = createWslFileSystemAdapter({ distro });
    const marker = `/tmp/zcode-wsl-fs-adapter-${Date.now()}/marker.txt`;
    const content = "E2E_MARKER_V1\n";

    await adapter.writeTextFile({ path: marker, content, createParents: true });
    try {
      const read = await adapter.readTextFile({ path: marker });
      expect(read.content).toBe(content);
      expect(read.path).toBe(marker);
      expect(read.revision?.id).toBeDefined();
      // 与 WSL bash 看到的是同一文件（Linux 侧直接读）。
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const stdout = (
        await promisify(execFile)("wsl.exe", ["-d", distro, "--exec", "cat", marker], {
          encoding: "utf8",
          timeout: 15000,
        })
      ).stdout;
      expect(stdout).toBe(content);
    } finally {
      await adapter.removeFile({ path: marker, missingOk: true }).catch(() => undefined);
    }
  });

  it("reports not_found with the caller path for missing guest files", async () => {
    const adapter = createWslFileSystemAdapter({ distro: "Ubuntu-24.04" });
    try {
      await adapter.readTextFile({ path: "/tmp/definitely-missing-file-xyz/file" });
      expect.unreachable("expected not_found");
    } catch (error) {
      expect(isFileSystemPortError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("not_found");
      expect((error as { path?: string }).path).toBe("/tmp/definitely-missing-file-xyz/file");
    }
  });

  it("stale-write detection survives the UNC mapping", async () => {
    // 不依赖真实 WSL：委托本地适配器 + Windows 临时目录（非 guest 路径）即可验证
    // revision/stale-write 语义在委托层不被破坏。
    const dir = await mkdtemp(join(tmpdir(), "wsl-fs-adapter-rev-"));
    const filePath = join(dir, "rev.txt");
    const adapter = createWslFileSystemAdapter({
      distro: "Ubuntu-24.04",
      delegate: createNodeFileSystemAdapter(),
    });
    const written = await adapter.writeTextFile({ path: filePath, content: "v1\n" });
    await mkdir(dir, { recursive: true });
    await expect(
      adapter.writeTextFile({
        path: filePath,
        content: "v2\n",
        expectedRevision: { id: `${written.revision!.id}-stale` },
      }),
    ).rejects.toMatchObject({ code: "stale_write" });
    await expect(adapter.readTextFile({ path: filePath })).resolves.toMatchObject({
      content: "v1\n",
    });
    await expect(readFile(filePath, "utf8")).resolves.toBe("v1\n");
  });
});
