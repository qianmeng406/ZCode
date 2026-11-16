import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileSystemError,
  type ApplyPatchOutput,
  type FileSystemPort,
  type FileSystemRevision,
} from "@zcode/contracts";
import { applyPatchHandler } from "../src/tool/handlers/apply-patch.js";
import { createToolRegistry, registerBuiltInTools } from "../src/tool/index.js";
import {
  getFileMutationCheckpointCandidates,
  stringifyWorkspaceCheckpointArtifact,
} from "../src/runtime/helpers/rewind.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const workspaceRoot = resolve("/work");
const fileA = join(workspaceRoot, "a.txt");
const fileB = join(workspaceRoot, "b.txt");
const fileC = join(workspaceRoot, "c.txt");
const movedA = join(workspaceRoot, "a-moved.txt");

interface MemoryFileSystem {
  files: Map<string, string>;
  port: FileSystemPort;
  written: string[];
}

function revisionFor(path: string, content: string): FileSystemRevision {
  return { id: `rev:${path}:${content.length}`, sizeBytes: content.length, mtimeMs: 1 };
}

function createMemoryFileSystem(
  initial: Record<string, string>,
  options: { failWritePaths?: readonly string[] } = {},
): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const written: string[] = [];
  const failWritePaths = new Set(options.failWritePaths ?? []);
  const port = {
    async stat(request: { path: string }) {
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          message: `missing: ${request.path}`,
          path: request.path,
        });
      }
      return {
        path: request.path,
        kind: "file" as const,
        sizeBytes: content.length,
        mtimeMs: 1,
        revision: revisionFor(request.path, content),
      };
    },
    async readTextFile(request: { path: string }) {
      const content = files.get(request.path);
      if (content === undefined) {
        throw createFileSystemError({
          code: "not_found",
          message: `missing: ${request.path}`,
          path: request.path,
        });
      }
      return {
        path: request.path,
        content,
        encoding: "utf8" as const,
        lineEndings: "LF" as const,
        bytesRead: content.length,
        sizeBytes: content.length,
        truncated: false,
        revision: revisionFor(request.path, content),
      };
    },
    async writeTextFile(request: { path: string; content: string }) {
      if (failWritePaths.has(request.path)) {
        throw createFileSystemError({
          code: "io_error",
          message: `write failed: ${request.path}`,
          path: request.path,
        });
      }
      files.set(request.path, request.content);
      written.push(request.path);
      return {
        path: request.path,
        bytesWritten: request.content.length,
        revision: revisionFor(request.path, request.content),
      };
    },
    async removeFile(request: { path: string }) {
      return { path: request.path, removed: files.delete(request.path) };
    },
  } as unknown as FileSystemPort;
  return { files, port, written };
}

function createContext(
  fileSystem: MemoryFileSystem,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool-apply-patch",
    traceId: "trace-apply-patch" as never,
    abortSignal: new AbortController().signal,
    model: createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "" }),
      providerId: "zai-api",
      modelId: "GLM-5",
    }),
    workingDirectory: workspaceRoot,
    workspaceRoot,
    sessionId: "sess-apply-patch" as never,
    fileSystemPort: fileSystem.port,
    ...overrides,
  } as ToolExecutionContext;
}

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

// 2026-11-15 决定把 ApplyPatch 还给上游的休眠状态（handlers/index.ts 注释掉注册），
// fork 不再提供该开关。这里锁住「永不注册」：休眠实现若被人顺手放回注册表，
// 会让一个没写进提示词、没经过验收的工具突然出现在模型工具面上。
describe("ApplyPatch registration", () => {
  it("不进入内置工具表，注册表里查不到", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    expect(registry.has("ApplyPatch")).toBe(false);
  });
});

