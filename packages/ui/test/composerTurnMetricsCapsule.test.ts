// @vitest-environment jsdom

// Composer main-turn 指标胶囊黄金测试：
// - 真实事实（turnHeader 轮指标）→ 格式化 TTFT/tok/s/输出 token；
// - 缺失字段 → `--` 占位，绝不估算；
// - 共享 test-id 锚点（TID_COMPOSER_TURN_METRICS / _ITEM）；
// - tok/s 分母缺失或为 0 时不展示导数。
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_COMPOSER_TURN_METRICS, TID_COMPOSER_TURN_METRICS_ITEM, testId } from "@zcode/shared";
import {
  ComposerTurnMetricsCapsule,
  formatComposerTurnMetrics,
} from "@/v4/composer/ComposerTurnMetricsCapsule.js";
import { deriveComposerTurnMetricsFact } from "@/v4/composer/composerTurnMetricsFact.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

function renderCapsule(fact: Parameters<typeof ComposerTurnMetricsCapsule>[0]["fact"]) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ComposerTurnMetricsCapsule, { fact }),
    ),
  );
}

function item(container: HTMLElement, suffix: string): HTMLElement | null {
  return container.querySelector(
    `[data-testid="${testId(TID_COMPOSER_TURN_METRICS_ITEM, suffix)}"]`,
  );
}

describe("ComposerTurnMetricsCapsule", () => {
  it("renders complete main-turn facts with shared test-id anchors", () => {
    const { container, getByTestId } = renderCapsule({
      outputTokens: 1234,
      timeToFirstTokenMs: 320,
      generationDurationMs: 2_000,
    });
    expect(getByTestId(TID_COMPOSER_TURN_METRICS)).toBeTruthy();
    expect(item(container, "ttft")?.textContent).toContain("0.3s");
    // speed = 1234 tokens / 2s = 617 tok/s。
    expect(item(container, "tokens-per-second")?.textContent).toContain("617");
    expect(item(container, "output-tokens")?.textContent).toContain("1,234");
  });

  it("shows -- placeholders for missing facts instead of estimates", () => {
    const { container } = renderCapsule({});
    expect(item(container, "ttft")?.textContent).toContain("--");
    expect(item(container, "tokens-per-second")?.textContent).toContain("--");
    expect(item(container, "output-tokens")?.textContent).toContain("--");
  });

  it("omits tok/s when the generation duration denominator is missing or zero", () => {
    const { container } = renderCapsule({
      outputTokens: 100,
      timeToFirstTokenMs: 500,
    });
    expect(item(container, "tokens-per-second")?.textContent).toContain("--");
    const zeroDenominator = renderCapsule({
      outputTokens: 100,
      generationDurationMs: 0,
    });
    expect(item(zeroDenominator.container, "tokens-per-second")?.textContent).toContain("--");
  });

  it("formats multi-step aggregation the same as single step (sum inputs from CLI)", () => {
    // CLI 已求和；UI 只做除法，不做二次聚合。
    expect(
      formatComposerTurnMetrics(
        {
          outputTokens: 50,
          generationDurationMs: 2_000,
          timeToFirstTokenMs: 320,
        },
        "en-US",
      ),
    ).toEqual({
      timeToFirstToken: "0.3s",
      tokensPerSecond: "25",
      outputTokens: "50",
    });
  });

  it("lists turn, latest-request and session facts inline without a second panel", () => {
    const { container } = renderCapsule({
      outputTokens: 1_234,
      timeToFirstTokenMs: 320,
      generationDurationMs: 2_000,
      reasoningTokens: 200,
      inputTokens: 5_000,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 10,
      requestCount: 3,
      lastRequest: { outputTokens: 100, timeToFirstTokenMs: 200, generationDurationMs: 1_000 },
      session: {
        inputTokens: 9_000,
        outputTokens: 1_200,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 100,
        generationDurationMs: 20_000,
        requestCount: 30,
      },
    });
    expect(item(container, "reasoning-tokens")?.textContent).toContain("200");
    // 可见输出 = 1_234 − 200。
    expect(item(container, "visible-output")?.textContent).toContain("1,034");
    expect(item(container, "generation-duration")?.textContent).toContain("2.0s");
    expect(item(container, "request-count")?.textContent).toContain("3");
    expect(item(container, "input-tokens")?.textContent).toContain("5,000");
    expect(item(container, "last-request-tokens-per-second")?.textContent).toContain("100");
    expect(item(container, "session-output-tokens")?.textContent).toContain("1,200");
    expect(item(container, "session-request-count")?.textContent).toContain("30");
  });

  it("omits detail segments whose fact is absent instead of printing zero", () => {
    const { container } = renderCapsule({ outputTokens: 10, generationDurationMs: 1_000 });
    expect(item(container, "reasoning-tokens")).toBeNull();
    expect(item(container, "cache-write")).toBeNull();
    expect(item(container, "session-output-tokens")).toBeNull();
  });

  it("formats long generation durations as minutes and seconds", () => {
    const { container } = renderCapsule({ outputTokens: 14_974, generationDurationMs: 157_000 });
    expect(item(container, "generation-duration")?.textContent).toContain("2m37s");
  });
});

