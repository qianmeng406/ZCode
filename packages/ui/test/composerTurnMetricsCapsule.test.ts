// @vitest-environment jsdom

// Composer 会话指标卡片黄金测试：
// - 单行八段：会话五项（平均首 token / 平均速度 / 总输入 / 总输出 / 缓存命中率）
//   + 上次请求三项（首 token / 速度 / 缓存命中率）；
// - 会话级取自 usage.cumulative，单请求取自最近带 lastRequest 的 turnHeader；
// - 缺失字段 → `--` 占位，绝不估算；平均首 token 只在有累计采样时求均值；
// - 缓存命中率 = cacheRead / input，脏数据夹到 100%；
// - 共享 test-id 锚点（TID_COMPOSER_TURN_METRICS / _ITEM）。
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_COMPOSER_TURN_METRICS, TID_COMPOSER_TURN_METRICS_ITEM, testId } from "@zcode/shared";
import {
  ComposerTurnMetricsCapsule,
  formatComposerSessionUsage,
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

const sessionUsage = {
  inputTokens: 5_000,
  outputTokens: 1_234,
  cacheReadTokens: 4_000,
  generationDurationMs: 2_000,
  requestCount: 2,
  timeToFirstTokenTotalMs: 640,
  timeToFirstTokenSamples: 2,
};

const lastRequest = {
  outputTokens: 100,
  timeToFirstTokenMs: 200,
  generationDurationMs: 1_000,
  inputTokens: 800,
  cacheReadTokens: 400,
};

describe("ComposerTurnMetricsCapsule", () => {
  it("renders the eight inline segments with shared test-id anchors", () => {
    const { container, getByTestId } = renderCapsule({ session: sessionUsage, lastRequest });
    expect(getByTestId(TID_COMPOSER_TURN_METRICS)).toBeTruthy();
    // 会话平均首 token = 640ms / 2 次请求 = 320ms。
    expect(item(container, "average-ttft")?.textContent).toContain("0.3s");
    // 会话平均速度 = 1234 tokens / 2s。
    expect(item(container, "average-tokens-per-second")?.textContent).toContain("617");
    expect(item(container, "input-tokens")?.textContent).toContain("5,000");
    expect(item(container, "output-tokens")?.textContent).toContain("1,234");
    // 会话缓存命中率 = 4000 / 5000。
    expect(item(container, "cache-hit-rate")?.textContent).toContain("80%");
    expect(item(container, "last-request-ttft")?.textContent).toContain("0.2s");
    expect(item(container, "last-request-tokens-per-second")?.textContent).toContain("100");
    // 单请求缓存命中率 = 400 / 800。
    expect(item(container, "last-request-cache-hit-rate")?.textContent).toContain("50%");
  });

  it("shows -- placeholders for every session segment instead of estimates", () => {
    const { container } = renderCapsule({});
    for (const key of [
      "average-ttft",
      "average-tokens-per-second",
      "input-tokens",
      "output-tokens",
      "cache-hit-rate",
    ]) {
      expect(item(container, key)?.textContent).toContain("--");
    }
  });

  it("treats an untouched cumulative (0 requests, 0 tokens) as unavailable, not zero", () => {
    const { container } = renderCapsule({
      session: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      },
    });
    expect(item(container, "input-tokens")?.textContent).toContain("--");
    expect(item(container, "output-tokens")?.textContent).toContain("--");
    expect(item(container, "cache-hit-rate")?.textContent).toContain("--");
  });

  it("omits tok/s when the generation duration denominator is missing or zero", () => {
    const missing = renderCapsule({ session: { outputTokens: 100, requestCount: 1 } });
    expect(item(missing.container, "average-tokens-per-second")?.textContent).toContain("--");
    const zero = renderCapsule({
      session: { outputTokens: 100, generationDurationMs: 0, requestCount: 1 },
    });
    expect(item(zero.container, "average-tokens-per-second")?.textContent).toContain("--");
  });

  it("never derives the session average from a single request TTFT", () => {
    // 没有 TTFT 采样累计时，宁可不可用，也不拿某个请求的耗时冒充会话均值。
    const { container } = renderCapsule({
      session: { outputTokens: 100, generationDurationMs: 1_000, requestCount: 3 },
      lastRequest: { timeToFirstTokenMs: 500 },
    });
    expect(item(container, "average-ttft")?.textContent).toContain("--");
  });

  it("clamps a dirty cache read ratio to 100%", () => {
    const { container } = renderCapsule({
      session: { inputTokens: 100, cacheReadTokens: 150, requestCount: 1 },
    });
    expect(item(container, "cache-hit-rate")?.textContent).toContain("100%");
  });

  it("hides the latest-request group when the session has a single request", () => {
    const { container } = renderCapsule({
      session: { ...sessionUsage, requestCount: 1 },
      lastRequest,
    });
    expect(item(container, "last-request-ttft")).toBeNull();
    expect(item(container, "last-request-cache-hit-rate")).toBeNull();
  });

  it("formats session aggregates from CLI sums without a second aggregation", () => {
    // CLI 已求和/计数；UI 只做除法与百分比，不做二次聚合。
    expect(
      formatComposerSessionUsage(
        {
          outputTokens: 50,
          generationDurationMs: 2_000,
          timeToFirstTokenTotalMs: 640,
          timeToFirstTokenSamples: 2,
          inputTokens: 1_000,
          cacheReadTokens: 250,
          requestCount: 2,
        },
        "en-US",
      ),
    ).toEqual({
      averageTimeToFirstToken: "0.3s",
      averageTokensPerSecond: "25",
      inputTokens: "1,000",
      outputTokens: "50",
      cacheHitRate: "25%",
      inputTokensExact: null,
      outputTokensExact: null,
    });
  });

  it("switches big totals to compact units and keeps the exact number as a tooltip", () => {
    const display = formatComposerSessionUsage(
      {
        inputTokens: 147_340_477,
        outputTokens: 318_103,
        cacheReadTokens: 145_435_907,
        requestCount: 570,
      },
      "en-US",
    );
    expect(display.inputTokens).toBe("147M");
    expect(display.outputTokens).toBe("318K");
    // 十万以下不压缩：精确值比 7.29K 更好核对。
    expect(
      formatComposerSessionUsage({ inputTokens: 92_813, requestCount: 1 }, "en-US").inputTokens,
    ).toBe("92,813");
    expect(display.inputTokensExact).toBe("147,340,477");
    expect(display.outputTokensExact).toBe("318,103");
  });

  it("exposes the exact total as the title attribute when compacted", () => {
    const { container } = renderCapsule({
      session: { inputTokens: 147_340_477, outputTokens: 318_103, requestCount: 570 },
    });
    expect(item(container, "input-tokens")?.getAttribute("title")).toBe("147,340,477");
    expect(item(container, "output-tokens")?.getAttribute("title")).toBe("318,103");
  });
});

