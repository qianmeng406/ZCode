// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SessionHandoffDialog } from "@/v4/handoff/SessionHandoffDialog.js";

let rowId = 1;

function rows(): ConversationRow[] {
  return [
    {
      rowId: rowId++,
      turnId: "t1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "userInput",
      text: "修复登录",
      origin: "realUser",
    } as ConversationRow,
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

function renderDialog(overrides: Partial<Parameters<typeof SessionHandoffDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SessionHandoffDialog, {
        open: true,
        onClose,
        rows: rows(),
        title: "登录修复",
        workspacePath: "/workspace",
        selection: null,
        ...overrides,
      }),
    ),
  );
  return { onClose };
}

afterEach(cleanup);

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
});
