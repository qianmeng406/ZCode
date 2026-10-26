import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, registerBuiltInTools } from "../src/tool/index.js";
import { notebookEditToolEntry } from "../src/tool/handlers/notebook-edit.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { getFileMutationCheckpointCandidates } from "../src/runtime/helpers/rewind.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const NOTEBOOK = JSON.stringify(
  {
    cells: [
      { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Analysis"] },
      {
        cell_type: "code",
        execution_count: 1,
        id: "load",
        metadata: {},
        outputs: [{ name: "stdout", output_type: "stream", text: ["old\n"] }],
        source: ["print('old')"],
      },
    ],
    metadata: { kernelspec: { display_name: "Python 3", name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1,
);

const READ_REVISION = { id: "rev-1", mtimeMs: 1_000, sizeBytes: NOTEBOOK.length };
const WRITE_REVISION = { id: "rev-2", mtimeMs: 2_000, sizeBytes: NOTEBOOK.length };

interface Writer {
  readTextFile: ReturnType<typeof vi.fn>;
  writeTextFile: ReturnType<typeof vi.fn>;
  writes: Array<Record<string, unknown>>;
}

function createFileSystem(
  overrides: { content?: string; lineEndings?: "LF" | "CRLF" } = {},
): Writer {
  const writes: Array<Record<string, unknown>> = [];
  const readTextFile = vi.fn(async () => ({
    path: "/workspace/analysis.ipynb",
    content: overrides.content ?? NOTEBOOK,
    encoding: "utf8" as const,
    lineEndings: overrides.lineEndings ?? ("LF" as const),
    bytesRead: NOTEBOOK.length,
    sizeBytes: NOTEBOOK.length,
    truncated: false,
    revision: READ_REVISION,
  }));
  const writeTextFile = vi.fn(async (request: Record<string, unknown>) => {
    writes.push(request);
    return {
      path: request.path,
      bytesWritten: String(request.content ?? "").length,
      revision: WRITE_REVISION,
    };
  });
  return { readTextFile, writeTextFile, writes };
}

function createContext(
  fileSystem: Record<string, unknown>,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool-notebook-edit",
    traceId: "trace-notebook-edit" as never,
    abortSignal: new AbortController().signal,
    model: createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "" }),
      providerId: "zai-api",
      modelId: "GLM-5",
    }),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: "sess-notebook-edit" as never,
    fileSystemPort: fileSystem as never,
    ...overrides,
  } as ToolExecutionContext;
}

async function runEdit(input: unknown, context: ToolExecutionContext) {
  return (await notebookEditToolEntry.handler!(input, context)) as Record<string, unknown>;
}

describe("NotebookEdit tool", () => {
  it("默认不注册，只有显式打开 fork 开关才进入工具面", () => {
    const off = createToolRegistry();
    registerBuiltInTools(off);
    expect(off.has("NotebookEdit")).toBe(false);

    const on = createToolRegistry();
    registerBuiltInTools(on, { includeNotebookEdit: true });
    expect(on.has("NotebookEdit")).toBe(true);
  });

  it("replace 以原缩进写回，输出带 rewind 需要的字段，并刷新 readFileState", async () => {
    const fileSystem = createFileSystem();
    const readFileState = new Map<string, ReadFileStateEntry>();
    const metadata: unknown[] = [];
    const context = createContext(fileSystem, {
      readFileState,
      recordReadFileStateMetadata: (value) => metadata.push(value),
    });

    const result = await runEdit(
      {
        file_path: "/workspace/analysis.ipynb",
        edit_mode: "replace",
        cell_id: "load",
        new_source: "print('new')",
      },
      context,
    );

    expect(result).toMatchObject({
      filePath: "/workspace/analysis.ipynb",
      originalFile: NOTEBOOK,
      cellId: "load",
      cellIndex: 1,
      changedCells: 1,
    });
    expect(Array.isArray(result.structuredPatch)).toBe(true);
    expect((result.structuredPatch as unknown[]).length).toBeGreaterThan(0);

    const written = fileSystem.writes[0] ?? {};
    expect(written).toMatchObject({
      // resolveWorkspacePath 用宿主 path 语义（Windows 测试机上分隔符为 `\`）。
      path: expect.stringContaining("analysis.ipynb"),
      encoding: "utf8",
      lineEndings: "LF",
      atomic: true,
      createParents: false,
      expectedRevision: READ_REVISION,
    });
    expect(written.content).toBe(result.content);
    // 写回的 JSON 保留 1 空格缩进，且目标 cell 的输出被清空。
    expect(String(written.content)).toContain('\n "cells": [\n  {\n   "cell_type": "markdown"');
    const writtenNotebook = JSON.parse(String(written.content)) as {
      cells: Array<Record<string, unknown>>;
    };
    expect(writtenNotebook.cells[1]).toMatchObject({
      // 原 cell 用逐行数组存 source，写回时保持同一形态。
      source: ["print('new')"],
      outputs: [],
      execution_count: null,
    });

    const entry = [...readFileState.values()][0];
    expect(entry).toMatchObject({
      path: expect.stringContaining("analysis.ipynb"),
      content: result.content,
      sourceTool: "NotebookEdit",
      revisionId: "rev-2",
      mtimeMs: 2_000,
    });
    expect(metadata[0]).toMatchObject({
      tool: "NotebookEdit",
      path: expect.stringContaining("analysis.ipynb"),
      revisionId: "rev-2",
    });
  });

  it("写回时保留原文件的行尾风格（由 writeTextFile 还原 CRLF）", async () => {
    const fileSystem = createFileSystem({ lineEndings: "CRLF" });
    const context = createContext(fileSystem);

    await runEdit(
      {
        file_path: "/workspace/analysis.ipynb",
        edit_mode: "delete",
        cell_id: "intro",
      },
      context,
    );

    const written = fileSystem.writes[0] ?? {};
    expect(written.lineEndings).toBe("CRLF");
    // 端口约定：content 始终是 LF 归一化文本。
    expect(String(written.content)).not.toContain("\r\n");
    const writtenNotebook = JSON.parse(String(written.content)) as { cells: unknown[] };
    expect(writtenNotebook.cells).toHaveLength(1);
  });

  it("输出能命中 rewind 的 checkpoint 候选判定", async () => {
    const context = createContext(createFileSystem());
    const result = await runEdit(
      {
        file_path: "/workspace/analysis.ipynb",
        edit_mode: "insert",
        cell_index: 1,
        new_source: "x = 1",
      },
      context,
    );

    expect(getFileMutationCheckpointCandidates(result)).toMatchObject([
      {
        filePath: "/workspace/analysis.ipynb",
        originalFile: NOTEBOOK,
      },
    ]);
  });

  it("业务失败用 code + message 表达，不写文件", async () => {
    const fileSystem = createFileSystem();
    const context = createContext(fileSystem);

    await expect(
      runEdit({ file_path: "/workspace/notes.md", edit_mode: "insert", new_source: "x" }, context),
    ).resolves.toMatchObject({ result: false, message: expect.stringContaining(".ipynb") });

    await expect(
      runEdit({ file_path: "/workspace/analysis.ipynb", edit_mode: "insert" }, context),
    ).resolves.toMatchObject({ result: false, message: expect.stringContaining("new_source") });

    await expect(
      runEdit(
        {
          file_path: "/workspace/analysis.ipynb",
          edit_mode: "replace",
          cell_id: "ghost",
          new_source: "x",
        },
        context,
      ),
    ).resolves.toMatchObject({ result: false, errorCode: 2 });

    expect(fileSystem.writeTextFile).not.toHaveBeenCalled();
  });

  it("非法 notebook 与不可读文件都退回业务失败而不是抛异常", async () => {
    const invalid = createFileSystem({ content: '{"cells": [], "nbformat": 3}' });
    await expect(
      runEdit(
        { file_path: "/workspace/analysis.ipynb", edit_mode: "delete", cell_index: 0 },
        createContext(invalid),
      ),
    ).resolves.toMatchObject({ result: false, errorCode: 1 });

    const missing = {
      readTextFile: vi.fn(async () => {
        throw new Error("ENOENT: no such file");
      }),
      writeTextFile: vi.fn(),
    };
    await expect(
      runEdit(
        { file_path: "/workspace/analysis.ipynb", edit_mode: "delete", cell_index: 0 },
        createContext(missing),
      ),
    ).resolves.toMatchObject({ result: false, errorCode: 3 });
  });
});

