# 复刻 Claude Code 桌面版机制 · ZCode 新底层架构方案

> 日期:2026-10-20(初版);状态:**已拍板,待实施**。
> 依据:本机 Claude 桌面版解包实证(`Desktop/agent/.tmp/cck/`,MSIX `Claude_2.16120.0.0` + `Claude-3p/claude-code/2.1.284`)与 ZCode 会话加载审查报告(`Desktop/agent/ZCode-会话加载机制与性能占用审查报告.md`)。
> 本方案推翻此前"设置项开关式增量优化"路线(已取消删除),改为整体替换会话底层。
>
> **2026-10-20 复核(基线 3.16.1)**:fork HEAD `3b87871e`,上游 `0a1fc56d`(3.16.1,无 tag);3.15.1/3.16.1 收尾、README 基线、`upstream-sync.json`、推送 `zcodefork` 与 CI 均已完成,P0 可立即启动。本次按 3.16.1 代码复核了 §2/§3 的事实口径,新增 §3.1,并把 P1 拆为 P1a(读路径)/P1b(存储权威,按指标 gate),详见 §5。

## 0. 已拍板决策

1. **存储形态:目标不变,顺序调整**——最终权威仍为 JSONL append-only,SQLite 降级为纯索引/搜索;但先做 P1a(SQLite 读路径与窗口),用真实指标决定是否进入 P1b(JSONL 权威替换),避免在未验证读路径上限前承担结构性迁移成本(2026-10-20 修订)。
2. **UI 范围:换数据层**——现有 React UI 保留,切换到 transcript-first 数据层,并给 `loadOlder` 加窗口上限;不重写渲染组件。
3. **先后顺序**——3.15.1/3.16.1 升级收尾已完成(README、上游基线、提交推送 `zcodefork`、CI 全绿),P0 可立即启动;P1a 与 P1b 之间设量化 gate。

## 1. 目标

- 打开会话从"秒级全量"变为"毫秒级 tail";主线程永不解析大 JSON。
- "仅查看"会话零 hydration 成本;"继续对话"才付 provider 上下文重建成本。
- 卡顿可归因(stall/LOAF/逐请求诊断),验收有量化基线与对比。

## 2. 机制证据摘要(Claude 桌面版实证)

| #   | 机制                                                                                                                                                              | 证据                                                                                                                      | 对流畅度的贡献                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| E1  | 每会话一个 append-only JSONL(`.claude/projects/<slug>/<uuid>.jsonl`,一行一事件)                                                                                   | 本机会话文件实测(2.1MB/346 行)                                                                                            | 无规范化 part 表,读 = 文件 tail     |
| E2  | tail 优先四级读取:`cache \| ladder \| buffer \| buffer_fallback`(`Vmn` 常量),ladder 尺寸 `1MB → 5MB → 50MB`(`Vv`)                                                 | main chunk tail 状态机(`diskTranscriptLoadTranscriptTailFromDisk`),每次请求带 `sessionWaitMs/handlerMs/drainOverlap` 诊断 | 打开会话不付全量税                  |
| E3  | 增量重读:`同 ino && size 只增` → 只解析 `deltaBytes`,且 `loadedBytes+delta ≤ ceiling`                                                                             | heavy-work-worker `Gv/Kv`                                                                                                 | 重开/追加会话 O(增量)               |
| E4  | 硬预算:mainBytes 50MB / subagentBytes 32MB / cachedEntry 100MB / cachedTotal 200MB;缓存 7 天 TTL;解析并发 2、IO 并发 4                                            | heavy-work-worker 常量块 `zv/Hv/Iv/Rv`                                                                                    | 内存有界,不会被大会话拖垮           |
| E5  | worker 隔离:heavy-work-worker(JSONL 解析)、transcript-search-worker、file-index-worker、pty-host、stall-sampler-worker                                            | asar `.vite/build/*` 目录                                                                                                 | 主线程零大 JSON.parse               |
| E6  | 读契约:`getTranscriptTail(limit)` / `getTranscriptPage(beforeUuid, limit)` / `requestTranscriptPort`+`readTranscript`(MessagePort 批量)/ `searchSessions(worker)` | main chunk IPC schema                                                                                                     | 分页同构 v4,批量通道免 IPC 序列化税 |
| E7  | stall 采样:worker 按 `Atomics` 心跳检测主线程停顿,`inspector` 抓 V8 快照,产出 `stall_capture`(热点帧+startLagMs);渲染端 LOAF + 输入延迟,main 侧白名单 clamp       | stall-sampler-worker 源码;遥测字段字典                                                                                    | 卡顿有归因数据                      |
| E8  | 渲染层独立 SPA(`ion-dist`),`app://localhost` 协议 + origin 白名单(`claude.ai/.ant.dev/localhost`),preload 纯桥(~315+110 方法)                                     | `IMr` app:// handler;mainView/mainWindow preload                                                                          | 壳不渲染正文,职责干净               |

