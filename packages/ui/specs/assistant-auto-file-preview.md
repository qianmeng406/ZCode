# 自动文件预览（Assistant Auto File Preview）

## 产品规则

Assistant 正文中的 Markdown/HTML 文件引用会自动读取本轮 `fileChanges` 权威明细，
判断是否确为本轮生成/修改的文件并生成预览卡片。该自动查询可由用户关闭，改为点击加载。

### 开关与资格

- 客户端展示偏好 `assistantAutoFilePreviewEnabled`（`packages/ui/src/store`），
  持久化到安全 localStorage，**仅显式 `false` 表示关闭，缺省/缺失为开启**（兼容旧体验）。
- 设置入口：设置 → 外观 → 界面设置，复用 SettingsRow + Switch；修改即时生效，
  其他桌面窗口经既有 `state:` 广播同步，payload 校验 boolean 并防回环。
- 遥测动作登记 `toggle_assistant_auto_file_preview`（feature `settings.appearance`、
  trigger `switch`）。

### 自动加载的触发条件（现状，不回归）

仅当同时满足才自动查 `fileChanges`：
1. 当前回合最新 assistant 文本为 complete/interrupted；
2. 提取到 Markdown/HTML 引用（Office/PDF 不触发本次明细查询）；
3. 有 turnHeader target（V4 fileChanges 只接受 turnHeader）；
4. 未 reverted；
5. 开关开启；
6. 所在视图具备展示资格（隐藏时不发起自动查询，恢复后补齐）。

### 关闭时

1. 不自动发起 `fileChanges` 查询。
2. 正文、原始文件链接、Office/PDF 卡片、展开文件摘要（ConversationFileSummaryPanel）
   功能保留。
3. 对确有 Markdown/HTML 引用但未加载的回合显示轻量「加载预览」按钮；
   点击走原 turnHeader 目标、原 fetchFileChanges（缓存策略 terminal）、原 builder。
4. 按钮有 loading / error / retry，防重复点击。
5. 未加载、失败或已 reverted 时**不得**用正文引用冒充"本轮生成文件"卡片。

### 正确性边界

- 权威明细缺失时禁止伪造卡片；失败即抑制对应 Markdown/HTML 卡片（现状语义）。
- 请求 key 沿用 rowId/entityId/fileChangesState；会话、logEpoch、target、reverted
  变化时按原规则失效。
- 回包校验 scope：隐藏/卸载/作用域变化后的迟到结果不得污染其他消息。
- 摘要展开读取 diff ≠ 生成预览卡片，两者不互相代替。

## 状态所有者与接口

- 偏好所有者：`packages/ui/src/store`（setter + 安全 localStorage + 广播）。
- 自动加载资格所有者：`useAssistantPreviewCardsForAssistantTextRow`
  （新增 `autoPreviewEnabled` 与展示资格参数；保留 `fetchFileChanges` 注入）。
- 权威明细所有者：`SessionPane.handleFetchFileChanges`（共享 Promise 缓存不变）。
- 行展示注入：`ConversationRowRenderContext`（行不直接读全局 store）。

```
开关/展示资格 ──▶ hook 裁决 ──▶ 自动 fetchFileChanges（现状）
       │ 关闭
       ▼
  「加载预览」按钮 ──▶ 用户点击 ──▶ 同一 fetchFileChanges / 同一 builder
```

## 验收场景

1. 默认（无偏好）：自动预览行为与旧版一致。
2. 关闭后：滚动浏览长会话不产生 fileChanges 查询；正文与链接完整。
3. 关闭后点击「加载预览」：生成的卡片与自动加载完全一致。
4. 关闭后对已加载回合：卡片保留，不重复请求。
5. reverted 回合：无卡片、无请求（与现状一致）。
6. Office/PDF 引用：不触发 fileChanges，卡片行为不变。
7. 文件摘要展开：正常读取 diff，不因开关关闭而失效。
8. 偏好跨窗口广播同步；非法 payload 忽略且不回环。
