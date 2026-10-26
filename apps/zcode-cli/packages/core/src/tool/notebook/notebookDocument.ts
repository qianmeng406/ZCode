/**
 * .ipynb 的最小结构化读写：只负责"读懂 cell、改一个 cell、按原样写回"。
 *
 * 为什么要独立成纯模块：NotebookEdit 的正确性几乎全在格式保真上（其它 cell、metadata、
 * nbformat 版本、行尾、缩进都必须原样保留），而文件 I/O 与权限走通用工具链。放在这里可以
 * 用表格驱动的单测把边界钉死，不依赖 fileSystemPort。
 */

import type { CellOutput, NotebookCell } from "@zcode/contracts";

export interface NotebookCellLike {
  cell_type: string;
  id?: string;
  source?: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

export interface NotebookDocument {
  cells: NotebookCellLike[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

export interface NotebookParseResult {
  document: NotebookDocument;
  /** 文件原始行尾，写回时保持。 */
  lineEnding: "\n" | "\r\n";
  /** 原始缩进宽度（Jupyter 默认 1），写回时保持。 */
  indent: number;
  /** 原文是否以换行结尾。 */
  trailingNewline: boolean;
}

export type NotebookParseFailure = { ok: false; message: string };

export type NotebookCellSelector = { cellId?: string; cellIndex?: number };

export type NotebookCellOperation =
  | { mode: "replace"; newSource: string }
  | { mode: "insert"; newSource: string; cellType: "code" | "markdown" }
  | { mode: "delete" };

export type NotebookEditResult =
  | {
      cells: NotebookCellLike[];
      cellId?: string;
      cellIndex: number;
    }
  | { error: string };

export function parseNotebookDocument(text: string): NotebookParseResult | NotebookParseFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `Notebook is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: "Notebook root must be a JSON object" };
  }
  if (parsed.nbformat !== undefined && parsed.nbformat !== 4) {
    return {
      ok: false,
      message: `Unsupported notebook format ${String(parsed.nbformat)}; only nbformat 4 is supported`,
    };
  }
  if (!Array.isArray(parsed.cells)) {
    return { ok: false, message: "Notebook has no cells array" };
  }
  const cells = parsed.cells.filter(isRecord) as NotebookCellLike[];
  if (cells.length !== parsed.cells.length) {
    return { ok: false, message: "Notebook contains a malformed cell" };
  }
  const indentMatch = /^\{\r?\n( +)"/.exec(text);
  return {
    document: { ...parsed, cells },
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    indent: indentMatch?.[1]?.length ?? 1,
    trailingNewline: text.endsWith("\n"),
  };
}

export function serializeNotebookDocument(
  document: NotebookDocument,
  options: { lineEnding: "\n" | "\r\n"; indent: number; trailingNewline: boolean },
): string {
  const serialized = JSON.stringify(document, null, options.indent);
  const withLineEndings =
    options.lineEnding === "\r\n" ? serialized.replace(/\n/g, "\r\n") : serialized;
  return options.trailingNewline ? `${withLineEndings}${options.lineEnding}` : withLineEndings;
}

export function readCellSource(cell: NotebookCellLike): string {
  if (Array.isArray(cell.source)) return cell.source.join("");
  return typeof cell.source === "string" ? cell.source : "";
}

export function findNotebookCellIndex(
  cells: readonly NotebookCellLike[],
  selector: NotebookCellSelector,
): number | { error: string } {
  if (selector.cellId !== undefined) {
    const index = cells.findIndex((cell) => cell.id === selector.cellId);
    if (index < 0) return { error: `No notebook cell with id ${selector.cellId}` };
    return index;
  }
  if (selector.cellIndex !== undefined) {
    if (selector.cellIndex < 0 || selector.cellIndex > cells.length) {
      return {
        error: `cell_index ${selector.cellIndex} is out of range (notebook has ${cells.length} cells)`,
      };
    }
    return selector.cellIndex;
  }
  return { error: "Provide cell_id or cell_index" };
}

/**
 * 应用一次 cell 级修改。返回新的 cells 数组（不修改入参），由调用方负责序列化整份文档。
 */
export function applyNotebookCellEdit(
  cells: readonly NotebookCellLike[],
  selector: NotebookCellSelector,
  operation: NotebookCellOperation,
  options: { createCellId?: () => string } = {},
): NotebookEditResult {
  if (operation.mode === "insert") {
    const index =
      selector.cellId !== undefined
        ? findNotebookCellIndex(cells, selector)
        : (selector.cellIndex ?? cells.length);
    if (typeof index !== "number") return index;
    const insertAt = selector.cellId !== undefined ? index + 1 : Math.min(index, cells.length);
    if (insertAt > cells.length) {
      return { error: `cell_index ${insertAt} is out of range (notebook has ${cells.length} cells)` };
    }
    const nextCell: NotebookCellLike = {
      cell_type: operation.cellType,
      source: operation.newSource,
      metadata: {},
    };
    // nbformat 4.5+ 要求 code cell 带 id；缺 id 会在 Jupyter 里被当作非法 notebook。
    const needsId =
      cells.some((cell) => typeof cell.id === "string") || options.createCellId !== undefined;
    if (needsId) {
      nextCell.id = options.createCellId?.() ?? randomCellId();
    }
    if (operation.cellType === "code") {
      nextCell.outputs = [];
      nextCell.execution_count = null;
    }
    const next = [...cells.slice(0, insertAt), nextCell, ...cells.slice(insertAt)];
    return {
      cells: next,
      cellIndex: insertAt,
      ...(nextCell.id === undefined ? {} : { cellId: nextCell.id }),
    };
  }

  const index = findNotebookCellIndex(cells, selector);
  if (typeof index !== "number") return index;
  const target = cells[index];
  if (!target) {
    return { error: `cell_index ${index} is out of range (notebook has ${cells.length} cells)` };
  }

  if (operation.mode === "delete") {
    return {
      cells: [...cells.slice(0, index), ...cells.slice(index + 1)],
      cellIndex: index,
      ...(target.id === undefined ? {} : { cellId: target.id }),
    };
  }

  const nextCell: NotebookCellLike = {
    ...target,
    source: Array.isArray(target.source)
      ? toLineArray(operation.newSource)
      : operation.newSource,
  };
  // 替换源码后旧输出已失效；保留它们会让 notebook 显示与代码不符的结果。
  if (target.cell_type === "code") {
    nextCell.outputs = [];
    nextCell.execution_count = null;
  }
  return {
    cells: [...cells.slice(0, index), nextCell, ...cells.slice(index + 1)],
    cellIndex: index,
    ...(target.id === undefined ? {} : { cellId: target.id }),
  };
}

function toLineArray(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split("\n");
  return lines.map((line, index) => (index === lines.length - 1 ? line : `${line}\n`));
}

/**
 * Read 侧投影：把 cell 转成 provider-visible 的 `NotebookCell`。
 *
 * 保留 raw cell 而不是过滤掉——Read 输出的数组下标就是 file 里的 cell_index，
 * 少一个元素会让模型后续的 NotebookEdit 打错 cell。
 */
export function toNotebookCells(document: NotebookDocument): NotebookCell[] {
  return document.cells.map((cell) => {
    const cellType =
      cell.cell_type === "markdown" || cell.cell_type === "raw" ? cell.cell_type : "code";
    const outputs = cellType === "code" ? extractCellOutputs(cell.outputs) : [];
    return {
      cellType,
      source: readCellSource(cell),
      ...(typeof cell.id === "string" ? { cellId: cell.id } : {}),
      ...(outputs.length > 0 ? { outputs } : {}),
    };
  });
}

function extractCellOutputs(outputs: unknown): CellOutput[] {
  if (!Array.isArray(outputs)) return [];
  const extracted: CellOutput[] = [];
  for (const raw of outputs) {
    if (!isRecord(raw)) continue;
    const outputType = raw.output_type;
    if (outputType === "stream") {
      extracted.push({ type: "stream", text: textOf(raw.text) });
      continue;
    }
    if (outputType === "error") {
      const ename = typeof raw.ename === "string" ? raw.ename : "Error";
      const evalue = typeof raw.evalue === "string" ? raw.evalue : "";
      const traceback = Array.isArray(raw.traceback) ? raw.traceback.filter(isText) : [];
      const headline = `${ename}: ${evalue}`.trim();
      extracted.push({ type: "error", text: [headline, ...traceback].join("\n") });
      continue;
    }
    if (outputType === "execute_result" || outputType === "display_data") {
      const data = isRecord(raw.data) ? raw.data : {};
      extracted.push({ type: outputType, text: textOf(data["text/plain"]) });
    }
  }
  return extracted;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(isText).join("");
  return "";
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function randomCellId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