**移植注意:** E1–E4 的前提是"事件只追加、文件只增长"。ZCode 现有写路径包含 message/part upsert(`ON CONFLICT DO UPDATE`)、`removeMessage`/`removePart`、session revert 与 compaction,直接套用会失真;P1b 开工前必须先定义 tombstone/覆盖事件、压缩边界与折叠规则。E3 的 ino 语义在 Windows(NTFS 文件 ID)与 WSL 下也不同,需用平台无关的文件身份或内容指纹替代。E5/E6 在 3.16.1 已有部分对应:全量 parse 位于 CLI 子进程而非桌面主线程,v4 本身已走 MessagePort + 1MB 分片。

**反面边界(不复刻):** Hyper-V VM 沙箱、RFB 帧流、Chrome 桥、Coordinator worker 编排、遥测事件全集——与流畅度无关。`ion-dist` 为专有前端,只复刻其"transcript-first + 独立 SPA"契约,不使用其代码。

## 3. ZCode 对照与差距

| 层        | Claude                            | ZCode 现状(3.16.1 fork)                                                                                                                                    | 判定                       |
| --------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 权威存储  | 每会话 JSONL                      | SQLite 24 表(`~/.zcode/cli/db/db.sqlite` 本机 2.93GiB / 1208 会话);另有 `~/.zcode/v2/tasks-index.sqlite` 与 project-storage 独立库                         | 目标待替换;格式非唯一根因  |
| 打开会话  | tail ladder,worker 解析           | v4 `subscribe` + `historyFirst`:首帧先于 runtime resume,但 `loadPersistedMessages` 仍全量 `store.messages({sessionID})`;主打开路径已不走 `getTaskSnapshot` | 须换加载路径               |
| 翻页      | `beforeUuid` 游标                 | `beforeRowId` 数值游标,200 行/页(`rowsRangeMaxLimit`)                                                                                                      | 对齐(保留)                 |
| 增量重读  | ino+size delta                    | 无增量重读;v4 delta log 每会话保留 2000 条(`eventRetentionPerSession`),溢出返回 snapshot 重同步                                                            | 须补(需处理可变行)         |
| 大件传输  | MessagePort 通道                  | v4 已走 MessagePort,帧 ≤1MB 分片                                                                                                                           | 已对齐,无需新增通道        |
| 渲染      | SPA 自持虚拟化                    | tanstack-virtual + 4000 条行高 LRU;尾窗 60 行                                                                                                              | 对齐(保留)                 |
| loadOlder | 游标天然有界                      | **无窗口上限**,`loadAllOlder` 可全量驻留                                                                                                                   | 须修                       |
| 卡顿观测  | stall_capture + LOAF + 逐请求诊断 | 已有 `openTiming`(`historyReadyMs`/`cliSessionRestoreMs`/`initialFrameEncodeMs` 等);无 stall/帧级归因                                                      | 须补                       |
| 全量税    | 无                                | `getTaskSnapshot`/legacy restore 对终态会话仍 resume;`getTaskSnapshotWithEtag` 对快照做全量 sha256(v4 无 ETag);v4 历史首帧仍全量 hydration                 | 须改(legacy 短路 + 读路径) |

### 3.1 3.16.1 带来的变化(2026-10-20 复核)

1. **`historyFirst` 已落地**:`v4-gateway.ts:1519/3070/3110` 在首帧先渲染持久化历史,把 runtime resume 推迟到 `setImmediate`;协议新增 `runtimeInitialization`(initializing/ready/failed)与 `historyReadyMs`。**收益**:P0 可直接拆分"历史可读"与"运行时就绪",P2 的"仅查看"可复用 `runtimeInitialization`。**边界**:历史仍由 `loadPersistedMessages = store.messages({sessionID})` 全量读取,P1a/P1b/P2 没有可复用的 tail/delta 实现。
2. **迁移体系更换**:新增 `@zcode/shared/sqlite-migrations`(checksum + `touchedTables` 备份 + restore);`schema.baseline.sql` 由 `scripts/check-sqlite-schema.ts` 强制校验(additive-only)。P1b 的迁移脚本必须接入该体系,改表需重生成 baseline。
3. **消费者面扩大**:新增 `task-groups`、`task-facts`、`sessionsIndexReconcile`、conversation share v2、`source-server-workspace`、`project-storage`。"SQLite 降级纯索引"要重接的读路径显著多于 3.15.1。
4. **远端工作区出现**:`source-server-workspace`/`remote-projects` 使"会话在哪一侧"成为新问题。本文默认的 `~/.zcode/sessions` 是本地单机路径;**远端会话的 transcript 存放与同步策略未定,属 P1b 的前置产品决策**。

## 4. 目标架构

