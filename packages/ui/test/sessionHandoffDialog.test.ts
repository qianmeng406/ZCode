// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { SessionHandoffDialog } from "@/v4/handoff/SessionHandoffDialog.js";

let rowId = 1;

function row(text: string, rowIdValue = rowId++): ConversationRow {
  return {
    rowId: rowIdValue,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "userInput",
    text,
    origin: "realUser",
  } as ConversationRow;
}

function rows(): ConversationRow[] {
  return [
    row("修复登录"),
    {
      rowId: rowId++,
      turnId: "t1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "assistantText",
      text: "已修复",
      state: "complete",
    } as ConversationRow,
  ];
}

const SELECTION: ModelSelection = { providerId: "provider-a", modelId: "model-a" };

function dialogElement(
  props: Partial<Parameters<typeof SessionHandoffDialog>[0]>,
  services?: unknown,
) {
  const dialog = createElement(SessionHandoffDialog, {
    open: true,
    onClose: () => undefined,
    rows: rows(),
    title: "登录修复",
    workspacePath: "/workspace",
    selection: null,
    ...props,
  });
  const tree = services
    ? createElement(ServiceProvider, { services: services as never, children: dialog })
    : dialog;
  return createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, tree);
}

function renderDialog(overrides: Partial<Parameters<typeof SessionHandoffDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(dialogElement({ onClose, ...overrides }));
  return { onClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionHandoffDialog", () => {
  it("falls back to the deterministic export without a model", async () => {
    renderDialog();
    expect(await screen.findByTestId("v4-session-handoff-fallback")).toBeTruthy();
    const content = screen.getByTestId("v4-session-handoff-content") as HTMLTextAreaElement;
    expect(content.value).toContain("# 会话交接：登录修复");
    expect(content.value).toContain("修复登录");
  });

  it("switches to the full export without calling a model", async () => {
    renderDialog();
    await screen.findByTestId("v4-session-handoff-fallback");
    fireEvent.click(screen.getByText("完整导出"));
    await waitFor(() => {
      const content = screen.getByTestId("v4-session-handoff-content") as HTMLTextAreaElement;
      expect(content.value).toContain("## 会话内容");
    });
    expect(screen.queryByTestId("v4-session-handoff-fallback")).toBeNull();
  });

  it("lets the user edit the exported markdown", async () => {
    renderDialog();
    const content = screen.getByTestId("v4-session-handoff-content") as HTMLTextAreaElement;
    fireEvent.change(content, { target: { value: "自定义交接" } });
    expect(content.value).toBe("自定义交接");
  });

  it("generates the summary once even while rows keep changing", async () => {
    const generateWorkspaceText = vi.fn(async () => ({ text: "# 摘要" }));
    const services = { zcodeAgentService: { generateWorkspaceText } };
    const { rerender } = render(
      dialogElement({ selection: SELECTION, historyLoaded: true }, services),
    );
    await waitFor(() => expect(generateWorkspaceText).toHaveBeenCalledTimes(1));

    // 流式期间每个 delta 都会给出一份新 rows 数组：不得重复调用模型。
    rerender(
      dialogElement(
        { selection: SELECTION, historyLoaded: true, rows: [...rows(), row("流式新增")] },
        services,
      ),
    );
    rerender(
      dialogElement(
        { selection: SELECTION, historyLoaded: true, rows: [...rows(), row("流式新增2")] },
        services,
      ),
    );
    expect(generateWorkspaceText).toHaveBeenCalledTimes(1);
  });

  it("waits for the full history before summarizing", async () => {
    const generateWorkspaceText = vi.fn(async () => ({ text: "# 摘要" }));
    const services = { zcodeAgentService: { generateWorkspaceText } };
    const { rerender } = render(
      dialogElement({ selection: SELECTION, historyLoaded: false }, services),
    );
    expect(generateWorkspaceText).not.toHaveBeenCalled();

    rerender(dialogElement({ selection: SELECTION, historyLoaded: true }, services));
    await waitFor(() => expect(generateWorkspaceText).toHaveBeenCalledTimes(1));
  });

  it("cancels the in-flight generation and drops the late result", async () => {
    let resolveGeneration: (value: { text: string }) => void = () => {};
    const generateWorkspaceText = vi.fn(
      () =>
        new Promise<{ text: string }>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const cancelWorkspaceGenerateText = vi.fn(async () => true);
    const services = { zcodeAgentService: { generateWorkspaceText, cancelWorkspaceGenerateText } };
    render(dialogElement({ selection: SELECTION, historyLoaded: true }, services));

    const cancelButton = await screen.findByTestId("v4-session-handoff-cancel");
    fireEvent.click(cancelButton);

    const content = screen.getByTestId("v4-session-handoff-content") as HTMLTextAreaElement;
    expect(content.value).toContain("# 会话交接：登录修复");
    expect(screen.queryByTestId("v4-session-handoff-cancel")).toBeNull();
    expect(cancelWorkspaceGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        querySource: "session_handoff",
        operationId: expect.stringMatching(/^session-handoff:/u),
      }),
    );

    // 迟到的生成结果不得覆盖取消后的内容。
    await act(async () => {
      resolveGeneration({ text: "# 迟到摘要" });
    });
    expect(content.value).toContain("# 会话交接：登录修复");
    expect(content.value).not.toContain("迟到摘要");
  });

  it("downloads the markdown when there is no native save dialog", async () => {
    const createObjectURL = vi.fn(() => "blob:handoff");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      renderDialog();
      await screen.findByTestId("v4-session-handoff-fallback");
      fireEvent.click(screen.getByText("保存 Markdown"));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(anchor.download).toBe("登录修复-handoff.md");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("warns when neither saving nor copying is available", async () => {
    // 下载不可用（createObjectURL 抛错）且 jsdom 无 Clipboard API / execCommand：
    // 保存要退回到复制，并明确告诉用户结果。
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("no blob support");
    });
    renderDialog();
    await screen.findByTestId("v4-session-handoff-fallback");
    fireEvent.click(screen.getByText("保存 Markdown"));
    expect(await screen.findByTestId("v4-session-handoff-saveFailed")).toBeTruthy();
  });

  it("reports copy failure instead of silently doing nothing", async () => {
    renderDialog();
    await screen.findByTestId("v4-session-handoff-fallback");
    fireEvent.click(screen.getByText("复制"));
    expect(await screen.findByTestId("v4-session-handoff-copyFailed")).toBeTruthy();
  });
});
