# Demo 引擎 · 独立框架与引擎开发方案

> 日期:2026-10-20
> 状态:**方案定稿,待实施**
> 关联文档:[claude-desktop-replication.spec.md](./claude-desktop-replication.spec.md)(机制证据与 P0–P3 总路线)
> 本文只描述 demo 引擎的开发方案,不代表任何代码已落地。

## 0. 决策摘要

| 项       | 决策                                  | 说明                                                                        |
| -------- | ------------------------------------- | --------------------------------------------------------------------------- |
| 接线边界 | **允许极薄接线**                      | 新增设置字段/组件 + 一处 Host 路由开关;不改现有业务逻辑、存储实现、协议实现 |
| 数据来源 | **独立 JSONL 库 + SQLite 只读懒导入** | 原库 `db.sqlite` 只读,不迁移、不双写;首次打开会话时导入                     |
| 接入形态 | **Sidecar 引擎核心 + Host 装饰器**    | 引擎核心独立;装饰器只接管 v4 会话方法,其余转发原服务                        |
| 首版能力 | **未定;当前里程碑为只读探针**         | 本轮只验证打开/浏览/分页链路,不发消息、不跑工具                             |
| 生效方式 | **重启后生效**                        | Host 启动时读取设置;首版不做运行时热切换                                    |
| 默认状态 | **关闭**                              | 未启用时现有行为与当前版本完全一致                                          |

### 0.1 独立性边界

- `packages/demo-engine/**` 只依赖 `node:*` 标准库,不 import：
  - `@zcode/services`
  - `@zcode/ui`
  - `apps/zcode-cli/**`
  - `@zcode/shared` 的协议/业务类型
- 所有 ZCode 协议映射集中在 `packages/desktop/src/host/demo-engine/snapshotAdapter.ts`。
- 引擎可用 standalone CLI 独立运行与测试,不依赖 Electron/ZCode。
- 不改 `apps/zcode-cli/**`、`packages/services/**` 业务逻辑、SQLite schema、v4 协议 schema。
- 不复活退役功能(companion/mobile、workflow mode、Command Code + gateway quota、ACP/内置 Agent CLI)。

## 1. 目标与非目标

### 1.1 目标

1. **独立转录核心**:JSONL 权威、tail 优先、按需分页,不要求打开会话时全量解析。
2. **有界资源**:字节预算、LRU 缓存、单会话单飞,内存不被大会话拖垮。
3. **可观测**:每次打开产出 `tail_*` 诊断,能与现有 `openTiming` 对齐比较。
4. **可回滚**:设置默认关闭;关闭后行为与当前版本一致;不修改原库。
5. **可演进**:后续可在不重写 UI/服务层的前提下,扩展发送消息、工具执行、搜索等能力。

### 1.2 非目标(本阶段)

- 不发消息、不执行工具、不调用模型。
- 不接管任务列表、插件/MCP、子代理、分享、工作区/文件服务。
- 不做远端工作区/多机 transcript 同步。
- 不迁移或重写现有 SQLite 会话库。
- 不做设置热切换(需重启)。
- 不新增 v4 协议字段或修改现有 schema。

### 1.3 当前里程碑:只读探针

只读探针 = 能证明以下闭环,即为通过:

1. 设置中启用 demo 引擎 → 重启 → 打开一个历史会话;
2. 首帧来自新引擎,尾窗 60 行,上滚按 200 行分页;
3. 全程不启动原 `zcode-cli` 子进程;
4. 诊断字段落盘,可读出 `tail_source=sqlite_import|ladder|cache`;
5. 关闭开关 → 重启 → 原引擎行为完全恢复。

## 2. 架构总览

