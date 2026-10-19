/**
 * Composer 输入框下方的 main-turn 指标卡片。
 *
 * 事实源：v4 ConversationSnapshot 最近一个 turnHeader 行的轮指标字段
 * （output / input / reasoning / cache token、TTFT、generationDurationMs、requestCount、
 * lastRequest），全部由 CLI 投影从权威 ModelComplete.usage/timings 聚合而来。
 * 本组件只做格式化与呈现：不维护第二份轮次状态、不做浏览器时钟估算、
 * 不用字符数冒充 token。
 *
 * 排版：三行结构——核心三项（首 token / 速度 / 输出）为第一行；本轮明细为第二行；
 * 上一请求仅在轮内请求数 > 1 时作为第三行出现（单请求时它与本轮完全重复）。
 * 缺失的明细项直接不渲染，不做二级面板。
 */
import { memo, useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { TID_COMPOSER_TURN_METRICS, TID_COMPOSER_TURN_METRICS_ITEM, testId } from "@zcode/shared";

export interface ComposerLastRequestMetrics {
  outputTokens?: number;
  timeToFirstTokenMs?: number;
  generationDurationMs?: number;
}

export interface ComposerTurnMetricsFact {
  outputTokens?: number;
  timeToFirstTokenMs?: number;
  /** sum(main step generationDurationMs)；speed 的分母。 */
  generationDurationMs?: number;
  inputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestCount?: number;
  /** 最近一次 main model request 的单请求事实（覆盖，不累计）。 */
  lastRequest?: ComposerLastRequestMetrics;
}

export interface TurnMetricsDisplay {
  timeToFirstToken: string | null;
  tokensPerSecond: string | null;
  outputTokens: string | null;
}

const UNAVAILABLE_PLACEHOLDER = "--";
/** tok/s 保留 1 位小数；低于 0.05 显示为 0.0，避免负数/NaN 泄漏。 */
const TOKENS_PER_SECOND_FRACTION_DIGITS = 1;
/** 窄屏（@container < 480px）隐藏 tok/s 分段，TTFT 与输出 token 仍是核心事实。
 *  注意：Tailwind 任意变体类名不能含空格（DOM class 按空白切分），必须用下划线写法。 */
const NARROW_HIDE_SPEED_CONTAINER_QUERY = "@max-[480px]/composer:hidden";

function formatDurationMs(ms: number, locale: string): string {
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const secondsFormat = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  // < 10s 保留 1 位小数（sub-second TTFT 是常态）；10–59s 整秒；
  // ≥ 60s 用 m/s 组合，避免把两分多钟的生成时长写成 157s 这种难读数字。
  const totalSeconds = ms >= 10_000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10;
  if (totalSeconds < 60) {
    return `${ms >= 10_000 ? numberFormat.format(totalSeconds) : secondsFormat.format(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  if (seconds === 0) return `${minutes}m`;
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m${seconds}s`;
}

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** speed = outputTokens / generationDurationMs；分母缺失或为 0 时不展示导数。 */
function formatTokensPerSecond(
  outputTokens: number | undefined,
  generationDurationMs: number | undefined,
  locale: string,
): string | null {
  if (
    outputTokens === undefined ||
    outputTokens <= 0 ||
    generationDurationMs === undefined ||
    generationDurationMs <= 0
  ) {
    return null;
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: TOKENS_PER_SECOND_FRACTION_DIGITS,
  }).format((outputTokens * 1000) / generationDurationMs);
}

export function formatComposerTurnMetrics(
  fact: ComposerTurnMetricsFact,
  locale: string,
): TurnMetricsDisplay {
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return {
    timeToFirstToken:
      typeof fact.timeToFirstTokenMs === "number" && fact.timeToFirstTokenMs >= 0
        ? formatDurationMs(fact.timeToFirstTokenMs, locale)
        : null,
    // speed = sum(outputTokens) / sum(generationDurationMs)，多 model step 同轮聚合口径；
    // 分母缺失或为 0 时不展示导数，宁可显示不可用也不估算。
    tokensPerSecond: formatTokensPerSecond(fact.outputTokens, fact.generationDurationMs, locale),
    outputTokens:
      typeof fact.outputTokens === "number" && fact.outputTokens > 0
        ? numberFormat.format(fact.outputTokens)
        : null,
  };
}

interface MetricItem {
  /** 稳定 key，同时作为 test-id 后缀。 */
  key: string;
  label: string;
  value: string;
  suffix?: string;
  className?: string;
}

function TurnMetricsItem({ item }: { item: MetricItem }) {
  return (
    <span
      data-testid={testId(TID_COMPOSER_TURN_METRICS_ITEM, item.key)}
      // shrink-0：分段内容 nowrap，被 flex 压缩时会溢出到相邻分段造成文字重叠。
      className={cn("inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap", item.className)}
    >
      <span className="text-ui-xs text-foreground-subtle">{item.label}</span>
      {/* 等宽数字：数值变化不抖动卡片宽度。 */}
      <span className="font-mono text-ui-xs tabular-nums text-foreground">
        {item.value}
        {item.suffix ? <span className="text-foreground-subtle">{item.suffix}</span> : null}
      </span>
    </span>
  );
}

export const ComposerTurnMetricsCapsule = memo(function ComposerTurnMetricsCapsule({
  fact,
  className,
}: {
  fact: ComposerTurnMetricsFact | null;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const display = useMemo(() => formatComposerTurnMetrics(fact ?? {}, locale), [fact, locale]);
  // 稳定引用：明细 useMemo 依赖它，不能每次渲染新建函数。
  const label = useCallback(
    (id: string) => intl.formatMessage({ id: `chat.composer.turnMetrics.${id}` }),
    [intl],
  );

  const detailItems = useMemo<MetricItem[]>(() => {
    if (!fact) return [];
    const items: MetricItem[] = [];
    const push = (key: string, text: string, value: string | null | undefined) => {
      if (value !== null && value !== undefined) items.push({ key, label: text, value });
    };
    push(
      "reasoning-tokens",
      label("reasoningTokens"),
      fact.reasoningTokens !== undefined ? formatCount(fact.reasoningTokens, locale) : null,
    );
    // 可见输出 = 输出 − 推理：两个事实都在时才给，避免拿缺席值当 0。
    push(
      "visible-output",
      label("visibleOutput"),
      fact.outputTokens !== undefined &&
        fact.reasoningTokens !== undefined &&
        fact.outputTokens >= fact.reasoningTokens
        ? formatCount(fact.outputTokens - fact.reasoningTokens, locale)
        : null,
    );
    push(
      "generation-duration",
      label("generationDuration"),
      fact.generationDurationMs !== undefined
        ? formatDurationMs(fact.generationDurationMs, locale)
        : null,
    );
    push(
      "request-count",
      label("requestCount"),
      fact.requestCount !== undefined ? formatCount(fact.requestCount, locale) : null,
    );
    push(
      "input-tokens",
      label("inputTokens"),
      fact.inputTokens !== undefined ? formatCount(fact.inputTokens, locale) : null,
    );
    push(
      "cache-read",
      label("cacheRead"),
      fact.cacheReadTokens !== undefined ? formatCount(fact.cacheReadTokens, locale) : null,
    );
    push(
      "cache-write",
      label("cacheWrite"),
      fact.cacheWriteTokens !== undefined ? formatCount(fact.cacheWriteTokens, locale) : null,
    );
    return items;
  }, [fact, locale, label]);

  const lastRequestItems = useMemo<MetricItem[]>(() => {
    const last = fact?.lastRequest;
    if (!last) return [];
    const items: MetricItem[] = [];
    const push = (key: string, text: string, value: string | null | undefined, suffix?: string) => {
      if (value !== null && value !== undefined) items.push({ key, label: text, value, suffix });
    };
    push(
      "last-request-ttft",
      label("ttft"),
      last.timeToFirstTokenMs !== undefined
        ? formatDurationMs(last.timeToFirstTokenMs, locale)
        : null,
    );
    push(
      "last-request-output-tokens",
      label("outputTokens"),
      last.outputTokens !== undefined ? formatCount(last.outputTokens, locale) : null,
    );
    push(
      "last-request-tokens-per-second",
      label("tokensPerSecond"),
      formatTokensPerSecond(last.outputTokens, last.generationDurationMs, locale),
      " tok/s",
    );
    return items;
  }, [fact?.lastRequest, locale, label]);

  // 单请求轮里"上次请求"与本轮完全重复，只在多请求轮展示。
  const showLastRequest = lastRequestItems.length > 0 && (fact?.requestCount ?? 0) > 1;

  return (
    <div
      data-testid={TID_COMPOSER_TURN_METRICS}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg px-2.5 py-1.5",
        "bg-surface-hover/50 text-ui-xs",
        className,
      )}
    >
      {/* 第一行：核心三项。恒定渲染，缺值是明确的 `--` 占位，不显示假 live 值。 */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <TurnMetricsItem
          item={{
            key: "ttft",
            label: label("ttft"),
            value: display.timeToFirstToken ?? UNAVAILABLE_PLACEHOLDER,
          }}
        />
        <TurnMetricsItem
          item={{
            key: "tokens-per-second",
            label: label("tokensPerSecond"),
            value: display.tokensPerSecond ?? UNAVAILABLE_PLACEHOLDER,
            suffix: display.tokensPerSecond !== null ? " tok/s" : undefined,
            className: `${NARROW_HIDE_SPEED_CONTAINER_QUERY}:hidden`,
          }}
        />
        <TurnMetricsItem
          item={{
            key: "output-tokens",
            label: label("outputTokens"),
            value: display.outputTokens ?? UNAVAILABLE_PLACEHOLDER,
          }}
        />
      </div>
      {detailItems.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1">
          {detailItems.map((item) => (
            <TurnMetricsItem key={item.key} item={item} />
          ))}
        </div>
      ) : null}
      {showLastRequest ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {label("sectionLastRequest")}
          </span>
          {lastRequestItems.map((item) => (
            <TurnMetricsItem key={item.key} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
});
