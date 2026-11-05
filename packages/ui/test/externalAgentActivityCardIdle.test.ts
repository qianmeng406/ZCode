// @vitest-environment jsdom
// 「已 N 分钟无新输出」是纯 UI 判断（store 的 lastChangedAt + 本地秒表），
// 但没有渲染断言就只能靠源码扫描，容易在重构里悄悄失效。这里钉住阈值与文案。
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: { minutes?: number }): string =>
        descriptor.id === "chat.externalAgent.activity.idle"
          ? `已 ${values?.minutes} 分钟无新输出`
          : descriptor.id,
    },
  }),
}));

import { ExternalAgentActivityCard } from "@/v4/composer/ExternalAgentActivityCard.js";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function activity(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    agentLabel: "CodeBuddy",
    status: "running" as const,
    startedAt: NOW - 10 * MINUTE,
    elapsedMs: 10 * MINUTE,
    ...overrides,
  } as never;
}

function renderCard(props: Record<string, unknown>) {
  return render(createElement(ExternalAgentActivityCard, props as never));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ExternalAgentActivityCard 无输出提示", () => {
  it("运行中超过 60s 没有新输出：显示分钟数", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderCard({ activity: activity(), lastChangedAt: NOW - 2 * MINUTE - 5_000 });
    expect(screen.getByTestId("external-agent-activity-idle").textContent).toBe(
      "已 2 分钟无新输出",
    );
  });

  it("阈值内（59s）不提示，避免正常停顿误报", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderCard({ activity: activity(), lastChangedAt: NOW - 59_000 });
    expect(screen.queryByTestId("external-agent-activity-idle")).toBeNull();
  });

  it("已结束的任务不提示（提示只描述运行中的沉默）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderCard({
      activity: activity({ status: "completed", elapsedMs: 30 * MINUTE }),
      lastChangedAt: NOW - 30 * MINUTE,
    });
    expect(screen.queryByTestId("external-agent-activity-idle")).toBeNull();
  });

  it("没有 lastChangedAt（旧数据/外部宿主）时不提示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    renderCard({ activity: activity() });
    expect(screen.queryByTestId("external-agent-activity-idle")).toBeNull();
  });
});
