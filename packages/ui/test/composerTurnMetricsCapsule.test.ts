// @vitest-environment jsdom

// Composer 会话指标卡片黄金测试：
// - 单行七段：轮次位置（第 N 轮 · 第 M 步）+ 会话三项（总输入 / 总输出 / 缓存命中率）
//   + 上次请求三项（首 token / 速度 / 缓存命中率）；
// - 会话级取自 usage.cumulative，单请求与轮次位置取自同一个带 lastRequest 的 turnHeader；
// - 缺失字段 → `--` 占位，绝不估算；轮次/步数缺一即整段不渲染；
// - 缓存命中率 = cacheRead / input，脏数据夹到 100%；
// - 共享 test-id 锚点（TID_COMPOSER_TURN_METRICS / _ITEM）。
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  TID_COMPOSER_TURN_METRICS,
  TID_COMPOSER_TURN_METRICS_ITEM,
  testId,
} from "@zcode/shared/test-ids";

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
  requestCount: 2,
};

const lastRequest = {
  outputTokens: 100,
  timeToFirstTokenMs: 200,
  generationDurationMs: 1_000,
  inputTokens: 800,
  cacheReadTokens: 400,
};

const lastRequestTurn = { ordinal: 12, step: 3 };

describe("ComposerTurnMetricsCapsule", () => {
  it("renders the seven inline segments with shared test-id anchors", () => {
    const { container, getByTestId } = renderCapsule({
      session: sessionUsage,
      lastRequest,
      lastRequestTurn,
    });
    expect(getByTestId(TID_COMPOSER_TURN_METRICS)).toBeTruthy();
    expect(item(container, "turn-step")?.textContent).toContain("第 12 轮 · 第 3 步");
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
    for (const key of ["input-tokens", "output-tokens", "cache-hit-rate"]) {
      expect(item(container, key)?.textContent).toContain("--");
    }
    // 没有单请求事实就没有轮次位置，不按窗口行数猜一个序号。
    expect(item(container, "turn-step")).toBeNull();
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

  it("omits the turn position when the header lacks an ordinal or a valid step", () => {
    // 旧快照没有 turnOrdinal：位置整段不渲染。
    const withoutOrdinal = renderCapsule({ session: sessionUsage, lastRequest });
    expect(item(withoutOrdinal.container, "turn-step")).toBeNull();
    // 步数为 0 同样不渲染，绝不回退成“第 12 轮”。
    const zeroStep = renderCapsule({
      session: sessionUsage,
      lastRequest,
      lastRequestTurn: { ordinal: 12, step: 0 },
    });
    expect(item(zeroStep.container, "turn-step")).toBeNull();
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
      lastRequestTurn,
    });
    expect(item(container, "last-request-ttft")).toBeNull();
    expect(item(container, "last-request-cache-hit-rate")).toBeNull();
    // 轮次位置描述的是最近一次请求，单请求会话仍然保留。
    expect(item(container, "turn-step")?.textContent).toContain("第 12 轮 · 第 3 步");
  });

  it("formats session aggregates from CLI sums without a second aggregation", () => {
    // CLI 已求和/计数；UI 只做格式化与百分比，不做二次聚合。
    expect(
      formatComposerSessionUsage(
        {
          outputTokens: 50,
          inputTokens: 1_000,
          cacheReadTokens: 250,
          requestCount: 2,
        },
        "en-US",
      ),
    ).toEqual({
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
  const completedHeader = {
    kind: "turnHeader",
    turnOrdinal: 12,
    requestCount: 3,
    lastRequest,
  };
  const userRow = { kind: "userInput" };

  it("combines the session cumulative with the latest request facts and position", () => {
    expect(deriveComposerTurnMetricsFact([userRow, completedHeader], usage)).toEqual({
      session: sessionUsage,
      lastRequest,
      lastRequestTurn,
    });
  });

  it("keeps the previous turn's position while the new turn has none yet", () => {
    // 新主轮 header 已建但 ModelComplete 未到：lastRequest 缺席，必须回落上一轮。
    const newRunningHeader = { kind: "turnHeader", turnOrdinal: 13 };
    expect(
      deriveComposerTurnMetricsFact([completedHeader, userRow, newRunningHeader], usage),
    ).toEqual({ session: sessionUsage, lastRequest, lastRequestTurn });
  });

  it("omits the position when the header has no ordinal or step", () => {
    const legacyHeader = { kind: "turnHeader", lastRequest };
    expect(deriveComposerTurnMetricsFact([legacyHeader], usage)).toEqual({
      session: sessionUsage,
      lastRequest,
    });
  });

  it("returns the session alone when no turn header carries a last request", () => {
    expect(deriveComposerTurnMetricsFact([userRow], usage)).toEqual({ session: sessionUsage });
  });

  it("returns the last request alone when the snapshot has no session usage yet", () => {
    expect(deriveComposerTurnMetricsFact([completedHeader])).toEqual({
      lastRequest,
      lastRequestTurn,
    });
  });

  it("returns null when neither source has facts", () => {
    expect(deriveComposerTurnMetricsFact([userRow])).toBeNull();
    expect(deriveComposerTurnMetricsFact(undefined, {})).toBeNull();
  });
});
