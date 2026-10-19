# 快速恢复历史会话（Fast Session Resume）

## Feature Summary

| Field                 | Value                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | 新增设置开关（默认关闭）：冷恢复首帧只做投影必需的工作，把与首帧内容无关的 resume / seed / file-change 计算推迟到首帧后，首轮输入前收敛                                                                                                                                                      |
| User-visible surfaces | 设置 → 常规 → 「快速恢复历史会话」；打开长历史会话时首个 conversation snapshot 的等待时间；首帧后 usage/subagent/文件变更面板的短延迟补齐                                                                                                                                                    |
| Existing docs         | `docs/performance/v4-conversation-cold-hydration.md`、`docs/v4-refactor/05-transport-and-backpressure.md`、`apps/zcode-cli/docs/design/v2/session-persistence.md`                                                                                                                            |
| Existing code owners  | CLI `V4Gateway`、`v4-bridge`、`AgentRuntime.resumeFromStore`、`ContextBuilder`；Host `zcodeAgentService` 运行时偏好同步                                                                                                                                                                      |
| Out of scope          | 存储模型（SQLite → JSONL）、现有帧字段语义变更、renderer 渲染优化、改变关闭路径行为、新增进程模型。仅新增两个**附加**协议面：`openTiming.fastResume`（只在开关开启时出现，关闭时 ACK 与旧版逐字段一致）与 `workspace/updateSessionResumePreferences`（旧 CLI method-not-found 时 Host 忽略） |

## Goal

长会话冷恢复的耗时主要来自与首帧内容无关的工作：

- `ensureContextInitialized`：context sources、skills 扫盘、Memory、context prefix 构建；
- `hydrateMessageHistoryFromSession` 之外的 file-state 恢复、session-start hooks、动态工作流激活扫描；
- usage / subagent 种子；
- 全历史 checkpoint 的 file-change 摘要（逐 artifact 读取 + diff）。

开关打开后，首帧仍保持与关闭路径**完全相同的 60 行尾窗**，只把这些工作移到首帧之后；首轮输入前由 settlement 收敛，失败则本轮失败（fail-closed），不静默使用半初始化状态。

## Behavior Contract

| 会话状态                        | 行为                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 开关关闭 / 旧 Host / 旧 CLI     | 冷恢复路径与未引入该开关完全一致（布尔短路）；`openTiming` 不带 `fastResume` 键，ACK 逐字段不变                            |
| 开关打开，冷订阅首次打开会话    | 首帧前保留：message 读取、分支裁剪、compact 修复、checkpoint/rewind 恢复、投影归约                                         |
| 开关打开，首帧之后              | 后台补：file-state → context（prefix 合并）→ dwf 激活 → session-start hooks；同时补 usage/subagent 种子并推一次快照 resync |
| 用户首帧后立即输入              | turn 在 context 分支前 await `deferredResumeSettlement`，保证历史与 context 完整                                           |
| 后台全量重建（checkpoint 摘要） | 首帧只算最近 300 条消息的摘要；随后 `forceFull` 重建投影，经既有 resync 推送完整历史                                       |
| resume 失败 / 初始化失败        | settlement 拒绝；首轮 turn 失败并记录 `session.resume.fast_settlement_failed`，不进入模型请求                              |

## Switch Plumbing

复刻 `modelIoFullRetentionEnabled` 的既有通道，不新增机制：

1. `AppSettings.fastSessionResumeEnabled`（默认 `false`）；
2. 设置页开关 → `useSettingService.update` → `syncAppRuntimePreferences`；
3. Host 热下发 `workspace/updateSessionResumePreferences`（旧 CLI method-not-found 时忽略）；
4. CLI `context.appRuntimePreferences.fastSessionResumeEnabled` 缓存，v4 冷订阅读取快照；
5. resume 时经 `ZCodeAppOptions.fastSessionResumeEnabled` 进入 `AgentRuntimeConfig`；
6. 新 CLI 进程启动后由 Host 的 `latestAppRuntimePreferences` 重放补齐（与 model-io 相同）。

## Guards

- **context 初始化单飞**：`contextInitializationPromise` 让后台补做与 turn 惰性初始化合流；resume 重置时清空，失败后允许重试。
- **prefix 合并**：延迟初始化用 `replaceMessages([prefix, ...conversation])`，禁止 `messageHistory.init()` 清空已 hydrate 的历史；`preserveMessageHistoryOnInit` 标记覆盖所有未等待 settlement 的提前初始化入口。
- **turn 屏障**：`deferredResumeSettlement` 在常规 turn、手动 compact、rewind 分支之前 await。
- **publisher 身份校验**：后台补种/重建只在 publisher 未被替换时生效；重建前清除本会话的 `hydratedSessions` 标记，确保 `forceRebuild` 真正执行。
- **最新持久消息**：后台全量重建不传入 resume 时的快照，改为重新读取 store，避免覆盖首帧后新落库的消息。

