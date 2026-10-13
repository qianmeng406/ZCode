# 辅助面板按需加载（On-demand Panel Loading）

## 产品规则

侧边栏、右侧辅助面板里的文件树、Git 详情、任务列表在**不可见**时不再继续发起
属于它们自己的额外查询与派生计算；重新可见时保留已有内容并补刷一次。
本 spec 只收紧展示边界，不改变 Agent 协议、消息投影、Git 执行策略和 task-index 行为。

### 可见性资格（唯一事实）

```
工作区可见性（设置覆盖时 false）
  ├─ 左文件树：侧栏可见 && 文件树打开
  ├─ 任务列表：侧栏可见 && 未被文件树覆盖 && 对应列表视图显示
  ├─ 右侧面板：面板可见 && 作用域内活动 tab（isVisible && tabId === visibleActiveTabId）
  └─ Git 详情：Git tab 真实可见
```

- 可见性 ≠ focused：分屏中未聚焦但可见的区域继续实时更新。
- 不用 DOM IntersectionObserver 推测业务可见性；不改隐藏方式（CSS 隐藏/占位）。
- 不复用 `enableWorkspaceFeatures`（它表达临时外部目录的 Git/watch 能力）。
- 右侧 `active` 语义沿用 `AnimatedSidePanePanel` 已有的 `isVisible && 活动 tab`。

### 文件树

- 隐藏：停止新的目录读取、`getIgnoredPaths`、Git 标记查询与派生构建；清空待刷新
  timer/队列/暂态 loading；释放本树 watcher。已加载 children、展开、选择、Git/ignored
  缓存保留，不清树、不重挂载。
- 恢复：先展示缓存，再刷新根目录与已加载/展开目录的相关状态；只按原策略监听根与展开
  目录，不递归扫描全部工作区。
- 文件搜索沿用 query 非空才加载；隐藏后停止后续分页，保留搜索输入。
- 已发出的 IO 允许返回，但旧代际结果不提交、不串联后续 ignored/下一轮查询
  （不承诺能取消底层 RPC）。
- watcher 代际：隐藏即递增 generation、释放注册；旧 watch 回来后立即 unwatch，不安装
  订阅；旧 finally 不得删除恢复后的新 pending 登记。

### Git 详情

- 基础状态（分支、dirty、staged/unstaged、Header 计数）**不因 Git 面板隐藏而停止**。
- 扩展数据（identity、branch comparison）只在 Git tab 真实可见时拉取；恢复时补拉。
- diff：展开、全文搜索预取、命中导航三类入口统一受 active 门控；隐藏保留已完成 diff
  与展开/搜索状态；恢复补齐当前需要的 diff。
- 仓库 revision / workspace 变化仍按原规则失效；快速关闭重开按请求代际校验，
  旧请求的 finally 不清新 pending。

### 任务列表（展示消费者）

- 权威链路保留：sessions-index 订阅、workspace 事件、未读处理、membership 标脏
  与版本推进。隐藏期间事件继续让共享缓存变 stale，恢复后按最新版本重算。
- 只暂停展示查询与分组构建：`useGlobalTaskList` 隐藏时不 load；`useWorkspaceTaskLists`
  隐藏时不执行查询重算与展示分组。
- 保留最后可信列表，不清空 workspaceTabs / scopes 来模拟暂停。
- 在途旧查询禁止覆盖更新代际或清 stale；收口时若已隐藏不得再启动下一轮。

## 状态所有者与接口

- 文件树数据所有者：`useWorkspaceFileTreeData`（新增 `active`，默认 true）。
- 文件树 watcher 所有者：`useWorkspaceFileTreeWatchers`（generation + 空集合释放）。
- Git 扩展资格所有者：`App` 的 `useGitRepository({ includeExtendedData })`。
- Git diff 所有者：`GitPane`（新增 `active`，统一 loader 内校验）。
- 任务列表展示所有者：`useGlobalTaskList` / `useWorkspaceTaskLists`（新增 enabled）。

```
隐藏 ──▶ 代际失效 ──▶ 清 timer/队列 ──▶ 释放 watcher/停止展示查询
旧 IO 返回 ──▶ 代际校验失败 ──▶ 弃用（不提交、不续跑）
恢复 ──▶ 新代际 ──▶ 保留缓存显示 ──▶ 补刷一次
```

## 验收场景

1. 文件树从未打开：不发目录/ignored/Git 查询，无 watcher。
2. 文件树打开后关闭：watcher 释放、无新查询；重新打开保留展开与选择并补刷。
3. 隐藏期间文件变化：不触发目录/Git 刷新；恢复后补刷一次。
4. 隐藏期间已发出的 readdir 返回：结果弃用，不继续 ignored/下一轮。
5. Git 面板隐藏：Header 分支/dirty 仍更新；不拉扩展数据与 diff；恢复补拉。
6. Git 搜索中隐藏：停止批量 diff 预取；恢复后按当前搜索补齐。
7. 侧栏收起或切到非项目视图：任务列表不发起展示查询；未读与 pin/archive 事件仍同步。
8. 侧栏恢复：按最新 Controller/taskListVersion/source generation 查询一次。
9. 远端 workspace 重连（identity 不变、source 代际变化）：缓存按代际重查，不沿用空结果。
