/**
 * Composer 输入框下方的会话指标卡片（单行）。
 *
 * 事实源：v4 ConversationSnapshot。
 * - 前半段是**会话级**累计：`usage.cumulative` 的 token / 缓存读 / 请求数，
 *   由 CLI 投影在权威 ModelComplete 处累加（仅 main_turn）；
 * - 后半段是**单请求**事实：最近一个带 `lastRequest` 的 turnHeader；
 * - 轮次位置（第 N 轮 · 第 M 步）与单请求事实取自同一个 turnHeader。
 * 本组件只做格式化与呈现：不维护第二份状态、不做浏览器时钟估算、不用字符数冒充 token。
 *
 * 排版：一行——轮次位置 + 会话三项（总输入 / 总输出 / 缓存命中率），
 * 竖线后接上次请求三项（首 token / 速度 / 缓存命中率）。会话三项恒定渲染，缺值 `--`；
 * 轮次位置缺任一侧事实时整段不渲染；会话只有一次请求时上次请求组隐藏。
 */
import { memo, useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_COMPOSER_TURN_METRICS,
  TID_COMPOSER_TURN_METRICS_ITEM,
  testId,
} from "@zcode/shared/test-ids";

export interface ComposerLastRequestMetrics {
  outputTokens?: number;
  timeToFirstTokenMs?: number;
  generationDurationMs?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
}

/** snapshot.usage.cumulative 中本卡片用到的字段（全部是会话级累计）。 */
export interface ComposerSessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  requestCount?: number;
}

export interface ComposerTurnMetricsFact {
  /** 会话级累计；缺席表示快照还没带会话用量（旧 CLI / 冷开首帧）。 */
  session?: ComposerSessionUsage;
  /** 最近一次 main model request 的单请求事实（覆盖，不累计）。 */
  lastRequest?: ComposerLastRequestMetrics;
  /** 上次请求所在的产品轮位置；与 lastRequest 同源，缺一侧事实时不渲染。 */
  lastRequestTurn?: { ordinal: number; step: number };
}

export interface TurnMetricsDisplay {
  inputTokens: string | null;
  outputTokens: string | null;
  cacheHitRate: string | null;
  /** 总输入/总输出切到紧凑单位时保留精确值，供悬浮查看，避免"对不上账"。 */
  inputTokensExact: string | null;
  outputTokensExact: string | null;
}

const UNAVAILABLE_PLACEHOLDER = "--";
/** tok/s 保留 1 位小数；低于 0.05 显示为 0.0，避免负数/NaN 泄漏。 */
const TOKENS_PER_SECOND_FRACTION_DIGITS = 1;
/** 十万以上的 token 累计切到紧凑单位（10万 / 1.47亿 / 147M），否则九位数会把单行挤爆。 */
const COMPACT_TOKEN_THRESHOLD = 100_000;

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

/**
 * token 累计的单位自适应：十万以下保留完整千分位（7,290 比 7.29K 更好核对），
 * 十万以上切紧凑单位（zh 万/亿、en K/M/B），3 位有效数字。
 * 精确值由调用方通过 title 保留，悬浮仍可看到完整数字。
 */
function formatTokenCount(value: number, locale: string): string {
  if (value < COMPACT_TOKEN_THRESHOLD) return formatCount(value, locale);
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumSignificantDigits: 3,
  }).format(value);
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

/**
 * 缓存命中率 = cacheRead / input（input 已包含缓存读/写，见 token-usage.md）。
 * 上游偶发 cacheRead > input 的脏数据，夹到 100% 而不是显示 137% 这种不可能值。
 */
function formatCacheHitRate(
  cacheReadTokens: number | undefined,
  inputTokens: number | undefined,
  locale: string,
): string | null {
  if (
    cacheReadTokens === undefined ||
    cacheReadTokens < 0 ||
    inputTokens === undefined ||
    inputTokens <= 0
  ) {
    return null;
  }
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.min(1, cacheReadTokens / inputTokens));
}

/**
 * 会话是否已有可用累计：旧快照只有 token 字段、没有 requestCount。
 */
function hasSessionUsage(session: ComposerSessionUsage | undefined): boolean {
  if (!session) return false;
  return (
    (session.requestCount ?? 0) > 0 ||
    (session.inputTokens ?? 0) > 0 ||
    (session.outputTokens ?? 0) > 0
  );
}

export function formatComposerSessionUsage(
  session: ComposerSessionUsage | undefined,
  locale: string,
): TurnMetricsDisplay {
  if (!session || !hasSessionUsage(session)) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheHitRate: null,
      inputTokensExact: null,
      outputTokensExact: null,
    };
  }
  const inputTokens =
    session.inputTokens !== undefined && session.inputTokens > 0
      ? formatTokenCount(session.inputTokens, locale)
      : null;
  const outputTokens =
    session.outputTokens !== undefined && session.outputTokens > 0
      ? formatTokenCount(session.outputTokens, locale)
      : null;
  return {
    inputTokens,
    outputTokens,
    cacheHitRate: formatCacheHitRate(session.cacheReadTokens, session.inputTokens, locale),
    inputTokensExact:
      session.inputTokens !== undefined && session.inputTokens >= COMPACT_TOKEN_THRESHOLD
        ? formatCount(session.inputTokens, locale)
        : null,
    outputTokensExact:
      session.outputTokens !== undefined && session.outputTokens >= COMPACT_TOKEN_THRESHOLD
        ? formatCount(session.outputTokens, locale)
        : null,
  };
}

