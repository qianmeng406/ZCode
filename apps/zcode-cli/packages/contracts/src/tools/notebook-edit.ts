import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { EditDiffHunkSchema } from "./edit.js";

export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";

export const NOTEBOOK_EDIT_PROVIDER_DESCRIPTION = `Edit a Jupyter notebook (.ipynb) cell by cell. Edit and Write refuse notebooks; use this tool instead.

- edit_mode="replace": replace the source of the cell identified by cell_id (preferred) or cell_index (0-based). Replacing a code cell clears its outputs and execution count.
- edit_mode="insert": insert a new cell at cell_index (0-based), or after cell_id when given. new_source is required; cell_type defaults to "code".
- edit_mode="delete": remove the cell identified by cell_id or cell_index.

Everything outside the targeted cells (other cells, metadata, notebook format version) is preserved. Use Read first to see cell ids and indexes; Read renders notebooks cell-by-cell when the feature is enabled.`;

export const NOTEBOOK_EDIT_MODES = ["replace", "insert", "delete"] as const;
export const NOTEBOOK_CELL_TYPES = ["code", "markdown"] as const;

export const NotebookEditInputSchema = z
  .object({
    file_path: z.string().min(1).describe("Absolute or workspace-relative path to the .ipynb file"),
    edit_mode: z.enum(NOTEBOOK_EDIT_MODES).describe("replace, insert, or delete a cell"),
    cell_id: z
      .string()
      .min(1)
      .optional()
      .describe("Target cell id from Read; preferred over cell_index"),
    cell_index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("0-based cell position; for insert, the slot the new cell occupies"),
    new_source: z
      .string()
      .optional()
      .describe("New cell source; required for replace and insert"),
    cell_type: z
      .enum(NOTEBOOK_CELL_TYPES)
      .optional()
      .describe('Cell type for insert; defaults to "code"'),
  })
  .strict();

export type NotebookEditInput = z.infer<typeof NotebookEditInputSchema>;

export const NotebookEditInputJsonSchema = toToolJsonSchema(NotebookEditInputSchema);

export const NotebookEditOutputSchema = z
  .object({
    filePath: z.string(),
    originalFile: z.string(),
    content: z.string(),
    structuredPatch: z.array(EditDiffHunkSchema),
    /** 被修改/插入/删除的 cell id；新建 cell 在 nbformat 4.5+ 会生成一个。 */
    cellId: z.string().optional(),
    cellIndex: z.number().int().nonnegative().optional(),
    changedCells: z.number().int().nonnegative(),
  })
  .strict();

export type NotebookEditOutput = z.infer<typeof NotebookEditOutputSchema>;

export const NotebookEditOutputJsonSchema = toToolJsonSchema(NotebookEditOutputSchema);
