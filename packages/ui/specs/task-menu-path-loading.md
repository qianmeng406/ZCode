# 任务菜单路径按需加载（Task Menu Path Loading）

## 产品规则

Header 任务更多菜单中的「复制任务路径 / 复制日志路径」等项需要 task session 文件路径
与 native 日志路径。这两条查询只在菜单打开时执行，不在会话切换、列表重排时提前查询。

### 查询资格

- `loadTaskPaths = taskMenuOpen && 有效 taskId`（新任务未落库前无稳定 taskId，不查）。
- 关闭菜单、切换 task、卸载：请求代际失效，迟到结果不提交。
- provider（native 日志）、workspace identity/path、service 代际变化均按新 scope 重查；
  旧 scope 结果不得展示为当前 task 路径（scope 校验，不只依赖 effect 下一拍清空）。

### 唯一所有者

- **查询唯一所有者：Header 的 context-actions**（已持有 taskMenuOpen、目标 task 与
  provider），不把菜单事件绕到 App 再回传。
- `useWorkspaceActiveTaskState` 不再常驻查询两条路径；App → Shell → Header 的冗余
  路径 props 清理。其他确有消费者的菜单继续通过原 hook 获取。
- `useTaskListItemContextActions` 继续统一承载复制/文件管理器行为。

### 菜单交互

- loading：只禁用依赖路径的复制动作；打开项目目录、复制项目路径等不依赖项保持可用。
- error：显示可重试状态，复用显式 retry（同 scope 重新发起），不关闭菜单。
- `exists=false` 不等于不可复制，保留现有复制语义。
- 任务反馈表单的日志线索用当前作用域已取得的路径；未完成时不借用旧 task 路径。

```
taskMenuOpen ──▶ context-actions ──▶ 原路径 hooks（enabled）──▶ 原服务
关闭/切 task ──▶ 代际失效 ──▶ 迟到回包弃用
```

## 验收场景

1. 冷启动进入会话：不发任何 task 路径查询。
2. 打开菜单：两个路径各查一次；关闭后不再查询。
3. 快速切换 task A→B：A 的迟到结果不显示为 B 的路径。
4. 查询失败：菜单显示错误与重试；重试成功后动作恢复。
5. 新任务（无 taskId）：不查询，复制路径动作按现状禁用/隐藏。
6. 反馈表单：路径线索与当前 task 一致；未取得时不含旧 task 路径。
7. 远端 workspace：路径来自目标 Host（remote identity 隔离），不误用本机路径。
