// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TID_CHAT_CONTEXT_COMPACT_BUTTON } from "@zcode/shared/test-ids";

import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";

// 压缩上下文按钮的交互回归：只关注按钮派发 / 禁用 / 无回调 / 无可用上下文四类
// 契约。面板容器用受控 stub 展开，避免 HoverCard 真实浮层在 jsdom 中的测量成本。
vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  ContextContent: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  ContextContentBody: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  ContextTrigger: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children ?? "context"),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

vi.mock("@/chat-input-toolbar/CodingPlanContextUsage.js", () => ({
  ChatCodingPlanUsageRemainingPanel: () => null,
  hasChatCodingPlanUsageRemaining: () => false,
}));

vi.mock("@/chat-input-toolbar/StartPlanContextBalance.js", () => ({
  ChatStartPlanBalancePanel: () => null,
  hasChatStartPlanBalance: () => false,
}));

function renderContextUsage(overrides: {
  onSendCompressionCommand?: (command: string) => void;
  compressionDisabled?: boolean;
  compactRunning?: boolean;
  taskUsage?: { used: number; size: number } | null;
}) {
  return render(
    createElement(ChatContextUsage, {
      intl: {
        formatMessage: ({ id }: { id: string }) => id,
      } as never,
      locale: "en-US",
      selectedProvider: "glm",
      taskUsage:
        overrides.taskUsage === undefined ? { used: 17_000, size: 1_000_000 } : overrides.taskUsage,
      onSendCompressionCommand: overrides.onSendCompressionCommand,
      compressionDisabled: overrides.compressionDisabled,
      compactRunning: overrides.compactRunning,
    }),
  );
}

describe("ChatContextUsage compact action", () => {
  afterEach(() => {
    cleanup();
  });

  it("dispatches exactly /compact on activation", () => {
    const onSendCompressionCommand = vi.fn();

    renderContextUsage({ onSendCompressionCommand });

    const button = screen.getByTestId(TID_CHAT_CONTEXT_COMPACT_BUTTON);
    expect(button.getAttribute("aria-label")).toBe("chat.contextUsage.compact");
    fireEvent.click(button);

    expect(onSendCompressionCommand).toHaveBeenCalledTimes(1);
    expect(onSendCompressionCommand).toHaveBeenCalledWith("/compact");
  });

  it("keeps a disabled action from dispatching", () => {
    const onSendCompressionCommand = vi.fn();

    renderContextUsage({
      onSendCompressionCommand,
      compressionDisabled: true,
    });

    const button = screen.getByTestId(TID_CHAT_CONTEXT_COMPACT_BUTTON) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(onSendCompressionCommand).not.toHaveBeenCalled();
  });

  it("disables while a compact active work is running and blocks dispatch", () => {
    const onSendCompressionCommand = vi.fn();

    renderContextUsage({
      onSendCompressionCommand,
      compactRunning: true,
    });

    const button = screen.getByTestId(TID_CHAT_CONTEXT_COMPACT_BUTTON) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(onSendCompressionCommand).not.toHaveBeenCalled();
  });

  it("omits the action when no compression callback is provided", () => {
    renderContextUsage({});

    expect(screen.queryByTestId(TID_CHAT_CONTEXT_COMPACT_BUTTON)).toBeNull();
  });

  it("omits the action when no usable context window is displayed", () => {
    renderContextUsage({
      onSendCompressionCommand: vi.fn(),
      taskUsage: null,
    });

    expect(screen.queryByTestId(TID_CHAT_CONTEXT_COMPACT_BUTTON)).toBeNull();
  });
});