## Merge Order

四个步骤按以下顺序合入（步骤 1 是其余步骤的前置；2/3/4 之间除标注依赖外互不重叠）：

| 步骤 | 内容                                  | 关键文件                                                                                                                                         | 依赖                            | 独立验收                                                             |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | -------------------------------------------------------------------- |
| 1    | 开关链路（设置/协议/Host/CLI 缓存）   | `packages/shared`（settings、protocol）、`packages/services/zcode-agent/*`、`packages/ui`（设置页）、`bootstrap/zcode-protocol/*-preferences.ts` | 无                              | 关闭路径回归测试原样通过；`session-resume-preferences` / UI 同步测试 |
| 2    | usage/subagent 种子首帧后补种         | `v4-bridge.ts`、`v4-gateway.ts`、`conversation-topic-publisher.ts`                                                                               | 1                               | gateway「快速恢复」用例                                              |
| 3    | 并发守卫（单飞 + prefix 合并 + 标记） | `core/runtime/{internal,methods/context,methods/turn}.ts`                                                                                        | 无（步骤 4 依赖它保证历史安全） | 「Fast session resume」并发与提前入口用例                            |
| 4    | resume 瘦身 + file-change 摘要收窄    | `core/runtime/methods/resume.ts`、`v4-bridge.ts`、`v4-gateway.ts`、`app/{types,create-app}.ts`、`server-operations.ts`                           | 1、3                            | 「Fast session resume」首轮收敛用例 + gateway 全量重建用例           |

## Observability

- conversation subscribe ACK 的 `openTiming.fastResume` 标记本次是否走快速路径；**仅开关开启时出现**，与既有 `cliSessionRestoreMs` / `initialFrameEncodeMs` 同口径对比开/关收益。
- 后台失败分别记录 `zcode_protocol.v4.deferred_usage_seed_failed`、`...deferred_subagent_seed_failed`；全量重建失败先记录 `v4.deferredFullHydration.retry` 并重试一次，仍失败记录 `v4.deferredFullHydration.failed`。
- resume 侧记录 `session.resume.fast_settlement_failed`。

## Testing

- `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`「Fast session resume」：
  - 关闭路径保持原行为；
  - 打开路径首帧前不初始化 context，首轮 turn 等待 settlement 且历史不丢失；
  - 并发初始化只执行一次；
  - 未等待 settlement 的提前初始化（control-only turn / goal 提醒 / skill 目录路径）同样保留历史。
- `apps/zcode-cli/packages/bootstrap/tests/v4-cold-resume.test.ts`：首帧不带种子、补种后 resync、后台 `fastResume=false` 全量重建。
- `apps/zcode-cli/packages/bootstrap/tests/session-resume-preferences.test.ts`：偏好缓存与未知字段拒绝。
- `packages/ui/test/useSettingServiceAutoResolution.test.ts`：开关随完整偏好快照持久化并广播。

## Limits

- 优化的是“打开历史会话”的首帧延迟，不改变单轮对话的流式性能；renderer 的渲染热点（每帧 O(N) 重建、markdown 重解析）不在本开关范围内。
- 首帧后后台仍会完成一次全量重建，长历史会话会多支付一次投影归约成本（不在首帧关键路径上）；重建失败重试一次，仍失败时保留首帧的尾部摘要，不改写已发内容。
- file-change 摘要窗口取 `snapshotTailWindowRows × 5`（60 → 300 条消息）。设计假设：常规 transcript 每条可见消息至少生成一个 row，故 60 行尾窗通常只涉及 ≤60 条消息；模块加载时断言窗口大于尾窗行数。极端投影（单条消息占大量行或大量消息不产 row）使尾窗跨过 300 条消息时：正文仍完整，仅较早轮次的 fileChanges 徽标会延迟到后台重建后出现。
- resume 的其它入口（control-only turn、goal 提醒、skill 目录等）不等待 settlement；`preserveMessageHistoryOnInit` 标记保证它们提前初始化时同样走 prefix 合并。
- SQLite 仍为同步全量读取；尾读因投影 `rowId` 依赖全量归约而收益有限，本开关不改变读取模型。