describe("deriveComposerTurnMetricsFact", () => {
  const lastCompleted = {
    kind: "turnHeader",
    outputTokens: 120,
    timeToFirstTokenMs: 420,
    generationDurationMs: 3_000,
  };
  const userRow = { kind: "userInput" };

  it("returns the last completed turn metrics", () => {
    expect(deriveComposerTurnMetricsFact([userRow, lastCompleted])).toEqual({
      outputTokens: 120,
      timeToFirstTokenMs: 420,
      generationDurationMs: 3_000,
    });
  });

  it("keeps the previous completed turn while the new turn has no metric facts yet", () => {
    // 新主轮 header 已建（三项全缺席）→ 必须回落上一完成轮，不能冲成全 --。
    const newRunningHeader = { kind: "turnHeader" };
    expect(deriveComposerTurnMetricsFact([lastCompleted, userRow, newRunningHeader])).toEqual({
      outputTokens: 120,
      timeToFirstTokenMs: 420,
      generationDurationMs: 3_000,
    });
  });

  it("prefers a running turn header that already carries partial live facts", () => {
    const runningWithPartial = { kind: "turnHeader", outputTokens: 7 };
    expect(deriveComposerTurnMetricsFact([lastCompleted, runningWithPartial])).toEqual({
      outputTokens: 7,
    });
  });

  it("returns null when no turn header carries facts", () => {
    expect(deriveComposerTurnMetricsFact([userRow, { kind: "turnHeader" }])).toBeNull();
    expect(deriveComposerTurnMetricsFact(undefined)).toBeNull();
  });

  it("carries turn usage details and session cumulative facts", () => {
    const withDetails = {
      kind: "turnHeader",
      outputTokens: 120,
      reasoningTokens: 40,
      inputTokens: 900,
      cacheReadTokens: 800,
      cacheWriteTokens: 10,
      requestCount: 3,
      lastRequest: { outputTokens: 30, timeToFirstTokenMs: 200, generationDurationMs: 1_000 },
    };
    expect(
      deriveComposerTurnMetricsFact([withDetails], {
        cumulative: {
          inputTokens: 9_000,
          outputTokens: 1_200,
          cacheReadTokens: 8_000,
          cacheWriteTokens: 100,
          generationDurationMs: 20_000,
          requestCount: 30,
        },
      }),
    ).toEqual({
      outputTokens: 120,
      reasoningTokens: 40,
      inputTokens: 900,
      cacheReadTokens: 800,
      cacheWriteTokens: 10,
      requestCount: 3,
      lastRequest: { outputTokens: 30, timeToFirstTokenMs: 200, generationDurationMs: 1_000 },
      session: {
        inputTokens: 9_000,
        outputTokens: 1_200,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 100,
        generationDurationMs: 20_000,
        requestCount: 30,
      },
    });
  });
});