interface MetricItem {
  /** 稳定 key，同时作为 test-id 后缀。 */
  key: string;
  label: string;
  value: string;
  suffix?: string;
  /** 紧凑显示时的精确值（原生悬浮提示），用于核对完整数字。 */
  title?: string;
}

function TurnMetricsItem({ item }: { item: MetricItem }) {
  return (
    <span
      data-testid={testId(TID_COMPOSER_TURN_METRICS_ITEM, item.key)}
      title={item.title}
      // shrink-0：分段内容 nowrap，被 flex 压缩时会溢出到相邻分段造成文字重叠。
      className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap"
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
  // 稳定引用：明细 useMemo 依赖它，不能每次渲染新建函数。
  const label = useCallback(
    (id: string) => intl.formatMessage({ id: `chat.composer.turnMetrics.${id}` }),
    [intl],
  );

  // 轮次位置只由事实派生：turnOrdinal / requestCount 必须同时在场，
  // 否则整段留空——不按窗口行数或时间戳猜一个"第 N 轮"。
  const turnStepText = useMemo(() => {
    const position = fact?.lastRequestTurn;
    // 序号与步数都必须是正整数；不合法的输入整段不渲染，不产出"第 0 轮"。
    if (!position || position.ordinal <= 0 || position.step <= 0) return null;
    return intl.formatMessage(
      { id: "chat.composer.turnMetrics.turnStep" },
      { turn: String(position.ordinal), step: String(position.step) },
    );
  }, [fact?.lastRequestTurn, intl]);

  const sessionItems = useMemo<MetricItem[]>(() => {
    const display = formatComposerSessionUsage(fact?.session, locale);
    // 三项恒定渲染：缺值是明确的 `--` 占位，不显示假 live 值，行宽也不随事实到达跳动。
    return [
      {
        key: "input-tokens",
        label: label("totalInput"),
        value: display.inputTokens ?? UNAVAILABLE_PLACEHOLDER,
        ...(display.inputTokensExact ? { title: display.inputTokensExact } : {}),
      },
      {
        key: "output-tokens",
        label: label("totalOutput"),
        value: display.outputTokens ?? UNAVAILABLE_PLACEHOLDER,
        ...(display.outputTokensExact ? { title: display.outputTokensExact } : {}),
      },
      {
        key: "cache-hit-rate",
        label: label("cacheHitRate"),
        value: display.cacheHitRate ?? UNAVAILABLE_PLACEHOLDER,
      },
    ];
  }, [fact?.session, locale, label]);

  const lastRequestItems = useMemo<MetricItem[]>(() => {
    const last = fact?.lastRequest;
    if (!last) return [];
    const items: MetricItem[] = [];
    const push = (key: string, text: string, value: string | null, suffix?: string) => {
      if (value !== null) items.push({ key, label: text, value, ...(suffix ? { suffix } : {}) });
    };
    push(
      "last-request-ttft",
      label("ttft"),
      last.timeToFirstTokenMs !== undefined
        ? formatDurationMs(last.timeToFirstTokenMs, locale)
        : null,
    );
    push(
      "last-request-tokens-per-second",
      label("tokensPerSecond"),
      formatTokensPerSecond(last.outputTokens, last.generationDurationMs, locale),
      " tok/s",
    );
    push(
      "last-request-cache-hit-rate",
      label("cacheHitRate"),
      formatCacheHitRate(last.cacheReadTokens, last.inputTokens, locale),
    );
    return items;
  }, [fact?.lastRequest, locale, label]);

  // 会话只有一次请求时，单请求事实与会话累计完全重复，直接隐藏。
  const showLastRequest = lastRequestItems.length > 0 && (fact?.session?.requestCount ?? 2) > 1;

  return (
    <div
      data-testid={TID_COMPOSER_TURN_METRICS}
      className={cn(
        // 单行优先；宽度不够时按分段换行（flex-wrap），不做横向滚动或省略。
        "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md px-2 py-1",
        "bg-surface-hover/50 text-ui-xs",
        className,
      )}
    >
      {turnStepText ? (
        <span
          data-testid={testId(TID_COMPOSER_TURN_METRICS_ITEM, "turn-step")}
          className="inline-flex shrink-0 items-baseline whitespace-nowrap tabular-nums text-foreground-subtle"
        >
          {turnStepText}
        </span>
      ) : null}
      {sessionItems.map((item) => (
        <TurnMetricsItem key={item.key} item={item} />
      ))}
      {showLastRequest ? (
        <>
          <span aria-hidden className="h-3 w-px shrink-0 self-center bg-border" />
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {label("sectionLastRequest")}
          </span>
          {lastRequestItems.map((item) => (
            <TurnMetricsItem key={item.key} item={item} />
          ))}
        </>
      ) : null}
    </div>
  );
});