describe("deriveComposerTurnMetricsFact", () => {
  const usage = { ...sessionUsage };
  const completedHeader = { kind: "turnHeader", lastRequest };
  const userRow = { kind: "userInput" };

  it("combines the session cumulative with the latest request facts", () => {
    expect(deriveComposerTurnMetricsFact([userRow, completedHeader], usage)).toEqual({
      session: sessionUsage,
      lastRequest,
    });
  });

  it("keeps the previous turn's last request while the new turn has none yet", () => {
    // 新主轮 header 已建但 ModelComplete 未到：lastRequest 缺席，必须回落上一轮。
    const newRunningHeader = { kind: "turnHeader" };
    expect(
      deriveComposerTurnMetricsFact([completedHeader, userRow, newRunningHeader], usage),
    ).toEqual({ session: sessionUsage, lastRequest });
  });

  it("returns the session alone when no turn header carries a last request", () => {
    expect(deriveComposerTurnMetricsFact([userRow], usage)).toEqual({ session: sessionUsage });
  });

  it("returns the last request alone when the snapshot has no session usage yet", () => {
    expect(deriveComposerTurnMetricsFact([completedHeader])).toEqual({ lastRequest });
  });

  it("returns null when neither source has facts", () => {
    expect(deriveComposerTurnMetricsFact([userRow])).toBeNull();
    expect(deriveComposerTurnMetricsFact(undefined, {})).toBeNull();
  });
});