```
packages/demo-engine/                     ← 独立引擎(仅 node:*)
  src/locator.ts         Claude 风格 projects/<sanitize(cwd)>/<sessionId>.jsonl
  src/jsonl-reader.ts    行读取、半行容忍、坏行跳过
  src/tail-reader.ts     1/5/50 MiB 阶梯、EOF 读取、hasMore
  src/cache.ts           LRU 8 条/200 MiB/单条 100 MiB
  src/sqlite-import.ts   node:sqlite 只读、按会话懒导入、sequence 增量
  src/normalizer.ts      message/part → 内部 TranscriptEntry
  src/projector.ts       内部条目 → 自有 ProjectedRow
  src/engine.ts          openSession / readRows / resync / invalidate
  src/worker-entry.ts    worker_threads 入口
  src/cli.ts             standalone 调试入口
  test/fixtures/         合成 JSONL + 小 SQLite 夹具

packages/desktop/src/host/demo-engine/    ← 唯一 ZCode 感知层(全新代码)
  demoEngineClient.ts        worker RPC + 事件
  demoEngineAgentService.ts  IZCodeAgentService 装饰器(Proxy 白名单覆盖)
  snapshotAdapter.ts         自有行 → ConversationRow/Snapshot/Frame/ACK
  sessionAdapter.ts          条件项:仅当实测 restore 拉起原 CLI 时启用

packages/ui/src/settings/DemoEngineSetting.tsx   ← 新设置组件
```

### 2.1 数据流

```
SessionPane
  → concrete IServiceAccessor.zcodeAgentService
  → demoEngineAgentService (Proxy 装饰器)
      ├─ v4 会话方法 → demoEngineClient → worker → JSONL/SQLite
      │                                   → ProjectedRow
      │                                   → snapshotAdapter
      │                                   → ConversationSnapshot / Frame
      └─ 其余方法 → 原 IZCodeAgentService(原引擎)
```

### 2.2 关键设计原则

- **引擎核心不认 ZCode**:核心只输出自有 `ProjectedRow`;协议字段、可用性、帧封装全部由适配层负责。
- **装饰器不重写服务**:`Proxy` 只覆盖白名单方法,其余方法绑定原对象转发,最大限度保留现有行为。
- **可信门禁不绕过**:`createZCodeAgentConnectionScope` 继续负责 hello/clientHello、connectionId、订阅归属与 unsubscribe;装饰器只作为它的 `base`。
- **原库只读**:导入使用 `mode=ro` + 单事务;引擎永不写 `~/.zcode/cli/db/db.sqlite`。

## 3. 分阶段开发计划

每个阶段独立可回滚;阶段之间以验收结果作为 gate。

### 阶段 0 · 方案与夹具

**交付物**

- 本文档定稿。
- 合成测试夹具(不含真实用户数据):
  - 一个 3 轮 user/assistant 会话;
  - 一个含 tool/compaction 的会话;
  - 一个尾部半行文件;
  - 一个超过首个阶梯边界的会话;
  - 一个最小 SQLite 夹具(只含 session/message/part 所需列与数据)。

**工作项**

1. 固定夹具目录:`packages/demo-engine/test/fixtures/`。
2. 明确隐私规则:夹具必须为合成文本;禁止复制真实会话、凭据、路径、用户名。
3. 明确诊断字段命名与单位(ms/bytes/条数)。
4. 明确只读探针的验收脚本与手动步骤。

**验收**

- 夹具可被 standalone CLI 打开;
- `git diff --check` 通过;
- 文档中的路径与当前代码锚点一致。

**回滚**

- 纯文档/夹具,无运行时影响。

---

### 阶段 1 · 独立转录核心

**交付物**

- `packages/demo-engine` 包骨架(`package.json`、`tsconfig.json`、测试配置)。
- `locator.ts`、`jsonl-reader.ts`、`tail-reader.ts`、`cache.ts`、`normalizer.ts`、`projector.ts`、`engine.ts`、`cli.ts`。
- 单元测试与 golden 快照。

**工作项**

1. **目录定位**
   - `sanitize(cwd)` = 非 `[A-Za-z0-9]` 替换为 `-`;
   - 长度 > 200 时追加 base36 哈希;
   - 候选目录来自 `cwd`、worktree、origin cwd;
   - 主路径 `projects/<sanitize(cwd)>/<sessionId>.jsonl`;
   - 子代理 `.../<sessionId>/subagents/agent-<agentId>.jsonl`,兼容扁平回退;
   - 解析结果按 sessionId 缓存。
2. **JSONL 读取**
   - 一行一记录;
   - 读取区间时找最后一个 `\n`;区间起点 > 0 时丢弃首个半行;
   - 坏行跳过并计数,不使整次读取失败;
   - 末尾半行不视为错误。
3. **Tail 阶梯**
   - 常量 `[1 MiB, 5 MiB, 50 MiB]`;
   - 每次从 EOF 定位读,解析行数达到请求上限或读到文件头即停;
   - `hasMore = start > 0 || rows > limit`;
   - 返回 `source=ladder` 与读/解析统计。
