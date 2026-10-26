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
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
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

function createMemoryFileSystem(initial: Record<string, string>): MemoryFileSystem {
  const files = new Map(Object.entries(initial));
  const written: string[] = [];
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

describe("ApplyPatch registration", () => {
  it("默认不注册，只有显式打开 fork 开关才进入工具面", () => {
    const off = createToolRegistry();
    registerBuiltInTools(off);
    expect(off.has("ApplyPatch")).toBe(false);

    const on = createToolRegistry();
    registerBuiltInTools(on, { includeApplyPatch: true });
    expect(on.has("ApplyPatch")).toBe(true);
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
        createReadFileStateKey(fileB, 1, undefined),
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

    expect(readFileState.get(createReadFileStateKey(fileA, 1, undefined))).toMatchObject({
      path: fileA,
      content: "one\nchanged\n",
      sourceTool: "ApplyPatch",
    });
    expect(readFileState.get(createReadFileStateKey(fileC, 1, undefined))).toMatchObject({
      path: fileC,
      content: "created\n",
      sourceTool: "ApplyPatch",
    });
    expect(readFileState.has(createReadFileStateKey(fileB, 1, undefined))).toBe(false);
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
