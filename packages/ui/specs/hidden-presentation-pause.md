# 隐藏会话展示暂停（Hidden Presentation Pause）

## 产品规则

不可见但仍挂载的聊天视图只做**展示层**的暂停：运行中的每秒时钟、分享专属索引等
纯派生计算在不可见时不做，恢复可见时立即补齐。消息接收、投影更新、权限/问答、
命令确认与任务状态一律不受影响。

### 展示可见性（presentationVisible）

- 与 `focused`（快捷键/路由）、`telemetryVisible`（前台遥测）、`readOnly` 分开。
- 资格 = 主工作区可见性（设置覆盖时 false）× 该 pane 实际可见：
  - 主聊天分屏：布局叶子中该 pane 可见即 true，未聚焦但可见的分屏仍实时更新；
  - 侧边 transcript：`面板可见 && 活动 tab`；
  - 设置覆盖：整体 false（主区仍挂载，仅暂停展示）。
- 新增可选 prop 默认 true，兼容现有调用方；不改隐藏方式与布局占位。

### 运行中时钟

- `ConversationTimeline` 的 `liveNowMs` 每秒 tick 只在
  `presentationVisible && hasRunningUnit` 时运行。
- 恢复可见时立即 `Date.now()` 校准一次；完成态耗时仍由协议事实提供，不用 UI 时钟。

### 分享专属索引

- `shareRenderUnits` / `shareItems` / eligible 集合等分享专用派生只在 `shareActive`
  （存在 partial 分享草稿）时计算；否则返回稳定空数组/集合。
- **不以分享面板可见性或 selection 阶段为资格**：收起面板、进入配置阶段仍消费数据。
- 分享分页 owner、选择同步、预检、发布与错误恢复不受影响。

### 不做的事（边界）

- 不冻结整个 SessionPane、不节流投影通知、不拆测高/滚动恢复 effect。
- 不暂停消息流、lease、权限/AskUser、pending command 恢复、任务通知。
- 不改变 30 秒投影 store 保温与 owner/lease 语义。

## 状态所有者与接口

- 展示资格所有者：宿主（root 设置覆盖 + 布局/侧栏可见性合成）向下传
  `presentationVisible`。
- 时钟所有者：`ConversationTimeline`（effect 依赖 presentationVisible）。
- 分享索引所有者：`SessionPane`（memo 依赖 shareActive）。

```
隐藏 ──▶ presentationVisible=false ──▶ 停 tick / 停分享索引计算
数据帧到达 ──▶ store 投影照常 ──▶ 隐藏视图不重建展示派生
恢复 ──▶ 立即校时 + 重算展示派生（数据无需重取）
```

## 验收场景

1. 设置覆盖下运行中会话：每秒 tick 停止；返回后立即校准并继续 tick。
2. 侧边 transcript 收起时运行中：tick 停止；重新打开计时正确。
3. 双分屏未聚焦 pane：tick 与消息展示照常（不因 focused=false 暂停）。
4. 回合完成：耗时显示与协议事实一致，不受时钟暂停影响。
5. 未进入分享：不构建分享索引；进入分享选择后索引立即可用。
6. 分享选择中收起面板再进入配置：选择集与预检状态保留。
7. 消息、权限问答、命令恢复在隐藏期间照常到达与处理。
