// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { OracleReviewQueuePanel } from "@/v4/oracleReview/OracleReviewQueuePanel.js";
import type { ReviewQueueItem } from "@/v4/oracleReview/reviewQueue.js";

const ITEM: ReviewQueueItem = {
  key: "loc|src/a.ts|12",
  reviewId: "review-1",
  sessionId: "session-1",
  fingerprint: "loc|src/a.ts|12",
  severity: "error",
  message: "空指针",
  file: "src/a.ts",
  line: 12,
  verdict: "fail",
  summary: "审查未通过",
  depth: "standard",
  modelLabel: "zai/glm-4.6",
  completedAt: 100,
  synthesized: false,
};

type PanelProps = Parameters<typeof OracleReviewQueuePanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const handlers = {
    onJump: vi.fn(),
    onAsk: vi.fn(),
    onFix: vi.fn(),
    onMarkReviewed: vi.fn(),
    onMarkAllReviewed: vi.fn(),
    onClearReviewed: vi.fn(),
  };
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OracleReviewQueuePanel, {
        items: [ITEM],
        reviewedCount: 0,
        loading: false,
        ...handlers,
        ...overrides,
      }),
    ),
  );
  return handlers;
}

afterEach(cleanup);

describe("OracleReviewQueuePanel", () => {
  it("renders severity, location and message", () => {
    renderPanel();
    expect(screen.getByTestId("v4-oracle-review-queue")).toBeTruthy();
    expect(screen.getByText("src/a.ts:12")).toBeTruthy();
    expect(screen.getByText("空指针")).toBeTruthy();
  });

  it("dispatches jump, ask, fix and mark actions", () => {
    const handlers = renderPanel();
    fireEvent.click(screen.getByText("src/a.ts:12"));
    fireEvent.click(screen.getByText("追问"));
    fireEvent.click(screen.getByText("修复"));
    fireEvent.click(screen.getByText("已读"));
    expect(handlers.onJump).toHaveBeenCalledWith(ITEM);
    expect(handlers.onAsk).toHaveBeenCalledWith(ITEM);
    expect(handlers.onFix).toHaveBeenCalledWith(ITEM);
    expect(handlers.onMarkReviewed).toHaveBeenCalledWith(ITEM);
  });

  it("shows the empty state and reviewed count control", () => {
    renderPanel({ items: [], reviewedCount: 2 });
    expect(screen.getByTestId("v4-oracle-review-queue-empty")).toBeTruthy();
    expect(screen.getByText("恢复已读")).toBeTruthy();
  });
});