describe("Read .ipynb rendering", () => {
  function createReadContext(providerVisibleToolNames: readonly string[]) {
    const readTextFile = vi.fn(async () => ({
      path: "/workspace/analysis.ipynb",
      content: NOTEBOOK,
      encoding: "utf8" as const,
      lineEndings: "LF" as const,
      bytesRead: NOTEBOOK.length,
      sizeBytes: NOTEBOOK.length,
      truncated: false,
      revision: READ_REVISION,
    }));
    const readTextFileRange = vi.fn(async () => ({
      path: "/workspace/analysis.ipynb",
      content: NOTEBOOK,
      encoding: "utf8" as const,
      lineEndings: "LF" as const,
      bytesRead: NOTEBOOK.length,
      sizeBytes: NOTEBOOK.length,
      truncated: false,
      startLine: 1,
      lineCount: NOTEBOOK.split("\n").length,
      totalLines: NOTEBOOK.split("\n").length,
      revision: READ_REVISION,
    }));
    const context = createContext(
      {
        stat: vi.fn(async () => ({
          path: "/workspace/analysis.ipynb",
          kind: "file",
          sizeBytes: NOTEBOOK.length,
          mtimeMs: 1_000,
          revision: READ_REVISION,
        })),
        readTextFile,
        readTextFileRange,
      },
      { providerVisibleToolNames },
    );
    return { context, readTextFile, readTextFileRange };
  }

  it("开关打开时把 notebook 渲染成带 cell id 的结构化结果", async () => {
    const { context, readTextFileRange } = createReadContext(["Read", "NotebookEdit"]);
    const output = (await readToolEntry.handler!(
      { file_path: "/workspace/analysis.ipynb" },
      context,
    )) as Record<string, unknown>;

    expect(output.type).toBe("notebook");
    expect(output.cells).toMatchObject([
      { cellType: "markdown", source: "# Analysis", cellId: "intro" },
      { cellType: "code", source: "print('old')", cellId: "load" },
    ]);
    expect(readTextFileRange).not.toHaveBeenCalled();

    const modelContent = readToolEntry.formatModelContent?.(output);
    expect(String(modelContent)).toContain('<cell index="1" id="load" type="code">');
    expect(String(modelContent)).toContain("[stream] old");
  });

  it("开关关闭时继续按 JSON 文本读取", async () => {
    const { context, readTextFileRange } = createReadContext(["Read"]);
    const output = (await readToolEntry.handler!(
      { file_path: "/workspace/analysis.ipynb" },
      context,
    )) as Record<string, unknown>;

    expect(output.type).toBe("text");
    expect(readTextFileRange).toHaveBeenCalledTimes(1);
  });
});
