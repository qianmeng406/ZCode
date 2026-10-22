// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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

function renderBanner(state: OracleReviewState) {
  return render(
    createElement(OracleReviewBanner, {
      state,
      providers: [{ providerId: UUID, providerName: "cmd3" }],
      onRereview: () => {},
      onDismiss: () => {},
      onFix: () => {},
    }),
  );
}

it("审查总结默认展开，长结论全文可见", () => {
  const { container } = renderBanner(resultState);
  // 标题行是单行预览；「审查总结」段承载全文，默认展开。
  const matches = screen.getAllByText(SUMMARY);
  expect(matches.length).toBeGreaterThan(0);
  expect(container.textContent).toContain("审查总结");
  expect(container.querySelector("[data-testid='v4-oracle-review-summary']")).not.toBeNull();
});

it("审查卡片的模型名显示 provider 名而不是 UUID", () => {
  const { container } = renderBanner(resultState);
  expect(container.textContent).toContain("cmd3/deepseek/deepseek-v4.1-flash");
  expect(container.textContent).not.toContain(UUID);
});
