import { describe, expect, it } from "vitest";
import {
  applyNotebookCellEdit,
  findNotebookCellIndex,
  parseNotebookDocument,
  serializeNotebookDocument,
  toNotebookCells,
  type NotebookCellLike,
} from "../src/tool/notebook/notebookDocument.js";

const SOURCE_NOTEBOOK = JSON.stringify(
  {
    cells: [
      {
        cell_type: "markdown",
        id: "intro",
        metadata: {},
        source: ["# Analysis\n", "hello"],
      },
      {
        cell_type: "code",
        execution_count: 2,
        id: "load",
        metadata: { collapsed: false },
        outputs: [{ name: "stdout", output_type: "stream", text: ["hi\n"] }],
        source: ["print('hi')"],
      },
    ],
    metadata: { kernelspec: { display_name: "Python 3", name: "python3" } },
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1,
);

function parse(text = SOURCE_NOTEBOOK) {
  const parsed = parseNotebookDocument(text);
  if ("ok" in parsed) throw new Error(`expected a parsed notebook, got: ${parsed.message}`);
  return parsed;
}

describe("notebookDocument", () => {
  it("解析后按原缩进/行尾/结尾换行写回，字节与原文一致", () => {
    const parsed = parse();
    expect(parsed.indent).toBe(1);
    expect(parsed.trailingNewline).toBe(false);

    const serialized = serializeNotebookDocument(parsed.document, {
      lineEnding: "\n",
      indent: parsed.indent,
      trailingNewline: parsed.trailingNewline,
    });
    expect(serialized).toBe(SOURCE_NOTEBOOK);
  });

  it("识别原文是否以换行结尾", () => {
    expect(parse(`${SOURCE_NOTEBOOK}\n`).trailingNewline).toBe(true);
  });

  it("拒绝非 nbformat 4、非 JSON 与缺 cells 的文件", () => {
    const nbformat3 = parseNotebookDocument(
      JSON.stringify({ cells: [], nbformat: 3, nbformat_minor: 0 }),
    );
    expect(nbformat3).toMatchObject({ ok: false });
    expect((nbformat3 as { message: string }).message).toContain("only nbformat 4");

    expect(parseNotebookDocument("{not json")).toMatchObject({ ok: false });
    expect(parseNotebookDocument(JSON.stringify({ nbformat: 4 }))).toMatchObject({ ok: false });
  });

  it("replace 只改目标 cell，并清空 code cell 的 outputs/execution_count", () => {
    const parsed = parse();
    const result = applyNotebookCellEdit(parsed.document.cells, { cellId: "load" }, {
      mode: "replace",
      newSource: "print('bye')",
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.cellIndex).toBe(1);
    expect(result.cellId).toBe("load");
    const [markdown, code] = result.cells;
    // 其他 cell 原样保留（同一引用）。
    expect(markdown).toBe(parsed.document.cells[0]);
    expect(code).toMatchObject({
      cell_type: "code",
      execution_count: null,
      id: "load",
      metadata: { collapsed: false },
      outputs: [],
      // 原 cell 用逐行数组存 source，替换后保持同一形态。
      source: ["print('bye')"],
    });
  });

  it("replace 保留 source 的逐行数组形态与行尾换行", () => {
    const parsed = parse();
    const result = applyNotebookCellEdit(parsed.document.cells, { cellIndex: 0 }, {
      mode: "replace",
      newSource: "line1\nline2\nline3",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.cells[0]?.source).toEqual(["line1\n", "line2\n", "line3"]);
  });

  it("insert 在指定下标插入，使用该 notebook 的 cell id 约定", () => {
    const parsed = parse();
    const result = applyNotebookCellEdit(parsed.document.cells, { cellIndex: 1 }, {
      mode: "insert",
      newSource: "x = 1",
      cellType: "code",
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.cellIndex).toBe(1);
    expect(result.cells).toHaveLength(3);
    const inserted = result.cells[1] as NotebookCellLike;
    expect(inserted).toMatchObject({ cell_type: "code", source: "x = 1", outputs: [] });
    expect(typeof inserted.id).toBe("string");
    expect(result.cellId).toBe(inserted.id);
  });

  it("insert 未给下标时追加到末尾；delete 按 id 删除", () => {
    const parsed = parse();
    const appended = applyNotebookCellEdit(parsed.document.cells, {}, {
      mode: "insert",
      newSource: "tail",
      cellType: "markdown",
    });
    if ("error" in appended) throw new Error(appended.error);
    expect(appended.cellIndex).toBe(2);
    expect(appended.cells).toHaveLength(3);

    const deleted = applyNotebookCellEdit(parsed.document.cells, { cellId: "intro" }, {
      mode: "delete",
    });
    if ("error" in deleted) throw new Error(deleted.error);
    expect(deleted.cells.map((cell) => cell.id)).toEqual(["load"]);
  });

  it("选择器错误被描述清楚而不是抛异常", () => {
    expect(findNotebookCellIndex(parse().document.cells, {})).toEqual({
      error: "Provide cell_id or cell_index",
    });
    expect(findNotebookCellIndex(parse().document.cells, { cellId: "nope" })).toEqual({
      error: "No notebook cell with id nope",
    });
    expect(findNotebookCellIndex(parse().document.cells, { cellIndex: 9 })).toMatchObject({
      error: expect.stringContaining("out of range"),
    });
    expect(applyNotebookCellEdit(parse().document.cells, { cellId: "nope" }, {
      mode: "replace",
      newSource: "x",
    })).toMatchObject({ error: expect.stringContaining("No notebook cell") });
  });

  it("Read 侧投影保留 raw cell 与数组下标，并抽取 code 输出", () => {
    const parsed = parse(
      JSON.stringify({
        cells: [
          {
            cell_type: "markdown",
            id: "m",
            metadata: {},
            source: "# title",
          },
          { cell_type: "raw", id: "r", metadata: {}, source: "raw text" },
          {
            cell_type: "code",
            execution_count: 1,
            id: "c",
            metadata: {},
            outputs: [
              { name: "stdout", output_type: "stream", text: ["a\n", "b\n"] },
              { output_type: "execute_result", data: { "text/plain": ["42"] } },
              {
                ename: "ValueError",
                evalue: "bad",
                output_type: "error",
                traceback: ["ValueError: bad"],
              },
            ],
            source: "1/0",
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );

    expect(toNotebookCells(parsed.document)).toEqual([
      { cellType: "markdown", source: "# title", cellId: "m" },
      { cellType: "raw", source: "raw text", cellId: "r" },
      {
        cellType: "code",
        source: "1/0",
        cellId: "c",
        outputs: [
          { type: "stream", text: "a\nb\n" },
          { type: "execute_result", text: "42" },
          { type: "error", text: "ValueError: bad\nValueError: bad" },
        ],
      },
    ]);
  });
});
