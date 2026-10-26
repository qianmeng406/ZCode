import { mkdir, mkdtemp, rm, symlink, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn<typeof import("node:fs/promises").lstat>(),
  open: vi.fn<typeof import("node:fs/promises").open>(),
  readdir: vi.fn<typeof import("node:fs/promises").readdir>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: fsMocks.lstat,
    open: fsMocks.open,
    readdir: fsMocks.readdir,
  };
});

import { createMemoryService } from "../src/memory/memoryService.js";
import { PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE } from "../src/memory/memory.js";
import { getZCodeDataRootDir, setDataBaseDir } from "../src/paths.js";

let tempDir: string;
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function createNotFoundError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
    code: "ENOENT",
  });
}

function projectsRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function workspaceMemoryRoot(workspaceId: string): string {
  return join(projectsRoot(), workspaceId, "memory");
}

async function writeMemoryFile(
  workspaceId: string,
  fileName: string,
  content: string,
  modifiedAt?: Date,
): Promise<void> {
  const memoryRoot = workspaceMemoryRoot(workspaceId);
  await mkdir(memoryRoot, { recursive: true });
  const filePath = join(memoryRoot, fileName);
  await writeFile(filePath, content, "utf-8");
  if (modifiedAt) {
    await utimes(filePath, modifiedAt, modifiedAt);
  }
}

beforeEach(async () => {
  fsMocks.lstat.mockReset();
  fsMocks.lstat.mockImplementation(actualFs.lstat);
  fsMocks.open.mockReset();
  fsMocks.open.mockImplementation(actualFs.open);
  fsMocks.readdir.mockReset();
  fsMocks.readdir.mockImplementation(actualFs.readdir);
  tempDir = await mkdtemp(join(tmpdir(), "zcode-project-memory-service-"));
  setDataBaseDir(tempDir);
});

afterEach(async () => {
  setDataBaseDir(null);
  await rm(tempDir, { recursive: true, force: true });
});

