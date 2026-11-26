// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ComposerStatusRow, ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 0 }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function historicalPanel(activityOpenRequest: number) {
  return createElement(
    StrictMode,
    null,
    createElement(
      TooltipProvider,
      null,
      createElement(
        ComposerStatusRow,
        null,
        createElement(ConversationStatusPanel, {
          workspacePath: "/workspace",
          parentSessionId: "historical-session",
          backgroundWorks: [
            {
              workId: "bash-1",
              kind: "bash",
              title: "Build project",
              status: "running",
              startedAt: 1,
            },
          ],
          activityOpenRequest,
          onOpenBackgroundBash: () => {},
        }),
      ),
    ),
  );
}

describe("conversation status activity capsule trigger lifecycle", () => {
  it("keeps the popover trigger as the capsule button", () => {
    const source = readFileSync(resolve("packages/ui/src/v4/ConversationStatusPanel.tsx"), "utf8");
    expect(source).toMatch(/<PopoverTrigger asChild>\s*<Button/);
    expect(source).not.toMatch(/<DropdownMenuTrigger asChild>\s*<TooltipTrigger asChild>/);
  });

  it("opens the activity capsule on request across repeated mounts", async () => {
    for (let mount = 0; mount < 3; mount++) {
      const view = render(historicalPanel(0));
      const button = document.querySelector('[data-status-capsule="activity"]');
      expect(button).toBeTruthy();
      view.rerender(historicalPanel(1));
      expect(await screen.findByText("Build project")).toBeTruthy();
      view.unmount();
    }
  });
});
