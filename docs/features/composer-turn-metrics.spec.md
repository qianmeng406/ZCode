# Composer Turn Metrics

## Behavior

The composer displays session-level usage below the input editor as a **single line of seven segments**: the position of the latest main request (`第 N 轮 · 第 M 步`), session total input, total output, and cache hit rate, then a divider and the latest request's first-token latency, speed, and cache hit rate. Only usage facts with `querySource === "main_turn"` contribute. Missing or invalid values render an unavailable placeholder (`--`) rather than a browser-clock estimate; the position segment is omitted entirely when its facts are unavailable instead of inventing a turn number. The projection is optional for compatibility and survives snapshot restoration.

- 轮次位置来自提供 `lastRequest` 的那个 turnHeader：`turnOrdinal` 是会话内可见产品轮序号（CLI 投影在创建 turnHeader 时分配，1 起），`requestCount` 是该轮已完成的 main 请求数（即"步"）。两者齐备才渲染 `第 {turn} 轮 · 第 {step} 步`；任一缺席（旧 CLI / 旧快照 / 系统轮）时不显示位置，UI 不按窗口行数自行推断轮次。
- 会话三项来自 `snapshot.usage.cumulative`（CLI 在权威 `ModelComplete` 处累计）：
  - 总输入 / 总输出：`inputTokens` / `outputTokens` 累计。`inputTokens` 按 token-usage 约定已包含缓存读/写。
  - 单位自适应：token 累计 ≥ 10 万切紧凑单位（zh 万/亿、en K/M/B，3 位有效数字），低于 10 万保留完整千分位；紧凑显示时把精确值放进原生 `title`，悬浮可核对完整数字。
  - 缓存命中率：`cacheReadTokens / inputTokens`，取整百分比；上游脏数据（`cacheRead > input`）夹到 100%，不显示超过 100% 的值。
- 上次请求三项来自最近一个带 `lastRequest` 的 turnHeader（每次覆盖，不累计）：TTFT、`outputTokens / generationDurationMs`、`cacheReadTokens / inputTokens`。
- 单行排版（不做二级面板）：会话三项恒定渲染，缺值 `--`；轮次位置在 `turnOrdinal` / `requestCount` 齐备时渲染；竖线后接上次请求三项。
- 上次请求组仅在会话 `requestCount > 1` 时出现：会话只有一次请求时它与前半段完全重复；轮次位置仍然渲染（它描述的是最近一次请求所在位置）。
- 会话累计未知（`requestCount` 为 0/缺席且 token 全 0）时三项全部显示 `--`，不把"还没有事实"渲染成 0。
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
  ├─ 创建 turnHeader 时（活轮 / 队列 drain 切轮）分配 turnOrdinal：
  │      仅 fact.visibility==="visible" 的轮参与编号；模型内部轮不带序号
  └─ state.updated(usage.cumulative){ tokens(+=), requestCount(+=1),
         generationDurationMs(+=), timeToFirstTokenTotalMs(+=), timeToFirstTokenSamples(+=1) }
       └─ ConversationDelta → snapshot.rows.window / snapshot.usage（conflation 传输）
UI ConversationComposer（只读格式化）
  └─ 从 snapshot.usage.cumulative + 最近带 lastRequest 的 turnHeader 派生 fact
       → ComposerTurnMetricsCapsule 渲染单行八段
```

- 冷恢复：durable transcript 合成的 `ModelComplete` 为零 usage 且无 `timings`，不产生指标；同进程 warm 恢复的内存权威事件携带 `timings` 并重新聚合。聚合存于投影行与 `usage.cumulative`。
- 非主轮（compact / session_title / subagent / workflow_child）与 controlOnly 轮从不写入这些字段。

### 会话累计的冷启动补种（纯附加）

`usage.cumulative` 原本只在本进程内累加，冷开从 0 起。为了让"会话级"真正等于整个会话，hydration 时会从 `model_usage` 读一次聚合补种：

```
UsageStorePort.queryMainTurnUsage?({ sessionID })          ← optional，store 未实现则跳过
  └─ select count(*), sum(input/output/cache_*_tokens), sum(duration_ms),
            sum(time_to_first_token_ms), count(time_to_first_token_ms)
     from model_usage where session_id = ? and query_source = 'main_turn'
