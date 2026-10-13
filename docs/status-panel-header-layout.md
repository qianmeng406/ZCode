# Status Panel Header Layout

## 目的

Status 面板的 Git、Goal、Progress、Run 区块标题需要保持一致的信息顺序，避免同一面板内出现一部分状态信息靠右、一部分状态信息跟随标题的混合布局。

## 规则

- 区块标题行的顺序为：标题、展开/收起箭头、状态内容。
- Git、Progress、Run 的折叠态状态内容必须紧跟箭头后显示，不再使用 `ml-auto` 推到最右侧。
- Goal 的暂停/恢复操作是当前目标的即时动作，显示在耗时和 tokens 指标之前。
- 展开态 Status 面板在右上角提供一个绝对定位的面板收起按钮，用于切换到 mini 状态。
- 右上角面板收起按钮存在时，区块标题行需要预留右侧空间，避免标题、箭头或状态内容与按钮重叠。
- Mini 胶囊展示运行中的后台任务时，只显示任务类型图标和运行中任务数量，不显示已运行时长或计时器；展开态 Run 区块及任务明细继续显示耗时。

## 兼容性

- 该布局不改变 status 面板的数据来源，只改变标题行的信息排列。
- Mini 状态仍使用原有胶囊行展开入口。
- 文案继续使用现有 i18n key，不新增语言资源。
- 历史会话窗口挂载状态面板时，右上角菜单必须保留悬停提示、键盘开关及焦点恢复，且不能触发 React #185。
- 菜单触发器采用 `Tooltip > DropdownMenuTrigger asChild > TooltipTrigger asChild > Button`，两个触发器共享同一个 button，不额外包裹 DOM。仅交换层级不能保证 ref 稳定，依赖中的 Slot 与 DropdownMenuTrigger 必须以输入 refs 为依赖缓存组合 ref。
- DOM 节点及输入 refs 不变时，提示开关、父组件重渲染、菜单开关不能触发 ref detach/attach；真实卸载及 ref 替换仍须执行 React 19 cleanup 或旧式 `ref(null)`，不得吞掉清理或延迟状态更新。
- 验收覆盖真实 Radix 触发器（不 mock Tooltip/Dropdown）、面板反复挂载及菜单开关；生产测试必须先创建 DOM 再加载组件依赖，并断言 ref 生命周期而不只是没有抛出 #185。
- React 根级及局部错误边界通过生产可用的生命周期诊断出口记录序列化 error message、运行时 stack 与组件 stack，不重新打开普通消息流日志。