describe("memoryService Project Memory catalog", () => {
  it("缺少 Project Memory 根目录时返回空 catalog", async () => {
    const service = createMemoryService();

    await expect(service.listProjectMemories()).resolves.toEqual([]);
  });

  it("只列出非空 workspace，并稳定排序 index 与事实文件", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-02-01T00:00:00.000Z");
    await writeMemoryFile("older-project-1111111111111111", "MEMORY.md", "older index", older);
    await writeMemoryFile("newer-project-2222222222222222", "z-last.md", "last", newer);
    await writeMemoryFile("newer-project-2222222222222222", "a-first.md", "first", newer);
    await writeMemoryFile("newer-project-2222222222222222", "MEMORY.md", "newer index", newer);
    await writeMemoryFile("newer-project-2222222222222222", "ignored.MD", "ignored", newer);
    await mkdir(workspaceMemoryRoot("empty-project-3333333333333333"), {
      recursive: true,
    });

    const workspaces = await createMemoryService().listProjectMemories();

    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      "newer-project-2222222222222222",
      "older-project-1111111111111111",
    ]);
    expect(workspaces[0]).toMatchObject({
      id: "newer-project-2222222222222222",
      label: "newer-project",
      files: [
        {
          name: "MEMORY.md",
          kind: "index",
          path: join(workspaceMemoryRoot("newer-project-2222222222222222"), "MEMORY.md"),
        },
        { name: "a-first.md", kind: "item" },
        { name: "z-last.md", kind: "item" },
      ],
    });
    expect(workspaces[0]?.updatedAt).toBe(newer.getTime());
  });

  it("扫描期间 Memory 目录消失时跳过该 workspace", async () => {
    const workspaceId = "removed-memory-root-3333333333333333";
    await writeMemoryFile(workspaceId, "MEMORY.md", "temporary index");
    fsMocks.readdir.mockImplementationOnce(actualFs.readdir);
    fsMocks.readdir.mockRejectedValueOnce(createNotFoundError(workspaceMemoryRoot(workspaceId)));

    await expect(createMemoryService().listProjectMemories()).resolves.toEqual([]);
  });

  it("扫描期间事实文件消失时跳过该文件并保留其余 catalog", async () => {
    const workspaceId = "removed-fact-3333333333333333";
    const removedFilePath = join(workspaceMemoryRoot(workspaceId), "removed.md");
    await writeMemoryFile(workspaceId, "MEMORY.md", "remaining index");
    await writeMemoryFile(workspaceId, "removed.md", "temporary fact");
    fsMocks.lstat.mockImplementation(async (path, options) => {
      if (path === removedFilePath) {
        throw createNotFoundError(removedFilePath);
      }
      return actualFs.lstat(path, options);
    });

    await expect(createMemoryService().listProjectMemories()).resolves.toMatchObject([
      {
        id: workspaceId,
        files: [{ name: "MEMORY.md", kind: "index" }],
      },
    ]);
  });

  it("从当前 product data root 读取并原样返回 Markdown", async () => {
    const content = [
      "---",
      "name: exact-content",
      "metadata:",
      "  originSessionId: session-1",
      "---",
      "",
      "# Raw Memory",
      "",
    ].join("\n");
    await writeMemoryFile("exact-project-4444444444444444", "exact-content.md", content);

    await expect(
      createMemoryService().readProjectMemoryFile({
        workspaceId: "exact-project-4444444444444444",
        fileName: "exact-content.md",
      }),
    ).resolves.toMatchObject({ content });
  });

  it("打开后的句柄与已校验文件身份不一致时拒绝返回外部正文", async () => {
    const workspaceId = "swapped-file-4444444444444444";
    const fileName = "fact.md";
    const outsidePath = join(tempDir, "outside.md");
    await writeMemoryFile(workspaceId, fileName, "inside");
    await writeFile(outsidePath, "OUTSIDE_SECRET", "utf-8");
    fsMocks.open.mockImplementationOnce((_path, flags, mode) =>
      actualFs.open(outsidePath, flags, mode),
    );

    await expect(
      createMemoryService().readProjectMemoryFile({ workspaceId, fileName }),
    ).rejects.toMatchObject({
      code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
      message: "Project Memory file changed during preview: fact.md",
    });
  });

  it.each(["workspace", "memory"] as const)(
    "打开文件时 %s 目录被替换为外部链接后拒绝返回正文",
    async (swapTarget) => {
      const workspaceId = `swapped-${swapTarget}-4444444444444444`;
      const fileName = "fact.md";
      const workspaceRoot = dirname(workspaceMemoryRoot(workspaceId));
      const memoryRoot = workspaceMemoryRoot(workspaceId);
      const externalWorkspace = join(tempDir, `external-${swapTarget}`);
      const externalMemoryRoot = join(externalWorkspace, "memory");
      await writeMemoryFile(workspaceId, fileName, "inside");
      await mkdir(externalMemoryRoot, { recursive: true });
      await writeFile(join(externalMemoryRoot, fileName), "OUTSIDE_SECRET", "utf-8");
      fsMocks.open.mockImplementationOnce(async (path, flags, mode) => {
        const target = swapTarget === "workspace" ? workspaceRoot : memoryRoot;
        const externalTarget = swapTarget === "workspace" ? externalWorkspace : externalMemoryRoot;
        await actualFs.rename(target, `${target}.original`);
        await actualFs.symlink(
          externalTarget,
          target,
          process.platform === "win32" ? "junction" : "dir",
        );
        return actualFs.open(path, flags, mode);
      });

      await expect(
        createMemoryService().readProjectMemoryFile({ workspaceId, fileName }),
      ).rejects.toThrow();
    },
  );

  it("稳定读取不阻塞并发原子更新，后续读取看到新正文", async () => {
    const workspaceId = "concurrent-update-4444444444444444";
    const fileName = "fact.md";
    const filePath = join(workspaceMemoryRoot(workspaceId), fileName);
    await writeMemoryFile(workspaceId, fileName, "before");
    fsMocks.open.mockImplementationOnce(async (path, flags, mode) => {
      // Bugfix: Windows 上持打开句柄期间 rename 同一目标必然 EPERM（POSIX 允许）。
      // mock 顺序改为"先完成原子替换、再打开句柄"，双平台语义一致：句柄指向新
      // inode，stable read 的三段 stat 校验仍能识别文件已变化，无需 win32 skip。
      const replacementPath = `${filePath}.replacement`;
      await writeFile(replacementPath, "after", "utf-8");
      await actualFs.rename(replacementPath, filePath);
      return actualFs.open(path, flags, mode);
    });

    const service = createMemoryService();
    await expect(service.readProjectMemoryFile({ workspaceId, fileName })).rejects.toMatchObject({
      code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
      message: "Project Memory file changed during preview: fact.md",
    });
    await expect(actualFs.readFile(filePath, "utf-8")).resolves.toBe("after");
    await expect(service.readProjectMemoryFile({ workspaceId, fileName })).resolves.toMatchObject({
      content: "after",
    });
  });

  it("同一文件在预览期间被原地改写时拒绝返回不稳定正文", async () => {
    const workspaceId = "in-place-update-4444444444444444";
    const fileName = "fact.md";
    const filePath = join(workspaceMemoryRoot(workspaceId), fileName);
    await writeMemoryFile(workspaceId, fileName, "before");
    // 同长度紧邻写入可能落在同一个文件系统时钟刻度；固定旧 mtime，确保构造出可观测的版本变化。
    // 不用 sleep，也不绕过真实句柄读取及服务的最终 stat 校验。
    await utimes(filePath, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    fsMocks.open.mockImplementationOnce(async (path, flags, mode) => {
      const handle = await actualFs.open(path, flags, mode);
      return {
        stat: handle.stat.bind(handle),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await writeFile(filePath, "after!", "utf-8");
          return handle.read(buffer, offset, length, position);
        },
        close: handle.close.bind(handle),
      } as unknown as Awaited<ReturnType<typeof actualFs.open>>;
    });

    await expect(
      createMemoryService().readProjectMemoryFile({ workspaceId, fileName }),
    ).rejects.toMatchObject({
      code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
      message: "Project Memory file changed during preview: fact.md",
    });
    await expect(actualFs.readFile(filePath, "utf-8")).resolves.toBe("after!");
  });

  it("拒绝预览超过 5 MiB 的 Project Memory 文件", async () => {
    const workspaceId = "large-project-5555555555555555";
    const fileName = "large.md";
    const filePath = join(workspaceMemoryRoot(workspaceId), fileName);
    await writeMemoryFile(workspaceId, fileName, "");
    await truncate(filePath, 5 * 1024 * 1024 + 1);

    await expect(
      createMemoryService().readProjectMemoryFile({ workspaceId, fileName }),
    ).rejects.toMatchObject({
      code: "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED",
      message: "Project Memory file exceeds the 5 MiB preview limit: large.md",
    });
  });

  it("拒绝 traversal、路径分隔符和非 Memory Markdown 文件", async () => {
    const service = createMemoryService();

    await expect(
      service.readProjectMemoryFile({
        workspaceId: "../outside",
        fileName: "secret.md",
      }),
    ).rejects.toThrow();
    await expect(
      service.readProjectMemoryFile({
        workspaceId: "workspace-5555555555555555",
        fileName: "../secret.md",
      }),
    ).rejects.toThrow();
    await expect(
      service.readProjectMemoryFile({
        workspaceId: "workspace-5555555555555555",
        fileName: "secret.MD",
      }),
    ).rejects.toThrow();
    await expect(
      service.readProjectMemoryFile({
        workspaceId: "/absolute/workspace",
        fileName: "secret.md",
      }),
    ).rejects.toThrow();
    await expect(
      service.readProjectMemoryFile({
        workspaceId: "workspace-5555555555555555",
        fileName: "nested\\secret.md",
      }),
    ).rejects.toThrow();
  });

  it("读取时要求磁盘目录项名称与请求名称大小写完全一致", async () => {
    const workspaceId = "case-sensitive-project-6666666666666666";
    await writeMemoryFile(workspaceId, "SECRET.MD", "excluded uppercase extension");

    const service = createMemoryService();
    await expect(service.listProjectMemories()).resolves.toEqual([]);
    await expect(
      service.readProjectMemoryFile({ workspaceId, fileName: "secret.md" }),
    ).rejects.toThrow();
  });

  it("不跟随 workspace symlink", async () => {
    const externalWorkspace = join(tempDir, "external-project");
    await mkdir(join(externalWorkspace, "memory"), { recursive: true });
    await writeFile(join(externalWorkspace, "memory", "secret.md"), "external secret", "utf-8");
    await mkdir(projectsRoot(), { recursive: true });
    await symlink(
      externalWorkspace,
      join(projectsRoot(), "linked-project-6666666666666666"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const service = createMemoryService();
    await expect(service.listProjectMemories()).resolves.toEqual([]);
    await expect(
      service.readProjectMemoryFile({
        workspaceId: "linked-project-6666666666666666",
        fileName: "secret.md",
      }),
    ).rejects.toThrow();
  });

  it("不跟随 Project Memory 根目录 symlink", async () => {
    const externalProjectsRoot = join(tempDir, "external-projects");
    const workspaceId = "linked-projects-root-7777777777777777";
    await mkdir(join(externalProjectsRoot, workspaceId, "memory"), {
      recursive: true,
    });
    await writeFile(
      join(externalProjectsRoot, workspaceId, "memory", "outside.md"),
      "outside body",
      "utf-8",
    );
    await mkdir(dirname(projectsRoot()), { recursive: true });
    await symlink(
      externalProjectsRoot,
      projectsRoot(),
      process.platform === "win32" ? "junction" : "dir",
    );

    const service = createMemoryService();
    await expect(service.listProjectMemories()).rejects.toThrow();
    await expect(
      service.readProjectMemoryFile({ workspaceId, fileName: "outside.md" }),
    ).rejects.toThrow();
  });

  it("文件在 catalog 后被删除时向调用方返回原始读取错误", async () => {
    const workspaceId = "deleted-project-7777777777777777";
    const fileName = "deleted.md";
    await writeMemoryFile(workspaceId, fileName, "temporary");
    const service = createMemoryService();
    await expect(service.listProjectMemories()).resolves.toMatchObject([{ id: workspaceId }]);

    await unlink(join(workspaceMemoryRoot(workspaceId), fileName));

    await expect(service.readProjectMemoryFile({ workspaceId, fileName })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("memoryService Project Memory file editing", () => {
  const workspaceId = "editable-project-8888888888888888";

  function enabledService(): ReturnType<typeof createMemoryService> {
    return createMemoryService({ isForkFeatureEnabled: () => true });
  }

  async function readRawPath(fileName: string): Promise<string> {
    return join(workspaceMemoryRoot(workspaceId), fileName);
  }

  it("缺少开关注入时 fail-closed：写与删都拒绝且不触碰文件系统", async () => {
    await writeMemoryFile(workspaceId, "seed.md", "original");
    const before = await actualFs.readFile(await readRawPath("seed.md"), "utf-8");

    const service = createMemoryService();
    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "seed.md", content: "changed" }),
    ).rejects.toMatchObject({ code: "FORK_FEATURE_DISABLED" });
    await expect(
      service.deleteProjectMemoryFile({ workspaceId, fileName: "seed.md" }),
    ).rejects.toMatchObject({ code: "FORK_FEATURE_DISABLED" });

    await expect(actualFs.readFile(await readRawPath("seed.md"), "utf-8")).resolves.toBe(before);
    await expect(actualFs.stat(await readRawPath("seed.md"))).resolves.toBeTruthy();
  });

  it("开关显式关闭时同样拒绝（不与 fail-closed 混为一谈）", async () => {
    await writeMemoryFile(workspaceId, "seed.md", "original");
    const service = createMemoryService({ isForkFeatureEnabled: async () => false });

    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "seed.md", content: "changed" }),
    ).rejects.toMatchObject({ code: "FORK_FEATURE_DISABLED" });
  });

  it("新增条目并返回写入后的 updatedAt/size", async () => {
    await writeMemoryFile(workspaceId, "MEMORY.md", "- [Seed](seed.md) — seed\n");
    const service = enabledService();

    const result = await service.writeProjectMemoryFile({
      workspaceId,
      fileName: "new-note.md",
      content: "# Note\n\nbody\n",
    });

    expect(result.size).toBe(Buffer.byteLength("# Note\n\nbody\n", "utf8"));
    expect(result.updatedAt).toBeGreaterThan(0);
    await expect(actualFs.readFile(await readRawPath("new-note.md"), "utf-8")).resolves.toBe(
      "# Note\n\nbody\n",
    );
    const reread = await service.readProjectMemoryFile({
      workspaceId,
      fileName: "new-note.md",
    });
    expect(reread.content).toBe("# Note\n\nbody\n");
    expect(reread.updatedAt).toBeCloseTo(result.updatedAt, 0);
  });

  it("expectedUpdatedAt 匹配时覆盖，stale 时按 FILE_CHANGED 拒绝且正文不变", async () => {
    await writeMemoryFile(workspaceId, "seed.md", "original");
    const service = enabledService();
    const { updatedAt } = await service.readProjectMemoryFile({
      workspaceId,
      fileName: "seed.md",
    });

    await expect(
      service.writeProjectMemoryFile({
        workspaceId,
        fileName: "seed.md",
        content: "updated",
        expectedUpdatedAt: updatedAt,
      }),
    ).resolves.toMatchObject({ size: 7 });
    await expect(actualFs.readFile(await readRawPath("seed.md"), "utf-8")).resolves.toBe("updated");

    await expect(
      service.writeProjectMemoryFile({
        workspaceId,
        fileName: "seed.md",
        content: "stale write",
        expectedUpdatedAt: updatedAt,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_MEMORY_FILE_CHANGED" });
    await expect(actualFs.readFile(await readRawPath("seed.md"), "utf-8")).resolves.toBe("updated");
  });

  it("拒绝超过 5 MiB、非 .md、路径穿越、Windows 保留名与大小写别名", async () => {
    await writeMemoryFile(workspaceId, "MEMORY.md", "index");
    await writeMemoryFile(workspaceId, "Case.md", "original");
    const service = enabledService();

    await expect(
      service.writeProjectMemoryFile({
        workspaceId,
        fileName: "big.md",
        content: "x".repeat(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED" });
    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "note.txt", content: "x" }),
    ).rejects.toThrow("Invalid Project Memory path");
    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "../escape.md", content: "x" }),
    ).rejects.toThrow("Invalid Project Memory path");
    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "CON.md", content: "x" }),
    ).rejects.toThrow("reserved");
    await expect(
      service.writeProjectMemoryFile({ workspaceId, fileName: "case.md", content: "x" }),
    ).rejects.toThrow("does not match exactly");
  });

  it("删除条目时只摘掉指向它的索引行，其余字节与顺序保持原样", async () => {
    const index = [
      "# Memory",
      "",
      "- [Keep](keep.md) — keep this",
      "- [Gone](gone.md) — remove this",
      "- [Nested](sub/gone.md) — remove this too",
      "",
    ].join("\n");
    await writeMemoryFile(workspaceId, "MEMORY.md", index);
    await writeMemoryFile(workspaceId, "keep.md", "keep");
    await writeMemoryFile(workspaceId, "gone.md", "gone");
    const service = enabledService();
    const { updatedAt } = await service.readProjectMemoryFile({
      workspaceId,
      fileName: "gone.md",
    });

    await expect(
      service.deleteProjectMemoryFile({
        workspaceId,
        fileName: "gone.md",
        expectedUpdatedAt: updatedAt,
      }),
    ).resolves.toEqual({ indexUpdated: true });

    await expect(actualFs.stat(await readRawPath("gone.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(actualFs.readFile(await readRawPath("MEMORY.md"), "utf-8")).resolves.toBe(
      ["# Memory", "", "- [Keep](keep.md) — keep this", ""].join("\n"),
    );
  });

  it("索引里没有指向该条目的链接时删除成功但 indexUpdated=false", async () => {
    await writeMemoryFile(workspaceId, "MEMORY.md", "- [Other](other.md) — other\n");
    await writeMemoryFile(workspaceId, "orphan.md", "orphan");
    const service = enabledService();

    await expect(
      service.deleteProjectMemoryFile({ workspaceId, fileName: "orphan.md" }),
    ).resolves.toEqual({ indexUpdated: false });
    await expect(actualFs.readFile(await readRawPath("MEMORY.md"), "utf-8")).resolves.toBe(
      "- [Other](other.md) — other\n",
    );
  });

  it("索引文件不可删除，删除不存在的条目按 FILE_CHANGED 处理", async () => {
    await writeMemoryFile(workspaceId, "MEMORY.md", "index");
    const service = enabledService();

    await expect(
      service.deleteProjectMemoryFile({ workspaceId, fileName: "MEMORY.md" }),
    ).rejects.toMatchObject({ code: "PROJECT_MEMORY_INDEX_PROTECTED" });
    await expect(
      service.deleteProjectMemoryFile({ workspaceId, fileName: "missing.md" }),
    ).rejects.toMatchObject({ code: "PROJECT_MEMORY_FILE_CHANGED" });
    await expect(actualFs.readFile(await readRawPath("MEMORY.md"), "utf-8")).resolves.toBe("index");
  });

  it("删除的 CAS 同样生效", async () => {
    await writeMemoryFile(workspaceId, "seed.md", "original");
    const service = enabledService();
    const { updatedAt } = await service.readProjectMemoryFile({
      workspaceId,
      fileName: "seed.md",
    });
    await writeFile(await readRawPath("seed.md"), "changed elsewhere", "utf-8");
    await utimes(
      await readRawPath("seed.md"),
      new Date(Date.now() + 5_000),
      new Date(Date.now() + 5_000),
    );

    await expect(
      service.deleteProjectMemoryFile({
        workspaceId,
        fileName: "seed.md",
        expectedUpdatedAt: updatedAt,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_MEMORY_FILE_CHANGED" });
    await expect(actualFs.stat(await readRawPath("seed.md"))).resolves.toBeTruthy();
  });
});
