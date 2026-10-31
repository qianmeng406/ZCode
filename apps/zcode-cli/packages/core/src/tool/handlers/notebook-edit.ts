// ============================================================
// NotebookEdit Tool Handler
// ============================================================

import {
  CoreErrorType,
  NOTEBOOK_EDIT_PROVIDER_DESCRIPTION,
  NOTEBOOK_EDIT_TOOL_NAME,
  NotebookEditInputJsonSchema,
  NotebookEditInputSchema,
  NotebookEditOutputJsonSchema,
  NotebookEditOutputSchema,
  createCoreError,
  type FileSystemReadTextResult,
  type NotebookEditInput,
  type NotebookEditOutput,
} from "@zcode/contracts";
import { createStructuredPatch } from "../diff.js";
import {
  applyNotebookCellEdit,
  parseNotebookDocument,
  serializeNotebookDocument,
  type NotebookCellOperation,
} from "../notebook/notebookDocument.js";
import { resolveWorkspacePath } from "../path-policy.js";
import { createReadFileStatePathKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import type {
  ReadFileStateEntry,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const NOTEBOOK_MAX_BYTES = 10 * 1024 * 1024;
const NOTEBOOK_EDIT_FRESHNESS_SUFFIX =
  " (file state is current in your context — no need to Read it back)";
const NotebookEditErrorCode = {
  INVALID_NOTEBOOK: 1,
  CELL_NOT_FOUND: 2,
  FILE_NOT_FOUND: 3,
  FILE_TOO_LARGE: 4,
  WRITE_FAILED: 5,
} as const;

/**
 * NotebookEdit：按 cell 读写 .ipynb。
 *
 * 与 Edit/Write 的关系：两者继续拒绝 notebook，提示不变；本工具只在开关打开时注册。
 * 输出刻意对齐 Edit（filePath/originalFile/content/structuredPatch），这样
 * `runtime/helpers/rewind.ts` 的 checkpoint 候选判定不需要为 notebook 开特例。
 */
export const notebookEditHandler: ToolHandler = async (input, context) => {
  const parsed = NotebookEditInputSchema.parse(input) as NotebookEditInput;
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for NotebookEdit tool",
      {
        context: { toolCallId: context.toolCallId, toolName: NOTEBOOK_EDIT_TOOL_NAME },
        recoverable: false,
      },
    );
  }
  if (!parsed.file_path.toLowerCase().endsWith(".ipynb")) {
    return notebookEditFailure(
      NotebookEditErrorCode.INVALID_NOTEBOOK,
      "NotebookEdit only accepts .ipynb files; use Edit or Write for other files",
    );
  }
  const operation = resolveNotebookOperation(parsed);
  if ("error" in operation) {
    return notebookEditFailure(NotebookEditErrorCode.INVALID_NOTEBOOK, operation.error);
  }

  const absolutePath = resolveWorkspacePath({
    inputPath: parsed.file_path,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });

  let read: FileSystemReadTextResult;
  try {
    read = await fileSystemPort.readTextFile(
      { path: absolutePath, maxBytes: NOTEBOOK_MAX_BYTES },
      { signal: context.abortSignal },
    );
  } catch (error) {
    return notebookEditFailure(
      NotebookEditErrorCode.FILE_NOT_FOUND,
      `Cannot read notebook ${parsed.file_path}: ${errorMessage(error)}`,
    );
  }
  if (read.truncated) {
    return notebookEditFailure(
      NotebookEditErrorCode.FILE_TOO_LARGE,
      `Notebook ${parsed.file_path} exceeds the ${NOTEBOOK_MAX_BYTES / (1024 * 1024)}MB edit limit`,
    );
  }

  // 端口返回的 content 已归一化为 LF；行尾风格由 writeTextFile 的 lineEndings 还原。
  const originalFile = read.content;
  const parsedNotebook = parseNotebookDocument(originalFile);
  if ("ok" in parsedNotebook) {
    return notebookEditFailure(NotebookEditErrorCode.INVALID_NOTEBOOK, parsedNotebook.message);
  }

  const edited = applyNotebookCellEdit(
    parsedNotebook.document.cells,
    { cellId: parsed.cell_id, cellIndex: parsed.cell_index },
    operation.operation,
  );
  if ("error" in edited) {
    return notebookEditFailure(NotebookEditErrorCode.CELL_NOT_FOUND, edited.error);
  }

  const content = serializeNotebookDocument(
    { ...parsedNotebook.document, cells: edited.cells },
    {
      lineEnding: "\n",
      indent: parsedNotebook.indent,
      trailingNewline: parsedNotebook.trailingNewline,
    },
  );

  try {
    const writeResult = await fileSystemPort.writeTextFile(
      {
        path: absolutePath,
        content,
        encoding: read.encoding,
        lineEndings: read.lineEndings,
        createParents: false,
        atomic: true,
        expectedRevision: read.revision,
      },
      { signal: context.abortSignal },
    );
    const entry = updateReadFileStateAfterNotebookEdit(
      context,
      absolutePath,
      content,
      writeResult.revision,
    );
    recordNotebookReadFileStateMetadata(context, entry);
  } catch (error) {
    return notebookEditFailure(
      NotebookEditErrorCode.WRITE_FAILED,
      `Failed to write notebook ${parsed.file_path}: ${errorMessage(error)}`,
    );
  }

  return {
    filePath: parsed.file_path,
    originalFile,
    content,
    structuredPatch: createStructuredPatch({
      filePath: parsed.file_path,
      oldContent: originalFile,
      newContent: content,
    }),
    ...(edited.cellId === undefined ? {} : { cellId: edited.cellId }),
    cellIndex: edited.cellIndex,
    changedCells: 1,
  } satisfies NotebookEditOutput;
};