```
存储层   ~/.zcode/sessions/<session-id>.jsonl   ← append-only 权威(agent 写入)
         覆盖事件/tombstone + 周期快照               ← 支撑 upsert/删除/revert/compaction
         ~/.zcode/v2/tasks-index.sqlite        ← 仅列表/搜索/置顶/归档索引
加载层   transcript-worker(worker_threads):
         tail ladder 1/5/50MB → 文件身份+增量 → 字节预算(50/32MB)→ 缓存(100MB/200MB/7d)
会话层   zcode-cli 持 provider 上下文;resume 只在"继续对话"时执行;
         "仅查看"永远走 transcript 读取,不再 session/resume
桥接层   preload 纯桥:getTranscriptTail / getTranscriptPage(beforeRowId) /
         searchSessions(worker);v4 既有 MessagePort 通道复用,不新增 requestTranscriptPort
渲染层   transcript-first:渲染 worker 裁剪后的行;虚拟化+行高 LRU+live tail 保留;
         loadOlder → beforeRowId 分页 + 窗口上限(2000 行)
观测层   stall_sampler(Atomics 心跳 + inspector 快照) + LOAF +
         复用 historyReadyMs / cliSessionRestoreMs,补 tail_source / sessionWaitMs / handlerMs 逐请求诊断
```

相对 Claude 的必要差异:ZCode 扩展数据(workflow/todo/usage/goal 等)按 `type` 字段区分写入同一 JSONL 事件流,索引库负责查询投影;3.16.1 功能面不回退;退役功能(companion/mobile、workflow mode、Command Code+gateway quota、ACP/内置 Agent CLI)不复活。**新增约束**:JSONL 必须显式建模 ZCode 的可变操作(tombstone、覆盖事件、compaction 边界),并在多窗口/bot/分享/远端工作区并存时定义单写者与读一致性;远端会话是否落到同一套路径需在 P1b 前决定。

## 5. 分阶段实施

### P0 观测先行(先拿 3.16.1 基线)

- 复用现有 `openTiming` 字段,补 stall-sampler(worker 心跳 + inspector 快照)+ LOAF/输入延迟采集。
- 会话打开分阶段计时:CLI spawn/复用、SQL 全量读、JSON.parse、snapshot tail 裁剪、协议编码、renderer apply、runtime resume;`historyReadyMs` 与"运行时就绪"分开记录。
- 基线指标:最大会话打开耗时、主线程/渲染线程 stall 次数、renderer 堆、是否 spawn CLI。
- 数据目录:`docs/research/session-open-baseline-data/`(当前不存在,新建)。
- **验收**:基线数据落盘,后续每阶段与此对比。

### P1a 读路径与窗口(低风险,先做)

- 新增 `messagesTail({sessionID, limitRows, byteBudget})`:按 `sequence` 倒序取尾窗,parts 按 `message_id` 懒加载;替换打开路径的 `store.messages` 全量读取。
- 终态会话"仅查看":直接读持久化历史,不 resume;结合 3.16.1 `runtimeInitialization`,先降 `historyReadyMs`。
- `loadOlder` 窗口上限 2000 行 + 回顶重新分页;`loadAllOlder` 同样受上限约束或改为显式用户操作。
- legacy `getTaskSnapshotWithEtag` 改廉价指纹(updatedAt + 消息数 + 末条 id);v4 协议不引入 ETag。
- **验收**:大会话 tail 打开 <100ms;仅查看零 resume;翻页窗口有界;renderer 堆有界。
- **Gate**:P1a 达标则 P1b 降为可选;未达标(宿主侧无锁只读、append 吞吐或大 part 解析成为瓶颈)再进入 P1b。

### P1b 存储权威替换(仅在 P1a 未达标时启动)

前置设计(必须先评审,否则不进入实现):

1. **变更模型**:upsert/删除/revert/compaction 的 tombstone、覆盖事件、压缩边界与折叠规则。
2. **写者模型**:单写者所有权、fsync、崩溃恢复、半行处理、多窗口/多客户端读一致性。
3. **索引重接**:task-index/task-facts/groups/share/bots/project-storage/remote 的读路径与重建协议,并接入 `@zcode/shared/sqlite-migrations` 的校验/备份机制。

- JSONL append-only 权威存储(schema:事件行 `type` 字段区分消息/部件/workflow/todo/usage…);写路径 agent 侧替换 `SqliteSessionStore` 的 message/part 读写。
- transcript-worker:tail ladder + 文件身份增量 + 字节预算 + 三档缓存,对齐 E2/E3/E4;Windows/WSL 不依赖 POSIX ino。
- 迁移脚本:历史 SQLite 会话 → JSONL(一次性,幂等,校验行数/哈希);本机基线 3.14GB / 1208 会话 / 约 6.5e5 parts,预留 2 倍磁盘。SQLite 保留为索引源。
- 双写过渡窗口可选(默认不做,迁移脚本一次性切换;风险见 §6)。
- **验收**:大会话 tail 打开 <100ms;增量重开仅解析 delta;内存受预算钳制;索引与分享/机器人读路径一致。

