// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import { OracleReviewBanner } from "@/v4/oracleReview/OracleReviewBanner.js";
import type { OracleReviewState } from "@/v4/oracleReview/oracleReviewSupport.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, number | string> = {}) =>
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zhCN[id] ?? id,
        ),
    },
  }),
}));

afterEach(cleanup);

const UUID = "5c89448a-d736-44ac-9a63-5ebe4819296f";
const SUMMARY =
  "3.16.2 同步本身落地扎实，声明与证据大体吻合，" +
  "但上游四分屏退役与 fork 定制的交汇处仍有若干需要复核的注意事项。".repeat(3);

const resultState: OracleReviewState = {
  status: "result",
  mode: "manual",
  reviewId: "r1",
  turnRowId: 1,
  entityId: "e1",
  verdict: "warn",
  summary: SUMMARY,
  findings: "无",
  modelLabel: `${UUID}/deepseek/deepseek-v4.1-flash`,
  depth: "standard",
  completedAt: 1,
};

function renderBanner(state: OracleReviewState, onOpenPanel?: () => void) {
  return render(
    createElement(OracleReviewBanner, {
      state,
      providers: [{ providerId: UUID, providerName: "cmd3" }],
      ...(onOpenPanel ? { onOpenPanel } : {}),
      onRereview: () => {},
      onDismiss: () => {},
      onFix: () => {},
    }),
  );
}

it("卡片只保留单行摘要与关键徽标，完整结论移到面板", () => {
  const { container } = renderBanner(resultState);
  // 摘要只作为单行预览出现一次；详情折叠区已移出卡片。
  expect(screen.getAllByText(SUMMARY)).toHaveLength(1);
  expect(container.querySelector("[data-testid='v4-oracle-review-summary']")).toBeNull();
  expect(container.textContent).not.toContain("审查总结");
  expect(container.textContent).not.toContain("问题清单");
});

it("展开按钮触发面板打开；宿主未接线时不显示入口", () => {
  const onOpenPanel = vi.fn();
  const { unmount } = renderBanner(resultState, onOpenPanel);
  fireEvent.click(screen.getByTestId("v4-oracle-review-expand"));
  expect(onOpenPanel).toHaveBeenCalledTimes(1);
  unmount();

  renderBanner(resultState);
  expect(screen.queryByTestId("v4-oracle-review-expand")).toBeNull();
});

it("审查卡片的模型名显示 provider 名而不是 UUID", () => {
  const { container } = renderBanner(resultState);
  expect(container.textContent).toContain("cmd3/deepseek/deepseek-v4.1-flash");
  expect(container.textContent).not.toContain(UUID);
});

it("pending 卡片显示阶段与工具计数，且同样可以展开面板", () => {
  const onOpenPanel = vi.fn();
  const { container } = renderBanner(
    {
      status: "pending",
      mode: "manual",
      reviewId: "r2",
      startedAt: 1,
      stage: "reviewing",
      modelLabel: "p/m",
      depth: "deep",
      request: {
        reviewId: "r2",
        depth: "deep",
        mode: "manual",
        sessionId: "s1",
        workspacePath: "/repo",
        target: { rowId: 1, entityId: "e1" },
        createdAt: 1,
      },
      toolEvents: [
        { round: 1, toolName: "Read", target: "a.ts" },
        { round: 1, toolName: "Read", target: "b.ts" },
      ],
    },
    onOpenPanel,
  );
  expect(container.textContent).toContain("审查中");
  expect(container.textContent).toContain("已执行 2 次工具调用");
  fireEvent.click(screen.getByTestId("v4-oracle-review-expand"));
  expect(onOpenPanel).toHaveBeenCalledTimes(1);
});
