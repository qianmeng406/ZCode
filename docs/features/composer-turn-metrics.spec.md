# Composer Turn Metrics

## Behavior

The composer displays session-level usage below the input editor as a **single line** of eight segments: average first-token latency, average speed, total input, total output, and cache hit rate for the session, then a divider and the same three per-request facts (first token, speed, cache hit rate) for the latest model request. Only usage facts with `querySource === "main_turn"` contribute. Missing or invalid values render an unavailable placeholder (`--`) rather than a browser-clock estimate. The projection is optional for compatibility and survives snapshot restoration.

- 会话五项来自 `snapshot.usage.cumulative`（CLI 在权威 `ModelComplete` 处累计）：
  - 平均首 token：`timeToFirstTokenTotalMs / timeToFirstTokenSamples`，逐请求采样后求均值；不用 `requestCount` 作分母（无 `timings` 的请求不参与均值）。
  - 平均速度：`outputTokens / generationDurationMs`；分母缺失或为 0 时不展示导数。口径为墙钟（含各请求 TTFT），与"上次请求 速度"一致。
  - 总输入 / 总输出：`inputTokens` / `outputTokens` 累计。`inputTokens` 按 token-usage 约定已包含缓存读/写。
  - 单位自适应：token 累计 ≥ 10 万切紧凑单位（zh 万/亿、en K/M/B，3 位有效数字），低于 10 万保留完整千分位；紧凑显示时把精确值放进原生 `title`，悬浮可核对完整数字。
  - 缓存命中率：`cacheReadTokens / inputTokens`，取整百分比；上游脏数据（`cacheRead > input`）夹到 100%，不显示超过 100% 的值。
- 上次请求三项来自最近一个带 `lastRequest` 的 turnHeader（每次覆盖，不累计）：TTFT、`outputTokens / generationDurationMs`、`cacheReadTokens / inputTokens`。
- 单行排版（不做二级面板）：会话五项恒定渲染，缺值 `--`；竖线后接上次请求三项。
- 上次请求组仅在会话 `requestCount > 1` 时出现：会话只有一次请求时它与前半段完全重复。
- 会话累计未知（`requestCount` 为 0/缺席且 token 全 0）时五项全部显示 `--`，不把"还没有事实"渲染成 0。
- 运行中不显示假 live 值：事实到达前（流式进行中）维持上一轮值或 `--`，不做字符数换算。
- 宽度不足时按分段换行（`flex-wrap`），不做横向滚动或省略；窄屏不再单独隐藏某个分段。

## Ownership & event order

状态只走一条链，无第二写者：

```
core runtime (turn-model-step)
  └─ ModelComplete{querySource:"main_turn", usage, timings{startedAt, firstTokenAt, generationDurationMs}}
       （firstTokenAt 读取持久化 ModelStreaming 首个非空 delta 事件时间戳，与 usage-observability 同口径）
bootstrap ProductProjection.onModelComplete（唯一所有者）
  ├─ 严格 querySource==="main_turn" 过滤 → row.upserted(turnHeader){
  │      outputTokens(+=), inputTokens(+=), reasoningTokens(+=),
  │      cacheReadTokens(+=), cacheWriteTokens(+=), requestCount(+=1),
  │      timeToFirstTokenMs(首个, 不覆盖), generationDurationMs(+=),
  │      lastRequest(每次覆盖, 含单请求 input/cacheRead) }
  └─ state.updated(usage.cumulative){ tokens(+=), requestCount(+=1),
         generationDurationMs(+=), timeToFirstTokenTotalMs(+=), timeToFirstTokenSamples(+=1) }
       └─ ConversationDelta → snapshot.rows.window / snapshot.usage（conflation 传输）
UI ConversationComposer（只读格式化）
  └─ 从 snapshot.usage.cumulative + 最近带 lastRequest 的 turnHeader 派生 fact
       → ComposerTurnMetricsCapsule 渲染单行八段
```

- 冷恢复：durable transcript 合成的 `ModelComplete` 为零 usage 且无 `timings`，不产生指标；同进程 warm 恢复的内存权威事件携带 `timings` 并重新聚合。聚合存于投影行与 `usage.cumulative`。
- 非主轮（compact / session_title / subagent / workflow_child）与 controlOnly 轮从不写入这些字段。

## Compatibility

Metric fields are optional so older snapshots and mixed-version peers continue to parse. Non-main turns, compact operations, subagents, and workflow children never overwrite the main-turn metrics. Old `ModelComplete` events without `timings` contribute only tokens and the request count; TTFT, average TTFT, and speed stay unavailable instead of being estimated.

`usage.cumulative` 的 `generationDurationMs` / `requestCount` / `timeToFirstTokenTotalMs` / `timeToFirstTokenSamples` 是 additive optional 字段。它们与既有 token 累计**同生命周期**：进程内累计、冷开从 0 起，不是会话历史总量。UI 不得把它标注成"历史总计"；需要跨重启的历史总量应走 `turn_usage` / `model_usage` 持久化查询，不在本 feature 范围内。

## Acceptance

- A completed main turn shows the eight segments in one row: session average first token, session average speed, session total input, session total output, session cache hit rate, then last request's first token, speed, and cache hit rate.
- Session segments are always rendered; unknown or missing facts show `--` instead of 0 or an estimate.
- Session average first token equals `timeToFirstTokenTotalMs / timeToFirstTokenSamples` and is never derived from a single request.
- Session cache hit rate equals `cacheReadTokens / inputTokens` and never exceeds 100%.
- Token totals switch to compact units at 100k and keep the exact value in the `title` attribute.
- The latest-request group is hidden when the session has only one request.
- Subagent/workflow/compact activity does not change the session cumulative counters or the last-request facts.
- The card wraps by segment at narrow widths instead of overflowing, and stays readable in both active themes.
- Shared test-id anchors: `TID_COMPOSER_TURN_METRICS` (`composer-turn-metrics`) and `TID_COMPOSER_TURN_METRICS_ITEM` (`composer-turn-metrics-item` with `average-ttft` / `average-tokens-per-second` / `input-tokens` / `output-tokens` / `cache-hit-rate` / `last-request-ttft` / `last-request-tokens-per-second` / `last-request-cache-hit-rate` suffixes).
- i18n keys `chat.composer.turnMetrics.averageTtft` / `.averageSpeed` / `.totalInput` / `.totalOutput` / `.cacheHitRate` / `.ttft` / `.tokensPerSecond` / `.sectionLastRequest` in zh-CN and en-US.

## Non-goals

This feature does not add a metrics history view, telemetry export, or client-side timing approximation.
