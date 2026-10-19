# 复刻 Claude Code 桌面版机制 · ZCode 新底层架构方案

> 日期:2026-10-20。状态:**已拍板,待实施**。
> 依据:本机 Claude 桌面版解包实证(`Desktop/agent/.tmp/cck/`,MSIX `Claude_2.16120.0.0` + `Claude-3p/claude-code/2.1.284`)与 ZCode 会话加载审查报告(`Desktop/agent/ZCode-会话加载机制与性能占用审查报告.md`)。
> 本方案推翻此前"设置项开关式增量优化"路线(已取消删除),改为整体替换会话底层。

## 0. 已拍板决策

1. **存储形态:激进路线**——JSONL append-only 权威存储,SQLite 降级为纯索引/搜索;与 Claude 完全同构。
2. **UI 范围:换数据层**——现有 React UI 保留,切换到 transcript-first 数据层,并给 `loadOlder` 加窗口上限;不重写渲染组件。
3. **先后顺序**——先完成 3.15.1 升级收尾(README 更新、上游基线记录、提交推送 zcodefork),再开 P0。

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

**反面边界(不复刻):** Hyper-V VM 沙箱、RFB 帧流、Chrome 桥、Coordinator worker 编排、遥测事件全集——与流畅度无关。`ion-dist` 为专有前端,只复刻其"transcript-first + 独立 SPA"契约,不使用其代码。

## 3. ZCode 对照与差距

| 层        | Claude                            | ZCode 现状(3.15.1 fork)                                                               | 判定              |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| 权威存储  | 每会话 JSONL                      | SQLite 24 表,part JSON 列 1.14GB(本机库 2.0GB)                                        | **根因差距,须换** |
| 打开会话  | tail ladder,worker 解析           | v4 尾窗 60 行(协议同构);但 `getTaskSnapshot`/resume 全量 hydration;最大会话冷读 ≈2.2s | 须换加载路径      |
| 翻页      | `beforeUuid` 游标                 | `conversationRowsRangeV4` 200 行/页                                                   | 对齐(保留)        |
| 增量重读  | ino+size delta                    | 事件日志 2000 条/会话上限,超限重建                                                    | 须补              |
| 大件传输  | MessagePort 通道                  | v4 帧 ≤1MB 分片                                                                       | 可后置            |
| 渲染      | SPA 自持虚拟化                    | tanstack-virtual + 4000 条行高 LRU                                                    | 对齐(保留)        |
| loadOlder | 游标天然有界                      | **无窗口上限**,可全量驻留                                                             | 须修              |
| 卡顿观测  | stall_capture + LOAF + 逐请求诊断 | 资源遥测完备,无 stall/帧级归因                                                        | 须补              |
| 全量税    | 无                                | `getTaskSnapshot` 对终态会话仍 resume;ETag 全量 sha256                                | 须废              |

## 4. 目标架构

```
存储层   ~/.zcode/sessions/<session-id>.jsonl   ← append-only 权威(agent 写入)
         ~/.zcode/v2/tasks-index.sqlite        ← 仅列表/搜索/置顶/归档索引
加载层   transcript-worker(worker_threads):
         tail ladder 1/5/50MB → ino 增量 → 字节预算(50/32MB)→ 缓存(100MB/200MB/7d)
会话层   zcode-cli 持 provider 上下文;resume 只在"继续对话"时执行;
         "仅查看"永远走 transcript 读取,不再 session/resume
桥接层   preload 纯桥:getTranscriptTail / getTranscriptPage(beforeUuid) /
         requestTranscriptPort + readTranscript / searchSessions(worker)
渲染层   transcript-first:渲染 worker 裁剪后的行;虚拟化+行高 LRU+live tail 保留;
         loadOlder → beforeUuid 分页 + 窗口上限(2000 行)
观测层   stall_sampler(Atomics 心跳 + inspector 快照) + LOAF +
         tail_source / sessionWaitMs / handlerMs 逐请求诊断
```

相对 Claude 的必要差异:ZCode 扩展数据(workflow/todo/usage/goal 等)按 `type` 字段区分写入同一 JSONL 事件流,索引库负责查询投影;3.15.1 功能面不回退;退役功能(companion/mobile、workflow mode、Command Code+gateway quota、ACP/内置 Agent CLI)不复活。

## 5. 分阶段实施

### P0 观测先行(先拿基线)

- stall-sampler(worker 心跳 + inspector 快照)+ LOAF/输入延迟采集进现有代码。
- 会话打开分阶段计时:SQL 读/JSON.parse/hydration/协议/首帧,输出到本地诊断。
- 基线指标:最大会话(9052 消息/116MB parts)打开耗时、主线程 stall 次数、renderer 堆。
- **验收**:基线数据落盘(`docs/research/` 数据目录),后续每阶段与此对比。

### P1 存储 + 加载(根因层)

- JSONL append-only 权威存储(schema:事件行 `type` 字段区分消息/部件/workflow/todo/usage…);写路径 agent 侧替换 `SqliteSessionStore` 的 message/part 读写。
- transcript-worker:tail ladder + ino 增量 + 字节预算 + 三档缓存,对齐 E2/E3/E4。
- 迁移脚本:历史 SQLite 会话 → JSONL(一次性,幂等,校验行数/哈希);SQLite 保留为索引源。
- 双写过渡窗口可选(默认不做,迁移脚本一次性切换;风险见 §6)。
- **验收**:大会话 tail 打开 <100ms;增量重开仅解析 delta;内存受预算钳制。

### P2 协议 + 渲染数据层

- 渲染层切 transcript-first:`getTranscriptTail/getTranscriptPage(beforeUuid)` 供数,v4 topic 仅保留流式 delta;废除 `getTaskSnapshot` 全量路径(终态会话短路只读,不 resume)。
- ETag 换廉价指纹(updatedAt+消息数+末条 id);`loadOlder` 窗口上限 2000 行 + 回顶重新分页。
- MessagePort 批量通道(`requestTranscriptPort`)视 P1 结果决定是否当期做。
- **验收**:仅查看终态会话零 hydration;翻页/流式回归通过;renderer 堆有界。

### P3 清理与总验收

- SQLite 降级纯索引;清理全量快照路径残留;文档(`system-prompt-contract` 不涉,主要是存储/协议文档与 README 架构段)更新。
- 总验收:对照 P0 基线——打开耗时、stall 归零或归因明确、内存有界;全套测试+预发布包验证。
- **验收**:量化对比报告落盘 `docs/research/`。

## 6. 风险与对策

| 风险                                             | 对策                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| 历史 2GB 库迁移失败/校验不一致                   | 迁移脚本幂等 + 行数/内容哈希校验;迁移前备份;SQLite 原库只读保留   |
| workflow/todo 等扩展数据的 JSONL schema 设计不周 | schema 先行评审;事件行 `type` 版本化;未知 type 保留原样透传       |
| 双写不一致                                       | 默认不做双写,P1 一次性切换 + 迁移;如需灰度,单会话维度开关而非全局 |
| v4 协议消费者(bots/移动端路径)受影响             | `getTaskSnapshot` 短路而非删除;接口签名不变,内部换源              |
| 与 3.15.1 收尾线交叠                             | 严格先后:先收尾提交推送 zcodefork,再开 P0;两条线不混提交          |

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