4. **缓存**
   - LRU:最多 8 条、总权重 200 MiB、单条 100 MiB;
   - 权重 = 保留字节数;
   - 有效期三元组 `(ino, size, mtimeMs)`;`size` 回退或 ino 变化即失效;
   - generation 计数防止旧异步结果回写;
   - `invalidate(sessionId)` 显式清理。
5. **预算**
   - 主 transcript 50 MiB、子代理 32 MiB;
   - 超限标记 truncated,继续返回已解析行,不丢整条会话。
6. **归一化**
   - 输入:内部记录(`user`/`assistant`/`attachment`/`system`/`meta`);
   - 输出:内部 `TranscriptEntry`;
   - 工具调用与工具结果按 `tool_use_id` 关联;
   - compaction 保留 `preservedSegment`/`preservedMessages` 作为分页锚点;
   - 未知类型保留原样并计数,不阻断。
7. **投影**
   - 自有 `ProjectedRow`:`turnHeader`、`userInput`、`assistantText`、`reasoning`、`toolCall`、`timelineMarker`;
   - `rowId` 单调;`turnId` 按用户消息分组;`createdAt` 取消息时间;
   - 暂不支持的类型跳过并计 diagnostics。
8. **Engine RPC**
   - `openSession({sessionId, directory})` → `{meta, rowsTail, totalCount, firstRowId, diagnostics}`;
   - `readRows({sessionId, beforeRowId, limit})` → `{rows, hasMore, atSeq, atRevision, atLogEpoch}`;
   - `resync({sessionId})` → 最新快照数据;
   - `invalidate({sessionId})`;
   - 单飞:同一 session 的并发 `openSession` 合并为一次。
9. **standalone CLI**
   - `demo-engine --root <fixtureRoot> --session <id> --tail 60`;
   - 输出行数与诊断,用于无 ZCode 环境下验证核心。

**测试**

- sanitize/候选目录/子代理路径;
- 半行容忍、坏行跳过;
- 阶梯 1/5/50 MiB 边界与 `hasMore`;
- 文件 size 回退/ino 变化使缓存失效;
- LRU 8 条/200 MiB 淘汰;
- normalizer 的 tool/compaction/未知类型;
- projector golden 快照。

**验收**

- standalone CLI 能在夹具上稳定输出尾窗与分页;
- 单元测试全绿;
- 包内无 ZCode 业务 import(静态检查)。

**回滚**

- 新包独立,删除/不接入即无影响。

---

### 阶段 2 · SQLite 只读懒导入

**交付物**

- `sqlite-import.ts` 与 manifest 读写。
- 导入测试(幂等、增量、原子写)。

**工作项**

1. 数据源固定为 `~/.zcode/cli/db/db.sqlite`;以 `mode=ro` 打开,显式 `PRAGMA query_only=ON`。
2. 单事务读取:
   - `session` 行(标题、directory、时间);
   - `message` 按 `sequence, time_created, rowid` 排序;
   - `part` 按 `message_id, sequence, time_created, rowid` 排序。
3. 转换:
   - `message.data` JSON + `part.data` JSON → 内部记录;
   - 保留 `message.id`、`part.id`、sequence、时间戳;
   - 不丢未知 part 类型(原样存入 `raw` 字段供后续归一化)。
4. 写出:
   - 目标 `~/.zcode/demo-engine/projects/<sanitize(directory)>/<sessionId>.jsonl`;
   - 先写临时文件,`fsync` 后 `rename` 原子替换;
   - 目录不存在则创建。
5. manifest:
   - `{schemaVersion, sourcePath, sourceSize, sourceMtimeMs, lastSequence, importedAt}`;
   - 再次打开时:
     - 源库 size/mtime 未变且 `lastSequence` 一致 → 直接读 JSONL;
     - 有新增 message/part → 只追加 sequence 更大的记录;
     - 源库被替换/回退 → 重建该会话 JSONL。
6. 并发与失败:
   - 同一 session 单飞;
   - 导入失败不写 manifest,下次重试;
   - 源库被占用时返回明确错误,不阻塞其他会话。

**测试**

- 幂等:连续导入两次,JSONL 行数/哈希一致;
- 增量:新增一条 message/part 后只追加新增行;
- 原子性:模拟写入中断,旧文件仍可读;
- 源库回退:size 变小触发重建;
- 只读性:导入后源库 mtime/size 不变(排除 WAL 正常变化,校验无 SQL 写)。

