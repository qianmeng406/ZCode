// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_SETTINGS_MEMORY_EDITOR_ERROR,
  TID_SETTINGS_MEMORY_EDITOR_RELOAD,
  TID_SETTINGS_MEMORY_EDITOR_SAVE,
  TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
} from "@zcode/shared/test-ids";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

import { MemoryFileEditor, type MemoryFileEditingService } from "@/settings/MemoryFileEditor.js";

const WORKSPACE_ID = "z-code-1111111111111111";

function createService(overrides: Partial<MemoryFileEditingService> = {}) {
  return {
    readProjectMemoryFile: vi.fn(async () => ({ content: "body", updatedAt: 1_000 })),
    writeProjectMemoryFile: vi.fn(async () => ({ updatedAt: 2_000, size: 4 })),
    deleteProjectMemoryFile: vi.fn(async () => ({ indexUpdated: false })),
    ...overrides,
  } as MemoryFileEditingService;
}

function renderEditor(
  memoryService: MemoryFileEditingService,
  callbacks: { onSaved?: () => void | Promise<void>; onDeleted?: () => void | Promise<void> } = {},
) {
  const onCancel = vi.fn();
  render(
    createElement(MemoryFileEditor, {
      workspaceId: WORKSPACE_ID,
      fileName: "fact-a.md",
      memoryService,
      onCancel,
      onSaved: callbacks.onSaved ?? vi.fn(),
      onDeleted: callbacks.onDeleted ?? vi.fn(),
    }),
  );
  return { onCancel };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryFileEditor", () => {
  it("加载失败时给出错误与重新加载入口", async () => {
    const readProjectMemoryFile = vi
      .fn<MemoryFileEditingService["readProjectMemoryFile"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ content: "recovered", updatedAt: 10 });
    renderEditor(createService({ readProjectMemoryFile }));

    await waitFor(() =>
      expect(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_ERROR).textContent).toBe("boom"),
    );
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_RELOAD));

    const textarea = (await screen.findByTestId(
      TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("recovered"));
    expect(readProjectMemoryFile).toHaveBeenCalledTimes(2);
  });

  it("CAS 冲突映射成「文件已改动」，草稿保留，重新加载取回磁盘内容", async () => {
    const writeProjectMemoryFile = vi
      .fn<MemoryFileEditingService["writeProjectMemoryFile"]>()
      .mockRejectedValue(
        Object.assign(new Error("changed"), { code: "PROJECT_MEMORY_FILE_CHANGED" }),
      );
    const readProjectMemoryFile = vi
      .fn<MemoryFileEditingService["readProjectMemoryFile"]>()
      .mockResolvedValueOnce({ content: "body", updatedAt: 1_000 })
      .mockResolvedValueOnce({ content: "from disk", updatedAt: 3_000 });
    renderEditor(createService({ readProjectMemoryFile, writeProjectMemoryFile }));

    const textarea = (await screen.findByTestId(
      TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("body"));
    fireEvent.change(textarea, { target: { value: "my draft" } });
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_SAVE));

    await waitFor(() =>
      expect(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_ERROR).textContent).toBe(
        "settings.memory.viewer.fileChanged",
      ),
    );
    expect(textarea.value).toBe("my draft");

    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_RELOAD));
    // 重新加载会先回到 loading 再重新挂载 textarea，必须重新取节点。
    const reloaded = (await screen.findByTestId(
      TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(reloaded.value).toBe("from disk"));
  });

  it("开关关闭时把拒绝映射成对应的文案", async () => {
    const writeProjectMemoryFile = vi
      .fn<MemoryFileEditingService["writeProjectMemoryFile"]>()
      .mockRejectedValue(Object.assign(new Error("nope"), { code: "FORK_FEATURE_DISABLED" }));
    renderEditor(createService({ writeProjectMemoryFile }));

    const textarea = (await screen.findByTestId(
      TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("body"));
    fireEvent.change(textarea, { target: { value: "next" } });
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_SAVE));

    await waitFor(() =>
      expect(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_ERROR).textContent).toBe(
        "settings.memory.editor.error.disabled",
      ),
    );
  });

  it("保存成功后把新 updatedAt 作为下一次 CAS 基准，并通知父级刷新", async () => {
    const onSaved = vi.fn();
    const writeProjectMemoryFile = vi
      .fn<MemoryFileEditingService["writeProjectMemoryFile"]>()
      .mockResolvedValueOnce({ updatedAt: 2_000, size: 4 })
      .mockResolvedValueOnce({ updatedAt: 3_000, size: 6 });
    renderEditor(createService({ writeProjectMemoryFile }), { onSaved });

    const textarea = (await screen.findByTestId(
      TID_SETTINGS_MEMORY_EDITOR_TEXTAREA,
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("body"));

    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_SAVE));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    fireEvent.change(textarea, { target: { value: "second" } });
    fireEvent.click(screen.getByTestId(TID_SETTINGS_MEMORY_EDITOR_SAVE));

    await waitFor(() =>
      expect(writeProjectMemoryFile).toHaveBeenLastCalledWith({
        workspaceId: WORKSPACE_ID,
        fileName: "fact-a.md",
        content: "second",
        expectedUpdatedAt: 2_000,
      }),
    );
  });
});
