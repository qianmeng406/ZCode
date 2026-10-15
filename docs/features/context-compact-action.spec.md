# Context Compact Action

## Behavior

The context usage panel exposes a compact-context action when a usable context window is displayed. Activating it sends the existing v4 `/compact` command. The runtime remains the owner of admission, queueing, duplicate prevention, progress, and failure state. The UI disables the action when the host cannot accept input or a compact operation is already active.

## Ownership

`ChatContextUsage` owns presentation and sends the command callback. `SessionPane` owns command dispatch and snapshot-derived availability. The v4 command handler and runtime own compaction execution and lifecycle.

## Event order

Owners and dispatch chain for one activation:

```
User click (context popover, Compact button)
  │
  ▼
ChatContextUsage (packages/ui/src/chat-input-toolbar/contextUsage.tsx)  ── UI owner
  │  guard: renderableTaskUsage exists && onSendCompressionCommand provided
  │         && compressionDisabled !== true (host input disabled || recoveryPending)
  │  runContextPanelActionWithClose: close popover first, then dispatch
  ▼
onSendCompressionCommand("/compact")            ── callback prop (host-injected)
  │
  ▼
SessionPane.handleSendCompressionCommand        ── dispatch owner
  │  parseV4VisibleSlashCommand → dispatchSlashCommand(..., snapshot.revision, ...)
  │  compact 是可排队 input command：不 CAS，运行中也允许入队
  ▼
v4 command handler / runtime (CommandInbox admission)  ── runtime owner
  │  ack ok            → compact lifecycle 开始；UI 无本地锁，状态全部来自快照投影
  │  ack compactOperationLock → toast chat.compact.duplicateBlocked
  │  ack activeTurn    → toast chat.compact.runningBlocked
  │  queue backpressure → toast chat.compact.queued
  ▼
Snapshot projection (usage/rows/control) → SessionPane → Composer props
  (phase, usage.contextWindow, disabled) → ChatContextUsage re-render
```

Single-writer rule: the UI never derives a local "compact running" lock. Duplicate
prevention is owned by the runtime admission (`compactOperationLock` ack) plus the
`compressionDisabled` prop passed down from the host (`disabled || recoveryPending`
in `V4ComposerToolbar`). If a future "compaction in progress" presentation is
needed, it must arrive via the snapshot contract, not component-local state.

## Compatibility

No new compact protocol or runtime path is introduced. Existing slash-command and context-panel compact entry points remain valid.

## Acceptance

- The action is visible in the context popover and has an accessible label.
- One activation dispatches exactly `/compact`.
- Disabled and running states prevent duplicate dispatch.
- Existing context breakdown, cache, quota, and compact marker rendering are unchanged.

## Non-goals

This feature does not change compaction policy, summary prompts, token estimation, or timeline semantics.