**验收**

- 对夹具库导入正确;
- 对真实库的只读导入不产生任何写语句;
- 第二次打开走 `cache`/`ladder`,不再读 SQLite。

**回滚**

- 删除 `~/.zcode/demo-engine/` 即清理导入产物;原库不受影响。

---

### 阶段 3 · 设置开关与极薄接线

**交付物**

- `demoEngineEnabled` 设置字段与 schema。
- `DemoEngineSetting.tsx` 设置组件。
- Host 装饰器 + worker 客户端 + snapshot 适配层。
- tsup worker 入口与依赖。

**工作项**

1. **设置字段**
   - `packages/shared/src/protocol.ts`:`AppSettings` 增加 `demoEngineEnabled?: boolean`;
   - `packages/shared/src/validationAppSettings.ts`:
     - 完整 schema:`demoEngineEnabled: z.boolean().default(false)`;
     - patch schema:`demoEngineEnabled: z.boolean().optional()`。
2. **设置组件**
   - 新文件 `packages/ui/src/settings/DemoEngineSetting.tsx`,仿 `ProactiveSuggestionsSetting.tsx:11-47`;
   - 使用 `useSettings({ services: useBaseWorkspaceServices() })`,确保写到本地 Host 设置;
   - `Switch` + 标题/说明/只读提示/重启提示。
3. **渲染入口**
   - `packages/ui/src/settingsPageHelpers.tsx`:import + 在 onboarding 卡前渲染 `<DemoEngineSetting/>`;
   - 不改 `SettingsPage.tsx` 的业务分支。
4. **i18n**
   - `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` 新增:
     - `settings.demoEngine.title`
     - `settings.demoEngine.description`
     - `settings.demoEngine.readOnlyNotice`
     - `settings.demoEngine.restartHint`
5. **Host 读取与注册**
   - `packages/desktop/src/host/index.ts:3782-3786` 已有 `settingService`;
   - 在 `initializeServices` 内读取一次设置(与网络代理读取共用同一实例);
   - `createLocalServices`(`:3818`)之后、`activeServices = initializedServices`(`:4050-4052`)之前:
     ```ts
     if (settings.demoEngineEnabled === true) {
       const base = initializedServices.get(IZCodeAgentService);
       initializedServices.register(
         IZCodeAgentService,
         createDemoEngineAgentService(base, createDemoEngineClient()),
       );
     }
     ```
   - `ServiceCollection.register` 是 Map 覆盖语义(`packages/services/src/collection.ts:16-19`);
   - `createZCodeAgentConnectionScope`(`host/index.ts:2611-2615`)继续负责可信门禁。
6. **Worker 与构建**
   - `packages/desktop/tsup.config.ts` host 配置增加:
     - `"host/demoEngineWorker": "src/host/demo-engine/demoEngineWorker.ts"`;
     - `noExternal` 增加 `@zcode/demo-engine`。
   - `packages/desktop/package.json` 增加 `"@zcode/demo-engine": "workspace:*"`。
7. **默认关闭**
   - 设置缺省 false;
   - 装饰器只在启用时注册;
   - 关闭时原服务对象不被替换。

**测试**

- `appSettings` 全量/patch schema 测试(含未知键行为);
- 设置组件渲染与更新测试;
- `ServiceCollection.register` 覆盖行为测试;
- 开关关闭时 `get(IZCodeAgentService)` 仍是原对象。

**验收**

- 设置页可切换并持久化到 `~/.zcode/v2/setting.json`;
- 重启后开关生效;
- 关闭时无任何新代码路径被执行。

**回滚**

- 删除设置字段的两行 schema + 一处注册块,即可恢复;
- 用户侧关闭开关即可。

---

### 阶段 4 · 只读探针闭环

**交付物**

- `demoEngineClient.ts`、`demoEngineAgentService.ts`、`snapshotAdapter.ts`。
- v4 订阅、初始快照、分页、只读语义、诊断。

**工作项**

1. **Worker RPC**
   - 请求 `{requestId, type, params}`;
   - 响应 `{requestId, ok, result|error}`;
   - 事件 `{type:"event", event}`;
   - 超时、取消、dispose;worker 退出时 fail-closed 并上报。