describe("ApplyPatch integration", () => {
  it("多文件补丁逐文件给出 before/after，并刷新 readFileState", async () => {
    const fileSystem = createMemoryFileSystem({
      [fileA]: "one\ntwo\n",
      [fileB]: "bye\n",
    });
    const readFileState = new Map<string, ReadFileStateEntry>([
      [
        createReadFileStatePathKey(fileB),
        {
          path: fileB,
          content: "bye\n",
          offset: undefined,
          limit: undefined,
          isPartialView: false,
          readAt: new Date(0),
          sourceTool: "Read",
        },
      ],
    ]);

    const output = (await applyPatchHandler(
      {
        patch_text: patch(
          `*** Update File: ${fileA}`,
          "@@",
          "-two",
          "+changed",
          `*** Add File: ${fileC}`,
          "+created",
          `*** Delete File: ${fileB}`,
        ),
      },
      createContext(fileSystem, { readFileState }),
    )) as ApplyPatchOutput;

    expect(fileSystem.files.get(fileA)).toBe("one\nchanged\n");
    expect(fileSystem.files.get(fileC)).toBe("created\n");
    expect(fileSystem.files.has(fileB)).toBe(false);

    expect(output.files[0]).toMatchObject({
      filePath: fileA,
      type: "update",
      originalFile: "one\ntwo\n",
      content: "one\nchanged\n",
    });
    expect(output.files[1]).toMatchObject({
      filePath: fileC,
      type: "add",
      originalFile: null,
      content: "created\n",
    });
    expect(output.files[2]).toMatchObject({
      filePath: fileB,
      type: "delete",
      originalFile: "bye\n",
      content: null,
    });

    expect(readFileState.get(createReadFileStatePathKey(fileA))).toMatchObject({
      path: fileA,
      content: "one\nchanged\n",
      sourceTool: "ApplyPatch",
    });
    expect(readFileState.get(createReadFileStatePathKey(fileC))).toMatchObject({
      path: fileC,
      content: "created\n",
      sourceTool: "ApplyPatch",
    });
    expect(readFileState.has(createReadFileStatePathKey(fileB))).toBe(false);
  });

  it("写入中途失败时回滚已应用的文件，工作区回到补丁前", async () => {
    const fileSystem = createMemoryFileSystem(
      { [fileA]: "one\ntwo\n", [fileB]: "bye\n" },
      { failWritePaths: [fileC] },
    );

    await expect(
      applyPatchHandler(
        {
          patch_text: patch(
            `*** Update File: ${fileA}`,
            "@@",
            "-two",
            "+changed",
            `*** Add File: ${fileC}`,
            "+created",
          ),
        },
        createContext(fileSystem),
      ),
    ).rejects.toThrow(/all changes were rolled back/);

    expect(fileSystem.files.get(fileA)).toBe("one\ntwo\n");
    expect(fileSystem.files.has(fileC)).toBe(false);
    expect(fileSystem.files.get(fileB)).toBe("bye\n");
  });

  it("纯重命名：只有 movePath 没有 hunk 也能应用", async () => {
    const fileSystem = createMemoryFileSystem({ [fileA]: "one\ntwo\n" });

    const output = (await applyPatchHandler(
      { patch_text: patch(`*** Update File: ${fileA}`, `*** Move to: ${movedA}`) },
      createContext(fileSystem),
    )) as ApplyPatchOutput;

    expect(fileSystem.files.has(fileA)).toBe(false);
    expect(fileSystem.files.get(movedA)).toBe("one\ntwo\n");
    expect(output.files[0]).toMatchObject({
      filePath: fileA,
      type: "move",
      movePath: movedA,
      originalFile: "one\ntwo\n",
      content: "one\ntwo\n",
    });
  });

  it("rewind 候选覆盖全部文件，删除项以 content=null 表示文件不再存在", async () => {
    const fileSystem = createMemoryFileSystem({ [fileA]: "one\ntwo\n", [fileB]: "bye\n" });
    const output = (await applyPatchHandler(
      {
        patch_text: patch(
          `*** Update File: ${fileA}`,
          "@@",
          "-two",
          "+changed",
          `*** Delete File: ${fileB}`,
        ),
      },
      createContext(fileSystem),
    )) as ApplyPatchOutput;

    const candidates = getFileMutationCheckpointCandidates(output);
    expect(candidates).toMatchObject([
      { filePath: fileA, originalFile: "one\ntwo\n", content: "one\nchanged\n" },
      { filePath: fileB, originalFile: "bye\n", content: null },
    ]);

    const artifact = JSON.parse(
      stringifyWorkspaceCheckpointArtifact(candidates, {
        toolCallId: "tool-apply-patch",
        toolName: "ApplyPatch",
        success: true,
      } as never),
    ) as { files: Array<Record<string, unknown>> };
    expect(artifact.files[1]).toMatchObject({
      path: fileB,
      existedBefore: true,
      beforeContent: "bye\n",
      afterContent: null,
    });
  });

  it("move 展开成「源文件消失 + 目标文件新建」两条候选", async () => {
    const fileSystem = createMemoryFileSystem({ [fileA]: "one\ntwo\n" });
    const output = (await applyPatchHandler(
      {
        patch_text: patch(
          `*** Update File: ${fileA}`,
          `*** Move to: ${movedA}`,
          "@@",
          "-two",
          "+changed",
        ),
      },
      createContext(fileSystem),
    )) as ApplyPatchOutput;

    expect(fileSystem.files.has(fileA)).toBe(false);
    expect(fileSystem.files.get(movedA)).toBe("one\nchanged\n");
    expect(output.files[0]).toMatchObject({
      type: "move",
      movePath: movedA,
      content: "one\nchanged\n",
    });

    expect(getFileMutationCheckpointCandidates(output)).toMatchObject([
      { filePath: fileA, originalFile: "one\ntwo\n", content: null },
      { filePath: movedA, originalFile: null, content: "one\nchanged\n" },
    ]);
  });
});
