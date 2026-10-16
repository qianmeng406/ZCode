# RPC 事件订阅与重订阅（event resubscribe）

## 状态所有者

- `ChannelClient` 是事件订阅 id → handler 映射（`handlers`）与活跃订阅（`activeRequests`）的唯一所有者。
- 服务端 `ChannelServer` 只按收到的 `EventListen` / `EventDispose` 维护自己的 activeRequests，不感知客户端重订阅。
- 每个 `channel.listen(event, arg)` 返回的 `Event` 对应一个客户端请求 id；该 id 的 handler 生命周期与"是否有监听者"绑定，由 `Emitter` 的 `onWillAddFirstListener` / `onDidRemoveLastListener` 驱动。

## 事件顺序（单个订阅 id）

```
首次订阅：
  client: listener 添加 → [等待 Initialize（如未初始化）] → handlers.set(id, fire) → send EventListen(id)
  server: EventListen → channel.listen() → 后续 EventFire(id, data)
  client: EventFire → handlers.get(id) → emitter.fire(data)

取消订阅（最后一个 listener 移除）：
  client: send EventDispose(id) → handlers.delete(id) → activeRequests.delete
  server: disposeActiveRequest(id)，此后不再发 EventFire(id)

同一 Event 重新订阅（复用同一 id）：
  client: 必须重新 handlers.set(id, fire) 并再次 send EventListen(id)
  server: 重新 channel.listen()，之后 EventFire(id) 恢复投递
```

## 规则

1. handler 注册必须发生在"订阅激活"（即将发送 `EventListen`）时，而不是 `requestEvent` 被调用时。取消订阅会删除 handler，重新订阅必须重建，否则后续 `EventFire` 会被静默丢弃。
2. 若订阅在 `Initialize` 之前被取消，排队中的初始化回调不得再发送 `EventListen` 或注册 handler（防止幽灵订阅泄漏）。
3. `Initialize` 前订阅、取消、再订阅（同 id）时，最终只允许发出一次 `EventListen`，且 handler 恰好注册一次。

## 验收场景

- 普通事件取消订阅后重新订阅（再次调用 `channel.listen` 并挂 listener），服务端 `listen` 被再次调用，事件恢复投递，不丢失订阅之后触发的后续事件。
- 动态同 arg 事件：同一事件名、同一 arg，取消后复用订阅函数重订阅，服务端 listen/dispose 调用次数与订阅/取消次数一致。
- 取消订阅到再次订阅之间触发的事件不投递给客户端（unsub 期间无事件）。
- 未初始化时订阅后立即取消，连接初始化完成后不得发出 `EventListen`。