2. **装饰器**
   - 使用 `Proxy` 包住 base `IZCodeAgentService`;
   - 覆盖:
     - `subscribeConversationV4`
     - `resyncConversationV4`
     - `unsubscribeConversationV4`
     - `conversationRowsRangeV4`
     - `conversationPlansV4`
     - `conversationFileChangesV4`
     - `conversationFileRewindPreviewV4`
     - `sendConversationCommandV4`
     - `queryConversationCommandsV4`
     - `onDynamicConversationFrame`
   - 其余方法 `Reflect.get(base, prop, base)` 后绑定转发;
   - 不覆盖 `helloConversationV4`/`initializeConversationV4`,由 connection scope 负责。
3. **订阅时序**
   - `subscribeConversationV4` 只返回 ACK(`packages/shared/src/zcode-protocol-v4/transport.ts:461-466`);
   - `ack = { subscriptionId, mode:"snapshot", logEpoch, openTiming }`;
   - 初始 snapshot 在 ACK 返回后用 `setImmediate` 作为 `conversationTopicFrame` 事件发出。
4. **快照适配**
   - 快照经 `conversationSnapshotSchema.parse` 校验;
   - `rows.window` 尾窗 60,`rows.totalCount`/`firstRowId` 来自引擎;
   - `control`、`config`、`usage`、`queue` 等用显式最小默认值;
   - `logEpoch` 每 worker 进程随机;`seq`/`revision` 单调。
5. **只读语义**
   - `availability` 所有动作 `{allowed:false, reasonCode:"demo.readOnly"}`;
   - `inputRouting = {mode:"reject", reasonCode:"demo.readOnly"}`;
   - `sendConversationCommandV4` 直接返回同 reasonCode 的错误;
   - 若 UI 未据此禁用输入,记录为后续小修项,不在本阶段改 UI 业务组件。
6. **分页**
   - `conversationRowsRangeV4({beforeRowId, limit≤200})`;
   - 返回 `{rows, atSeq, atRevision, atLogEpoch, hasMore}`;
   - `beforeRowId` 来自当前窗口首行,不新增 `beforeUuid`。
7. **诊断**
   - ACK 的 `openTiming` 填:
     - `historyReadyMs` = 引擎 openSession 总耗时;
     - `snapshotRowCount` = 尾窗行数;
     - `cliProcessState` 不填(无 CLI);
   - 引擎自身写 `diagnostics.jsonl`:
     `tail_source`、`tail_file_bytes`、`tail_rungs`、`tail_read_bytes`、`tail_read_ms`、`tail_parse_ms`、`tail_rows_parsed`、`tail_rows_kept`、`tail_handler_ms`、`tail_session_wait_ms`、`cache_hit`。
8. **session 服务**
   - 首版不装饰;
   - 若实测 `readSession`/`resumeSession` 仍拉起原 CLI,再新增 `sessionAdapter.ts`,只接管这两个方法并 fail-closed 到 demo。

**测试**

- 装饰器:白名单方法走 demo,其余方法转发 base;
- 握手:scope 的 `helloConversationV4`/`initializeConversationV4` 不被破坏;
- subscribe:ACK 后收到 snapshot 帧;
- rowsRange:分页游标、`hasMore`、`beforeRowId` 边界;
- 只读:命令被拒绝且 reasonCode 正确;
- snapshot golden:`conversationSnapshotSchema.parse` 通过;
- 关闭开关:所有方法直接走 base。

**验收**

- 只读探针五条通过(见 1.3);
- 无原 CLI 子进程;
- 诊断可读。

**回滚**

- 关闭开关并重启;
- 或移除装饰器注册块。

---

### 阶段 5 · 验收、基线与打包

**交付物**

- 自动化测试与门禁结果。
- 手动验收记录。
- 基线数据目录。
- 打包产物检查记录。

**工作项**