function formatNotebookEditModelContent(output: unknown): string {
  const record = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : {};
  const filePath = typeof record.filePath === "string" ? record.filePath : "the notebook";
  const cellIndex = typeof record.cellIndex === "number" ? ` (cell ${record.cellIndex})` : "";
  return `The notebook ${filePath} has been updated${cellIndex}.${NOTEBOOK_EDIT_FRESHNESS_SUFFIX}`;
}

export const notebookEditToolEntry: ToolEntry = {
  capability: "Edit a Jupyter notebook cell by cell through the file-system adapter",
  metadata: {
    shouldDefer: true,
    name: NOTEBOOK_EDIT_TOOL_NAME,
    description: NOTEBOOK_EDIT_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: notebookEditHandler,
  formatModelContent: formatNotebookEditModelContent,
  inputSchema: NotebookEditInputJsonSchema,
  outputSchema: NotebookEditOutputJsonSchema,
  runtimeInputSchema: NotebookEditInputSchema,
  runtimeOutputSchema: NotebookEditOutputSchema,
  permission: {
    permission: "edit",
    reason: "NotebookEdit modifies notebook cells through the file-system adapter",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 1_000_000,
    maxModelBytes: 100_000,
    strategy: "truncate",
    preview: {
      maxBytes: 100_000,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 30_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "NotebookEdit was cancelled before the file operation completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function resolveNotebookOperation(
  input: NotebookEditInput,
): { operation: NotebookCellOperation } | { error: string } {
  if (input.edit_mode === "delete") {
    return { operation: { mode: "delete" } };
  }
  if (input.new_source === undefined) {
    return { error: `edit_mode "${input.edit_mode}" requires new_source` };
  }
  if (input.edit_mode === "replace") {
    return { operation: { mode: "replace", newSource: input.new_source } };
  }
  return {
    operation: {
      mode: "insert",
      newSource: input.new_source,
      cellType: input.cell_type ?? "code",
    },
  };
}

function updateReadFileStateAfterNotebookEdit(
  context: ToolExecutionContext,
  filePath: string,
  content: string,
  revision: FileSystemReadTextResult["revision"],
): ReadFileStateEntry | undefined {
  const readFileState = context.readFileState;
  if (!readFileState) return undefined;
  const entry: ReadFileStateEntry = {
    path: filePath,
    content,
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: NOTEBOOK_EDIT_TOOL_NAME,
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs),
    sizeBytes: revision?.sizeBytes ?? Buffer.byteLength(content, "utf8"),
  };
  readFileState.set(createReadFileStatePathKey(filePath), entry);
  return entry;
}

function recordNotebookReadFileStateMetadata(
  context: ToolExecutionContext,
  entry: ReadFileStateEntry | undefined,
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry?.readAt ?? new Date(),
    entry,
    toolName: NOTEBOOK_EDIT_TOOL_NAME,
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}

function notebookEditFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
