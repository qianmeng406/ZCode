# 会话回合导航（Conversation Turn Navigator）

## 产品规则

聊天左侧的回合索引 rail：每条短线对应一条 real-user query，hover 显示用户/助手预览，
点击定位到对应回合。索引只在该功能开启时存在；关闭开关必须真正停用导航的全部专属工作，
而不是仅隐藏 DOM。

### 开关与资格

- 客户端展示偏好 `conversationTurnNavigatorEnabled`（`packages/ui/src/store`），
  持久化到安全 localStorage，仅字符串 `"true"` 表示开启；缺失或非法值一律关闭。
  **默认关闭。**
- 设置入口：设置 → 外观 → 界面设置。修改后当前窗口即时生效，其他桌面窗口经既有
  `state:` 广播同步；广播 payload 必须校验 boolean。
- 导航可见还须同时满足（缺一不可）：
  1. 功能开启；
  2. 未处于分享选择阶段（分享独占左 rail，`hideTurnNavigator`）；
  3. 会话容器宽度 ≥ 864px（CSS container query 裁决显隐，JS 侧同阈值裁决专属工作）；
  4. real-user query ≥ 2（组件自身裁决，单 query 不渲染）。

### 开启时（现状行为，不回归）

- 宽屏自动补齐当前有效分支的完整历史（目录 hydration），失败按 250ms/1s 有界重试。
- 为全部回合构建索引与预览摘要；滚动时追踪当前回合并高亮。
- real-user query 增删递增 `turnNavigatorDirectoryRevision`，使 hydration 终态失效重探测。

### 关闭时

1. 不挂载导航组件，不构建导航索引、虚拟位置映射与预览摘要。
2. 不发起导航目录 hydration，不安排导航重试；在途 attempt 的回调必须失效。
3. 导航滚动追踪（query 几何扫描、active 计算）停止；消息层 mask 等正文逻辑不受影响。
4. 撤销本 pane 对全历史加载的需求；当没有任何需求方时，已发出的一页允许返回，
   但不再请求下一页，且不提交暂存页、不写 hydration 终态缓存。
5. 已加载并显示的行不清空（避免内容/滚动跳动），因此不承诺内存立即下降。
6. 宽度测量 observer 拆除；重新开启后按当时宽度重新裁决资格。

### 分享语义（不受开关影响）

- 分享流程独立申请完整历史（`consumer: "share"`），必须获得完整提交：
  即便 real-user query < 2（导航会跳过提交），分享在途时也必须提交全部页。
- 分享只有确认完整历史已就绪（hydrated）才记录成功；busy/stale/失败保持可重试。
- 分享选择阶段隐藏 rail 时，导航专属工作一并停止，但分享自身的数据构建不受影响。

## 状态所有者与接口

- 偏好所有者：`packages/ui/src/store`（唯一写入路径 setter + 安全 localStorage）。
- 全历史加载所有者：`ConversationProjectionStore.loadAllOlder({ consumer, signal })`。
  同一会话共享 store；每次调用是独立 owner（signal = 一份需求）。同一时刻至多一个
  全历史 job，后到 owner 加入在途 job 而不是重复分页。job 在每页请求前后校验：
  store 生命周期、logEpoch、窗口首行游标、是否存在未 abort 的 owner。
- 导航 hydration attempt 所有者：`ConversationTimeline`（per-attempt AbortController；
  key 变化 / 资格撤销 / 卸载三处 abort）。
- 分享 hydration 所有者：`SessionPane` 分享 effect（独立 controller，cleanup abort）。

```
设置 Switch ──▶ store setter ──▶ localStorage + Zustand
                                    │
              ┌─────────────────────┴──────────────────┐
              ▼                                        ▼
      SessionPane 订阅                        state: 广播 → 其他窗口 setter
              ▼
   ConversationTimeline turnNavigatorEnabled
   eligible = enabled && !hideTurnNavigator
      │ eligible                       │ !eligible
      ▼                                ▼
   挂载 rail / 索引 / 追踪          卸载 + 清 attempt + 释放 owner
   loadAllOlder({navigator})        （全部 owner 释放 → job 协作停止）
```

## 验收场景

1. 默认关闭：新用户与无偏好用户均无 rail、无导航触发的全历史补拉。
2. 开启后宽屏出现 rail，窄屏（<864px）不渲染也不做导航专属计算。
3. 关闭即时生效：rail 消失，正在等待的导航重试被取消，后续分页停止。
4. 导航第一页在途时关闭：该页返回后不再发下一页，loadingOlder 正常释放；
   重新开启可重新发起。
5. 导航与分享并发：任一 share owner 在途即完整提交；导航 owner 全部退出不影响分享。
6. 普通 loadOlder（滚动预取）与查找、分享、query 定位在开关任意状态下均正常。
7. 偏好经广播跨桌面窗口同步；非法广播 payload 被忽略且不回环。
8. 分享在普通 loadOlder busy/stale 时不误标成功，依赖变化后可重试。