### P2 协议 + 渲染数据层

- 渲染层切 transcript-first:`getTranscriptTail/getTranscriptPage(beforeRowId)` 供数,v4 topic 仅保留流式 delta;终态会话短路只读、不 resume。
- `getTaskSnapshot` **保留接口**供 legacy restore/bots,不再承担主打开路径;不得按"删除"实施。
- ETag 换廉价指纹(updatedAt+消息数+末条 id);`loadOlder` 窗口上限 2000 行 + 回顶重新分页。
- MessagePort 通道已存在(v4 的 1MB 分片),不新增 `requestTranscriptPort`;仅在 P1a/P1b 证明 IPC 是瓶颈时再评估。
- **验收**:仅查看终态会话零 hydration;翻页/流式回归通过;renderer 堆有界。

### P3 清理与总验收

- SQLite 降级纯索引(仅当 P1b 实施);清理全量快照路径残留;文档(`system-prompt-contract` 不涉,主要是存储/协议文档、README 架构段与 `upstream-sync` 说明)更新。
- 总验收:对照 P0 基线——打开耗时、stall 归零或归因明确、内存有界;全套测试+预发布包验证。
- **验收**:量化对比报告落盘 `docs/research/session-open-baseline-data/`,含 P1a 是否触发 P1b 的 gate 结论。

## 6. 风险与对策

| 风险                                             | 对策                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 历史库迁移失败/校验不一致                        | 本机基线 3.14GB / 1208 会话 / 约 6.5e5 parts;脚本幂等 + 行数/内容哈希校验;迁移前备份;SQLite 原库只读保留 |
| append-only 与可变语义冲突                       | 先定义 tombstone/覆盖事件/compaction 边界/折叠规则;在 P1b 前置评审通过前不进入实现                       |
| 多写者与崩溃一致性                               | 单写者所有权 + fsync + 半行恢复;多窗口/bot/分享读侧统一走快照或索引,禁止直接 tail 未提交行               |
| 索引与消费者重接面扩大                           | 列出 task-index/task-facts/groups/share/bots/project-storage/remote 全部读路径,逐项验证后再切换权威源    |
| 远端工作区范围未定                               | P1b 前决定远端会话 transcript 的存放/同步策略;未定则 P1b 不启动                                          |
| workflow/todo 等扩展数据的 JSONL schema 设计不周 | schema 先行评审;事件行 `type` 版本化;未知 type 保留原样透传                                              |
| 双写不一致                                       | 默认不做双写,P1b 一次性切换 + 迁移;如需灰度,单会话维度开关而非全局                                       |
| v4 协议消费者(bots/share/legacy restore)受影响   | `getTaskSnapshot` 短路而非删除;接口签名不变,内部换源                                                     |
| 与上游同步线交叠                                 | 3.16.1 已收尾;P0/P1a 尽量不改上游文件,存储替换放独立包+端口后,降低每次同步的冲突面                       |

## 7. 约束(始终有效)

- 只推送 `zcodefork`(qianmeng406/ZCode),**永不推 origin**(zai-org/ZCode);正常 hooks,无 `--no-verify`,无 force push/历史改写。
- 退役功能不复活;凭证仅存私有/不入库文件,不进日志。
- 不动主 Preview 安装、不复制主 Provider 凭证、不用付费模型;不动 `.wslconfig`/系统代理/防火墙/WSL 默认用户;不 `wsl --shutdown`;不碰 ftuser 共享 `~/.zcode`。
- 构建/清理仅限自证归属目录;未知未跟踪文件不删。

## 8. 参考

- `Desktop/agent/Claude-Code-桌面端解包分析报告.md`(解包证据总表)
- `Desktop/agent/ZCode-会话加载机制与性能占用审查报告.md`(ZCode 现状与实测)
- 本机解包物:`Desktop/agent/.tmp/cck/`(asar-x、ion-dist、worker 源)
- 本机会话样本:`~/.claude/projects/**/*.jsonl`
- 上游基线:`docs/upstream-sync.md` / `docs/upstream-sync.json`(当前 3.16.2 = `3c5b2276`,无 tag;3.16.1 = `0a1fc56d` 为上一基线)
- 3.16.1 代码证据:`packages/shared/src/zcode-protocol-v4/core.ts`(限额)、`conversation-topic-publisher.ts`(尾窗/2000 delta)、`v4-gateway.ts`(historyFirst)、`apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts:642`(全量 `messages`)、`packages/ui/src/v4/conversationProjectionStore.ts`(loadOlder/mergeOlderRows)
