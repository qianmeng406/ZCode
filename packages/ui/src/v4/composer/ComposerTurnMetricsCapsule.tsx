/**
 * Composer 输入框下方的 main-turn 指标胶囊。
 *
 * 事实源：v4 ConversationSnapshot 最近一个 turnHeader 行的轮指标字段
 * （outputTokens / timeToFirstTokenMs / generationDurationMs），全部由 CLI
 * 投影从权威 ModelComplete.timings 聚合而来。本组件只做格式化与响应式呈现：
 * 不维护第二份轮次状态、不做浏览器时钟估算、不用字符数冒充 token。
 * 任一字段缺席（旧快照 / 非流式 / 冷恢复旧转录）渲染 `--` 占位。
 */
import { memo, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { TID_COMPOSER_TURN_METRICS, TID_COMPOSER_TURN_METRICS_ITEM, testId } from "@zcode/shared";

export interface ComposerTurnMetricsFact {
  outputTokens?: number;
  timeToFirstTokenMs?: number;
  /** sum(main step generationDurationMs)；speed 的分母。 */
  generationDurationMs?: number;
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

export function formatComposerTurnMetrics(
  fact: ComposerTurnMetricsFact,
  locale: string,
): TurnMetricsDisplay {
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const secondsFormat = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  // < 10s 保留 1 位小数（sub-second TTFT 是常态）；≥ 10s 整秒即可。
  const formatMs = (ms: number): string =>
    ms >= 10_000
      ? `${numberFormat.format(Math.round(ms / 1000))}s`
      : `${secondsFormat.format(Math.round(ms / 100) / 10)}s`;
  return {
    timeToFirstToken:
      typeof fact.timeToFirstTokenMs === "number" && fact.timeToFirstTokenMs >= 0
        ? formatMs(fact.timeToFirstTokenMs)
        : null,
    // speed = sum(outputTokens) / sum(generationDurationMs)，多 model step 同轮聚合口径；
    // 分母缺失或为 0 时不展示导数，宁可显示不可用也不估算。
    tokensPerSecond:
      typeof fact.generationDurationMs === "number" &&
      fact.generationDurationMs > 0 &&
      typeof fact.outputTokens === "number" &&
      fact.outputTokens > 0
        ? new Intl.NumberFormat(locale, {
            maximumFractionDigits: TOKENS_PER_SECOND_FRACTION_DIGITS,
          }).format((fact.outputTokens * 1000) / fact.generationDurationMs)
        : null,
    outputTokens:
      typeof fact.outputTokens === "number" && fact.outputTokens > 0
        ? numberFormat.format(fact.outputTokens)
        : null,
  };
}

function TurnMetricsItem({
  label,
  value,
  suffix,
  testSuffix,
  className,
}: {
  label: string;
  value: string;
  suffix?: string;
  testSuffix: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId(TID_COMPOSER_TURN_METRICS_ITEM, testSuffix)}
      // shrink-0：分段内容 nowrap，被 flex 压缩时会溢出到相邻分段造成文字重叠
      // （用户实测截图）。放不下时由容器 flex-wrap 换行，而不是压缩分段。
      className={cn("inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap", className)}
    >
      <span className="text-ui-xs text-foreground-subtle">{label}</span>
      {/* 等宽数字：数值变化不抖动胶囊宽度。 */}
      <span className="font-mono text-ui-xs tabular-nums text-foreground">
        {value}
        {suffix ? <span className="text-foreground-subtle">{suffix}</span> : null}
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
  // 无有效事实（无 fact 或三项全缺席）时仍渲染 `--` 胶囊保持布局稳定；
  // 运行中绝不显示假 live 值，事实到达前一律是明确的不可用占位。
  const display = useMemo(() => formatComposerTurnMetrics(fact ?? {}, locale), [fact, locale]);
  return (
    <div
      data-testid={TID_COMPOSER_TURN_METRICS}
      className={cn(
        // 容器可换行：分段 shrink-0 后放不下时整段换到下一行，不再互相叠压。
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-full px-2 py-0.5",
        "bg-surface-hover/60 text-ui-xs",
        className,
      )}
    >
      <TurnMetricsItem
        label={intl.formatMessage({ id: "chat.composer.turnMetrics.ttft" })}
        value={display.timeToFirstToken ?? UNAVAILABLE_PLACEHOLDER}
        testSuffix="ttft"
      />
      <TurnMetricsItem
        label={intl.formatMessage({ id: "chat.composer.turnMetrics.tokensPerSecond" })}
        value={display.tokensPerSecond ?? UNAVAILABLE_PLACEHOLDER}
        suffix={display.tokensPerSecond !== null ? " tok/s" : undefined}
        testSuffix="tokens-per-second"
        className={`${NARROW_HIDE_SPEED_CONTAINER_QUERY}:hidden`}
      />
      <TurnMetricsItem
        label={intl.formatMessage({ id: "chat.composer.turnMetrics.outputTokens" })}
        value={display.outputTokens ?? UNAVAILABLE_PLACEHOLDER}
        testSuffix="output-tokens"
      />
    </div>
  );
});
