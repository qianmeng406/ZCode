import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@zcode/contracts";
import { resolveContextProfile, resolveExecutionState } from "@zcode/shared";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  buildExecutionStateEntry,
  installRuntimeExecutionState,
  readRuntimeExecutionState,
} from "./execution-state.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Set<string>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
export async function grantPermissionFullAccess(
  this: AgentRuntimeInternal,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  this.permissionFullAccessPending = true;
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else {
      const projection = await this.rebuildProjection();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      // Beta 已是完全访问权限：授权保留 Beta。事件、持久化执行状态与内存安装必须写同一个
      // 值，不能只改内存——否则投影/重启会回 yolo，下一次提交静默退出 Beta。
      const grantedMode = previous.mode === "beta" ? "beta" : "yolo";
      const next = { ...previous, mode: grantedMode };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          previousContextProfile: resolveContextProfile(previous),
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      signal?.throwIfAborted();
      await this.sessionStore.commitPermissionFullAccess({
        sessionID: this.sessionId,
        queueItemIds,
        signal,
        execution: buildExecutionStateEntry(this.sessionId, next),
        receipt: {
          id: receiptId,
          sessionID: this.sessionId,
          type: PERMISSION_FULL_ACCESS_ENTRY,
          touchSession: false,
          time: { created: Date.now(), updated: Date.now() },
          data: { interactionId, event },
        },
      });
    }
    const payload = event.payload as SessionModeChangedPayload;
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionFullAccess.call(this, interactionId),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 事务已提交：之后即使传输取消也必须完成内存和投影发布，不能制造半个授权。
    const applied = appliedGrants.get(this) ?? new Set<string>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      // 统一走已提交状态安装：授权只改权限，但同样要失效工具缓存并推进派生版本，
      // 否则 minimal→yolo 等切换会沿用旧档位的工具表与前缀。payload 经 receipt 校验
      // 固定为 yolo 或 beta（Beta 会话保留 Beta）；以会话当前状态为基线解析，保留上下文档位。
      const previous = readRuntimeExecutionState(this);
      const grantedMode: "beta" | "yolo" = payload.mode === "beta" ? "beta" : "yolo";
      installRuntimeExecutionState(
        this,
        resolveExecutionState(
          { mode: grantedMode, planEnabled: payload.planEnabled },
          previous,
        ),
      );
      // intent 只接受提交模式值域：授权后排队输入沿用本次授权目标（Beta 保留 beta）。
      const intentMode: "beta" | "yolo" = grantedMode;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode: intentMode };
      }
      applied.add(interactionId);
      appliedGrants.set(this, applied);
    }
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    this.permissionFullAccessPending = false;
  }
}