1. **门禁**
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm fmt:check`
   - `pnpm architecture:check`
   - 根 `pnpm test:unit`(或项目规定的根 vitest)
2. **手动验收**
   - 开关关闭 → 历史会话/新会话行为不变;
   - 开关开启 → 重启 → 打开大会话:
     - 尾窗 60;
     - 上滚分页 200;
     - 只读提示/输入拒绝;
     - 无原 CLI spawn;
     - `tail_source` 从 `sqlite_import` 变为 `ladder`/`cache`。
   - 关闭 → 重启 → 恢复原引擎。
3. **基线**
   - 落盘 `docs/research/session-open-baseline-data/demo-engine/`:
     - 会话 id(脱敏)、行数、耗时、`tail_*` 字段、内存峰值(可得时);
     - 与现有 `openTiming.historyReadyMs` 对比。
4. **打包**
   - `out/host/demoEngineWorker.js` 存在;
   - `@zcode/demo-engine` 已内联,无裸包引用;
   - asar 抽查无用户数据、凭据、绝对路径;
   - 包体积增量在可接受范围。

**验收**

- 所有门禁通过;
- 打包产物可启动,开关可用;
- 基线文件落盘。

**回滚**

- 不发布该构建;开关默认关闭。

---

### 阶段 6 · 能力扩展 Gate(待定)

本阶段不启动,需单独评审。候选方向:

1. **搜索**:transcript search worker(用户/助手消息、摘要、并发上限)。
2. **实时 append/delta**:新会话/新消息从引擎流式写入 JSONL 并下发 `row.appended`/`row.delta`。
3. **发消息与工具执行**:新引擎自建 agent loop、模型调用、工具执行、权限/中断。
4. **Claude 直接导入**:指向 `~/.claude/projects` 的同构读取(只读演示)。
5. **状态采样**:stall sampler + LOAF。

进入条件:

- 只读探针验收通过;
- 明确首版能力范围(只读/可对话/全功能);
- 明确远端工作区策略;
- 明确是否允许修改 `packages/ui` 业务组件(只读提示之外)。

## 4. 文件改动清单(现有 + 新增)

| 文件                                             | 改动                                                     | 量级   | 阶段 |
| ------------------------------------------------ | -------------------------------------------------------- | ------ | ---- |
| `packages/shared/src/protocol.ts`                | `AppSettings` 增加 `demoEngineEnabled?: boolean`         | +1 行  | 3    |
| `packages/shared/src/validationAppSettings.ts`   | 完整 schema `.default(false)`;patch schema `.optional()` | +2 行  | 3    |
| `packages/ui/src/settingsPageHelpers.tsx`        | import + 渲染 `<DemoEngineSetting/>`                     | +2 行  | 3    |
| `packages/ui/src/settings/DemoEngineSetting.tsx` | 新组件,仿 `ProactiveSuggestionsSetting.tsx:11-47`        | 新文件 | 3    |
| `packages/ui/src/i18n/locales/zh-CN.ts`          | 4 个设置文案键                                           | +4 行  | 3    |
| `packages/ui/src/i18n/locales/en-US.ts`          | 4 个设置文案键                                           | +4 行  | 3    |
| `packages/desktop/src/host/index.ts`             | 读设置 + 注册装饰器                                      | ~10 行 | 3    |
| `packages/desktop/tsup.config.ts`                | host worker 入口 + `noExternal`                          | +2 行  | 3    |
| `packages/desktop/package.json`                  | workspace 依赖                                           | +1 行  | 3    |

**明确不改**

- `apps/zcode-cli/**`
- `packages/services/**` 业务逻辑
- SQLite migrations / schema
- `packages/shared/src/zcode-protocol-v4/**`
- 现有 UI 业务组件(设置页插入除外)

## 5. 数据格式与存储布局

### 5.1 目录

```
~/.zcode/demo-engine/
  projects/
    <sanitize(cwd)>/
      <sessionId>.jsonl
      <sessionId>/
        subagents/
          agent-<agentId>.jsonl
  manifests/
    <sessionId>.json
  diagnostics.jsonl
```

### 5.2 JSONL 记录

- 一行一个 JSON 对象;
- 公共字段:`v`(schema 版本)、`type`、`sessionId`、`timestamp`、`sequence`;
- 消息记录保留原始 `messageId`/`partId`;
- 未知字段原样保留,未知 type 不丢;
- 读取端不依赖字段顺序。

### 5.3 manifest

```json
{
  "schemaVersion": 1,
  "sourcePath": "C:/Users/<user>/.zcode/cli/db/db.sqlite",
  "sourceSize": 3144994816,
  "sourceMtimeMs": 1790000000000,
  "lastSequence": 12345,
  "importedAt": "2026-10-20T00:00:00.000Z"
}
```

### 5.4 导入规则

- 源库只读:`mode=ro` + `PRAGMA query_only=ON`;
- 单事务读,保证 message/part 一致;
- 按 `sequence` 升序写入;
- 原子写:临时文件 + `fsync` + `rename`;
- 源库 size/mtime 未变且 `lastSequence` 一致 → 跳过导入;
- 有新增 → 只追加;
- 源库回退/替换 → 重建该会话。

### 5.5 并发与一致性

- 同一 session 单飞;
- 引擎 worker 单线程处理请求,天然串行;
- 读 JSONL 不持有锁;
- 导入期间原库由 SQLite WAL 保证读一致性;
- 不双写、不回写原库。

## 6. 协议适配

### 6.1 装饰器白名单

见阶段 4 工作项 2。核心原则:

- 只覆盖 v4 会话读路径;
- 未覆盖方法一律转发;
- 不覆盖 scope 自有的 hello/clientHello;
- 发生异常时,读路径 fail-closed 到 demo 错误,不静默回退原引擎(避免"以为在看新引擎、其实拉起旧 CLI")。

### 6.2 subscribe / ACK / snapshot

- `subscribeConversationV4` 只返回 ACK;
- 初始 snapshot 在 ACK 之后以 `conversation/<sessionId>` topic 帧发出;
- `subscriptionId` 由装饰器生成并在 ACK 与帧中保持一致;
- `logEpoch` 每个 worker 进程随机;
- `seq`/`revision` 单调递增;
- `resync` 重新发送完整 snapshot。

### 6.3 只读语义

```ts
availability: {
  fork: { allowed: false, reasonCode: "demo.readOnly" },
  compact: { allowed: false, reasonCode: "demo.readOnly" },
  switchModelConfig: { allowed: false, reasonCode: "demo.readOnly" },
  setFollowupMode: { allowed: false, reasonCode: "demo.readOnly" },
  queueEdit: { allowed: false, reasonCode: "demo.readOnly" },
  sendQueuedNow: { allowed: false, reasonCode: "demo.readOnly" },
  pauseGoal: { allowed: false, reasonCode: "demo.readOnly" },
  resumeGoal: { allowed: false, reasonCode: "demo.readOnly" },
},
inputRouting: { mode: "reject", reasonCode: "demo.readOnly" },
runtimeInitialization: { status: "ready", attemptId: "<random>" },
```

### 6.4 事件

- `onDynamicConversationFrame` 返回 `Event<T>`(函数 + `IDisposable`);
- 内部维护监听器 Set;
- worker 事件 → 适配层过滤 → 监听器;
- dispose 时清空并终止 worker。

### 6.5 诊断

引擎诊断与 ACK `openTiming` 的对应:

| 引擎字段                       | ACK/用途                 |
| ------------------------------ | ------------------------ |
| `openSession` 总耗时           | `historyReadyMs`         |
| `rowsTail.length`              | `snapshotRowCount`       |
| `tail_source`                  | 引擎 `diagnostics.jsonl` |
| `cache_hit`                    | 引擎 `diagnostics.jsonl` |
| `tail_read_ms`/`tail_parse_ms` | 引擎 `diagnostics.jsonl` |
| `tail_rows_parsed`/`kept`      | 引擎 `diagnostics.jsonl` |
| `tail_session_wait_ms`         | 引擎 `diagnostics.jsonl` |

## 7. 测试矩阵

| 层            | 用例                                            | 类型      |
| ------------- | ----------------------------------------------- | --------- |
| locator       | sanitize、200 字符哈希、候选目录、子代理路径    | 单元      |
| jsonl-reader  | 半行、坏行、空文件                              | 单元      |
| tail-reader   | 1/5/50 MiB 边界、`hasMore`、行数上限            | 单元      |
| cache         | 三元组失效、LRU 淘汰、generation                | 单元      |
| sqlite-import | 幂等、增量、原子写、源库回退                    | 单元/集成 |
| normalizer    | text/reasoning/tool/compaction/未知             | 单元      |
| projector     | rowId/turnId/timeline golden                    | 单元      |
| settings      | 全量/patch schema、默认 false                   | 单元      |
| 装饰器        | 白名单/转发/异常 fail-closed                    | 单元      |
| v4            | subscribe ACK+snapshot、rowsRange、只读命令拒绝 | 集成      |
| snapshot      | `conversationSnapshotSchema.parse` golden       | 单元      |
| 手动          | 开关开/关、大会话、分页、无 CLI spawn、打包     | 手动      |

## 8. 手动验收步骤

1. 构建并启动带 demo 引擎的 desktop。
2. 设置 → 通用 → 打开「Demo 引擎(实验)」。
3. 完全重启应用。
4. 打开一个历史大会话:
   - 首屏显示尾窗;
   - 上滚触发分页;
   - 输入区不可发送/提示只读;
   - 任务管理器确认无新的 `zcode-cli` 子进程。
5. 查看 `~/.zcode/demo-engine/diagnostics.jsonl`:
   - 首次 `tail_source=sqlite_import`;
   - 再次打开 `cache` 或 `ladder`。
6. 关闭开关 → 重启 → 打开同一会话,确认恢复原引擎。
7. 打包产物检查:
   - `out/host/demoEngineWorker.js`;
   - asar 内无裸 `@zcode/demo-engine` 引用;
   - 无用户数据/凭据。

## 9. 风险与对策

| 风险                                   | 对策                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| 薄接线仍触及 8 个现有文件 + 1 个新组件 | 每处 1–10 行;集中在一个带注释的 `if (demoEngineEnabled)` 块;开关关闭回归测试  |
| 设置读取一次,切换需重启                | UI 明示「重启后生效」;首版不做热切换                                          |
| 旧版本回滚丢弃未知设置键               | 默认 false + schema 测试 + 文档注明                                           |
| 快照 schema 严格导致面板打不开         | 所有快照 `parse`;golden 测试锁字段                                            |
| 代码路径绕过装饰器                     | 在 `activeServices` 返回前注册;搜索所有 `get(IZCodeAgentService)` 调用验证    |
| restore 拉起原 CLI                     | 实测;必要时加 session 装饰器并 fail-closed                                    |
| 大会话首次懒导入慢                     | worker 隔离、单飞、诊断;第二次走 tail;首版接受首开较慢                        |
| 原库并发写导致导入不一致               | `mode=ro` + 单事务;记录最后 sequence,下次增量补齐;不双写                      |
| Windows 文件身份不稳定                 | `(ino,size,mtime)` 不可用时退回 `(size,mtime)`                                |
| 打包遗漏 worker/新包                   | tsup 入口 + `noExternal` + 构建后检查 + asar 审计                             |
| 上游同步冲突                           | 新包全新增;现有文件只加接线块;设置字段 additive                               |
| 只读提示未被 UI 采纳                   | 先用 `inputRouting/availability`;若无效,记录为后续小修,不在首版改 UI 业务组件 |

## 10. 提交切分与推送约束

| #   | 提交                                                 | 内容     |
| --- | ---------------------------------------------------- | -------- |
| 1   | `docs(demo-engine): 记录第一阶段方向与边界`          | 本文档   |
| 2   | `feat(demo-engine): 独立 transcript 核心与夹具`      | 阶段 1   |
| 3   | `feat(demo-engine): SQLite 只读懒导入与 JSONL 落盘`  | 阶段 2   |
| 4   | `feat(desktop): Host 装饰器与 worker 接线(默认关闭)` | 阶段 3   |
| 5   | `feat(settings): 增加 demo 引擎只读开关`             | 阶段 3   |
| 6   | `test(demo-engine): 接线与 golden 快照验收`          | 阶段 4/5 |

约束:

- 只推送 `zcodefork`(qianmeng406/ZCode),**永不推 origin**(zai-org/ZCode);
- 正常 hooks,不使用 `--no-verify`;
- 不 force push、不改写历史;
- 凭证仅存私有/不入库文件,不进日志;
- 构建/清理仅限自证归属目录,未知未跟踪文件不删。

## 11. 待定项

1. **首版能力范围**:只读 / 可继续对话 / 全功能替代。
2. **发消息与工具执行**:是否由新引擎自建 agent loop,还是复用现有子进程。
3. **远端工作区**:`source-server-workspace`/`remote-projects` 下 transcript 的存放与同步策略。
4. **Claude 直接导入**:是否把 `~/.claude/projects` 作为第二数据源长期保留。
5. **搜索与状态采样**:transcript search worker、stall sampler 是否进入下一阶段。
6. **热切换**:是否需要不重启切换引擎(当前明确不支持)。

以上待定项在对应阶段启动前必须给出结论;未定则不进入该阶段实现。