v4-bridge readMainTurnUsageCumulative()                     ← 失败/空结果一律返回 undefined
  └─ sessionUsageSeedFromRuntimeContextUsage(usage, window, cumulative?)
       └─ SessionUsageSeed.cumulative → ProductProjection.seedUsage（既有守卫不变）
```

约束（改动必须保持纯附加）：

- `queryMainTurnUsage` 是 optional 方法；store 没实现、查询抛错、会话还没有 main_turn 记录时，种子与改动前**逐字段相同**（只带 `contextWindow`），恢复路径行为不变。
- `seedUsage` 的既有守卫（已有 live 用量水位则整体不覆盖）**不改**；因此种子只会在投影还没有任何用量事实时生效，不会与 live 累计重复相加。
- 补种值是基线：种上之后，本进程的 live `ModelComplete` 在其上继续累加。
- 聚合按原始行求和，不做 `queryTaskUsage` 的 context baseline 增量修正——这里要的是"实际请求总量"，与投影逐请求累加同口径。

## Compatibility

Metric fields are optional so older snapshots and mixed-version peers continue to parse. Non-main turns, compact operations, subagents, and workflow children never overwrite the main-turn metrics. Old `ModelComplete` events without `timings` contribute only tokens and the request count; TTFT and speed stay unavailable instead of being estimated. `turnHeader.turnOrdinal` is additive optional: old snapshots omit it and the card simply hides the position segment.

`usage.cumulative` 的 `generationDurationMs` / `requestCount` / `timeToFirstTokenTotalMs` / `timeToFirstTokenSamples` 是 additive optional 字段。它们与既有 token 累计同生命周期：进程内累加，冷恢复时由持久化聚合补种；补种不可用（旧 store / 查询失败）时退回进程内累计，数值从本次运行起算。

## Acceptance

- A completed main turn shows the seven segments in one row: `第 {turn} 轮 · 第 {step} 步`, session total input, session total output, session cache hit rate, then last request's first token, speed, and cache hit rate.
- The turn position is `turnHeader.turnOrdinal` + `turnHeader.requestCount` from the same row that supplies `lastRequest`; when either field is unavailable the position segment is not rendered (no client-side turn counting or window-based estimate).
- Session segments are always rendered; unknown or missing facts show `--` instead of 0 or an estimate.
- Session cache hit rate equals `cacheReadTokens / inputTokens` and never exceeds 100%.
- Token totals switch to compact units at 100k and keep the exact value in the `title` attribute.
- The latest-request group is hidden when the session has only one request.
- Session cumulative counters survive a cold restart by seeding from the durable `model_usage` aggregate; when that query is unavailable the values fall back to process scope without changing the resume path.
- Subagent/workflow/compact activity does not change the session cumulative counters or the last-request facts.
- The card wraps by segment at narrow widths instead of overflowing, and stays readable in both active themes.
- Shared test-id anchors: `TID_COMPOSER_TURN_METRICS` (`composer-turn-metrics`) and `TID_COMPOSER_TURN_METRICS_ITEM` (`composer-turn-metrics-item` with `turn-step` / `input-tokens` / `output-tokens` / `cache-hit-rate` / `last-request-ttft` / `last-request-tokens-per-second` / `last-request-cache-hit-rate` suffixes).
- i18n keys `chat.composer.turnMetrics.turnStep` / `.totalInput` / `.totalOutput` / `.cacheHitRate` / `.ttft` / `.tokensPerSecond` / `.sectionLastRequest` in zh-CN and en-US.

## Non-goals

This feature does not add a metrics history view, telemetry export, or client-side timing approximation.
