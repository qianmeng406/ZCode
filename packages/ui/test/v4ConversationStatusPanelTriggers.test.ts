// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

afterEach(cleanup);

const menuLabel = "chat.summaryPanel.displayMode";
const autoLabel = "chat.summaryPanel.displayModeAuto";

function historicalPanel(onVariantChange: (variant: "panel" | "mini" | null) => void) {
  return createElement(
    StrictMode,
    null,
    createElement(
      TooltipProvider,
      null,
      createElement(ConversationStatusPanel, {
        workspacePath: "/workspace",
        parentSessionId: "historical-session",
        endedWorkflowRunCount: 1,
        onOpenWorkflowRunDirectory: () => {},
        summaryPanelVariantOverride: "panel",
        onVariantChange,
      }),
    ),
  );
}

describe("historical conversation status panel trigger lifecycle", () => {
  it("keeps the tooltip DOM ref inside the dropdown trigger", () => {
    const source = readFileSync(resolve("packages/ui/src/v4/ConversationStatusPanel.tsx"), "utf8");
    // 防止把 Tooltip 的 setTrigger 再次穿过会重组 ref 的 DropdownMenuTrigger。
    expect(source).toMatch(/<Tooltip>\s*<DropdownMenuTrigger asChild>\s*<TooltipTrigger asChild>/);
    expect(source).not.toMatch(/<ControlHintTooltip[^>]*title=\{panelMenuLabel\}/);
  });

  it("mounts historical sessions repeatedly with real Radix menus and tooltips", async () => {
    const onVariantChange = vi.fn();
    for (let mount = 0; mount < 3; mount++) {
      const view = render(historicalPanel(onVariantChange));
      const button = screen.getByRole("button", { name: menuLabel });
      expect(button.querySelector("button")).toBeNull();
      view.rerender(historicalPanel(onVariantChange));
      expect(screen.getByRole("button", { name: menuLabel })).toBe(button);

      fireEvent.focus(button);
      expect(await screen.findByRole("tooltip")).toBeTruthy();
      fireEvent.keyDown(button, { key: "Enter" });
      const item = await screen.findByRole("menuitemradio", { name: autoLabel });
      expect(button.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(item);
      expect(onVariantChange).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("menu")).toBeNull();

      fireEvent.keyDown(button, { key: "ArrowDown" });
      const menu = await screen.findByRole("menu");
      fireEvent.keyDown(menu, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(button));
      view.unmount();
    }
  });
});
