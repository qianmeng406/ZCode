# Composer Turn Metrics

## Behavior

The composer displays the latest main-turn metrics below the input editor: time to first token, output generation speed, and output token count, followed inline by every other separately attributable fact for the turn, the latest model request, and the session. Only usage facts with `querySource === "main_turn"` contribute. Missing or invalid timing values render an unavailable placeholder (`--`) rather than a browser-clock estimate. The projection is optional for compatibility and survives snapshot restoration.

- TTFT：本 turn 第一个携带 `timings` 的 main `ModelComplete` 提供 `firstTokenAt - startedAt`；后续 model step 不覆盖。
- Speed：`sum(outputTokens) / sum(generationDurationMs)`，多 model step 同轮聚合；分母缺失或为 0 时不展示导数。
- Output tokens：turnHeader 现有 `outputTokens` 累计（逐 main `ModelComplete` 求和）。
- 卡片三组事实（全部内联，不做二级面板；容器 flex-wrap，窄屏按组换行）：
  - 本轮：TTFT、速度、输出、推理、可见输出（输出 − 推理）、生成时长、请求数、输入、缓存读、缓存写；
  - 上次请求：TTFT、输出、单请求速度（`lastRequest` 每次覆盖，不累计）；
  - 会话：累计输出、会话平均速度、请求数（`snapshot.usage.cumulative`）。
- 三个核心分段（TTFT / 速度 / 输出）恒定渲染，缺值显示 `--`；其余分段只在事实存在时渲染，不用 0 冒充。
- 派生规则：可见输出只在输出与推理两个事实都在且输出 ≥ 推理时给值。
- 最近完成轮保留：胶囊事实源是 snapshot 中最近一个 `turnHeader` 行；新主轮有真实值时随权威事件更新。
- 运行中不显示假 live 值：事实到达前（流式进行中）维持上一轮值或 `--`，不做字符数换算。

## Ownership & event order

状态只走一条链，无第二写者：

```
core runtime (turn-model-step)
  └─ ModelComplete{querySource:"main_turn", usage, timings{startedAt, firstTokenAt, generationDurationMs}}
       （firstTokenAt 读取持久化 ModelStreaming 首个非空 delta 事件时间戳，与 usage-observability 同口径）
bootstrap ProductProjection.onModelComplete（唯一所有者）
  └─ 严格 querySource==="main_turn" 过滤 → row.upserted(turnHeader){
         outputTokens(+=), inputTokens(+=), reasoningTokens(+=),
         cacheReadTokens(+=), cacheWriteTokens(+=), requestCount(+=1),
         timeToFirstTokenMs(首个, 不覆盖), generationDurationMs(+=),
         lastRequest(每次覆盖) }
       └─ state.updated(usage.cumulative){ tokens(+=), generationDurationMs(+=), requestCount(+=1) }
       └─ ConversationDelta → snapshot.rows.window / snapshot.usage（conflation 传输）
UI ConversationComposer（只读格式化）
  └─ 从 snapshot 最近 turnHeader + usage.cumulative 派生 fact
       → ComposerTurnMetricsCapsule 渲染三组内联分段
```

- 冷恢复：durable transcript 合成的 `ModelComplete` 为零 usage 且无 `timings`，不产生指标；同进程 warm 恢复的内存权威事件携带 `timings` 并重新聚合。聚合存于投影行，重启后由事件重放恢复，不单独持久化。
- 非主轮（compact / session_title / subagent / workflow_child）与 controlOnly 轮从不写入这些字段。

## Compatibility

Metric fields are optional so older snapshots and mixed-version peers continue to parse. Non-main turns, compact operations, subagents, and workflow children never overwrite the latest main-turn metrics. Old `ModelComplete` events without `timings` contribute only `outputTokens`; TTFT and speed stay unavailable instead of being estimated. Turn usage details (`inputTokens` / `reasoningTokens` / cache tokens / `requestCount` / `lastRequest`) and the cumulative `generationDurationMs` / `requestCount` are additive optional fields.

会话累计（`usage.cumulative`）与既有 token 累计同生命周期：进程内累计、冷开从 0 起，不是会话历史总量。UI 不得把它标注成"历史总计"；需要跨重启的累计应走 turn_usage 持久化查询，不在本 feature 范围内。

## Acceptance

- A completed main turn shows TTFT, tok/s, and output tokens.
- The card lists turn, latest-request, and session facts inline; detail segments whose fact is absent are omitted instead of showing 0, while the three core segments keep `--`.
- `visibleOutput` only renders when both output and reasoning facts exist and output ≥ reasoning.
- Session cumulative speed renders only when the cumulative generation duration is present and positive.
- Subagent/workflow/compact activity does not change the main-turn capsule or the session cumulative counters.
- Missing TTFT or generation duration shows an unavailable value.
- The capsule remains readable at narrow widths (tok/s segment hides below 480px container width) and in both active themes.
- Shared test-id anchors: `TID_COMPOSER_TURN_METRICS` (`composer-turn-metrics`) and `TID_COMPOSER_TURN_METRICS_ITEM` (`composer-turn-metrics-item` with `ttft` / `tokens-per-second` / `output-tokens` suffixes).
- i18n keys `chat.composer.turnMetrics.ttft` / `.tokensPerSecond` / `.outputTokens` in zh-CN and en-US.

## Non-goals

This feature does not add a metrics history view, telemetry export, or client-side timing approximation.
