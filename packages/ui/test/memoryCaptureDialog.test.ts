// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_MEMORY_CAPTURE_ERROR, TID_V4_MEMORY_CAPTURE_SAVE } from "@zcode/shared/test-ids";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

import { MemoryCaptureDialog, type MemoryCaptureService } from "@/v4/memory/MemoryCaptureDialog.js";
import type { MemoryCaptureDraft } from "@/v4/memory/memoryCapturePrompt.js";

const WORKSPACE_ID = "repo-1111111111111111";
const DRAFT: MemoryCaptureDraft = {
  name: "Repo rules",
  description: "Use pnpm workspace commands",
  type: "project",
  body: "Run pnpm -w test before committing.",
};

function notFound(fileName: string): Error {
  return Object.assign(new Error(`ENOENT: ${fileName}`), { code: "ENOENT" });
}

function createService(
  options: { index?: string | null; existingFiles?: string[] } = {},
): MemoryCaptureService & { writes: Array<Record<string, unknown>> } {
  const index = options.index === undefined ? "- [Old](old.md)\n" : options.index;
  const existing = new Set(options.existingFiles ?? []);
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    readProjectMemoryFile: vi.fn(async ({ fileName }: { fileName: string }) => {
      if (fileName === "MEMORY.md") {
        if (index === null) throw notFound(fileName);
        return { content: index, updatedAt: 1_000 };
      }
      if (existing.has(fileName)) return { content: "existing", updatedAt: 500 };
      throw notFound(fileName);
    }),
    writeProjectMemoryFile: vi.fn(async (request: Record<string, unknown>) => {
      writes.push(request);
      return { updatedAt: 2_000, size: 10 };
    }),
  } as unknown as MemoryCaptureService & { writes: Array<Record<string, unknown>> };
}

function renderDialog(memoryService: MemoryCaptureService, onSaved = vi.fn()) {
  const onCancel = vi.fn();
  render(
    createElement(MemoryCaptureDialog, {
      open: true,
      workspaceId: WORKSPACE_ID,
      draft: DRAFT,
      memoryService,
      onCancel,
      onSaved,
    }),
  );
  return { onCancel, onSaved };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryCaptureDialog", () => {
  it("先写条目文件再以 CAS 追加索引行", async () => {
    const memoryService = createService();
    const { onSaved } = renderDialog(memoryService);

    fireEvent.click(screen.getByTestId(TID_V4_MEMORY_CAPTURE_SAVE));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ fileName: "repo-rules.md", indexUpdated: true }),
    );
    expect(memoryService.writes).toHaveLength(2);
    expect(memoryService.writes[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      fileName: "repo-rules.md",
    });
    expect(String(memoryService.writes[0]?.content)).toContain('name: "repo-rules"');
    expect(String(memoryService.writes[0]?.content)).toContain(
      'description: "Use pnpm workspace commands"',
    );
    expect(memoryService.writes[1]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      fileName: "MEMORY.md",
      expectedUpdatedAt: 1_000,
    });
    expect(String(memoryService.writes[1]?.content)).toBe(
      "- [Old](old.md)\n- [Repo rules](repo-rules.md) — Use pnpm workspace commands\n",
    );
  });

  it("同名文件已存在时另起 -2，不覆盖既有记忆", async () => {
    const memoryService = createService({ existingFiles: ["repo-rules.md"] });
    const { onSaved } = renderDialog(memoryService);

    fireEvent.click(screen.getByTestId(TID_V4_MEMORY_CAPTURE_SAVE));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ fileName: "repo-rules-2.md", indexUpdated: true }),
    );
  });

  it("还没有索引时新建索引，且不带 CAS", async () => {
    const memoryService = createService({ index: null });
    const { onSaved } = renderDialog(memoryService);

    fireEvent.click(screen.getByTestId(TID_V4_MEMORY_CAPTURE_SAVE));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(memoryService.writes[1]).toMatchObject({ fileName: "MEMORY.md" });
    expect(memoryService.writes[1]).not.toHaveProperty("expectedUpdatedAt");
    expect(String(memoryService.writes[1]?.content)).toBe(
      "# Memory\n\n- [Repo rules](repo-rules.md) — Use pnpm workspace commands\n",
    );
  });

  it("索引 CAS 冲突时提示文件已改动，条目文件保留", async () => {
    const memoryService = createService();
    const onSaved = vi.fn();
    const writeProjectMemoryFile = memoryService.writeProjectMemoryFile as ReturnType<typeof vi.fn>;
    writeProjectMemoryFile.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.fileName === "MEMORY.md") {
        throw Object.assign(new Error("changed"), { code: "PROJECT_MEMORY_FILE_CHANGED" });
      }
      return { updatedAt: 2_000, size: 10 };
    });
    renderDialog(memoryService, onSaved);

    fireEvent.click(screen.getByTestId(TID_V4_MEMORY_CAPTURE_SAVE));

    await waitFor(() =>
      expect(screen.getByTestId(TID_V4_MEMORY_CAPTURE_ERROR).textContent).toBe(
        "settings.memory.viewer.fileChanged",
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(writeProjectMemoryFile).toHaveBeenCalledTimes(2);
  });

  it("标题与正文为空时不能保存", async () => {
    const memoryService = createService();
    renderDialog(memoryService);
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: "" } });

    expect((screen.getByTestId(TID_V4_MEMORY_CAPTURE_SAVE) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(memoryService.writeProjectMemoryFile).not.toHaveBeenCalled();
  });
});
