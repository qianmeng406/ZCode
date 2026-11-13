import { permissionGrantCommittedReasons } from "@zcode/shared/zcode-protocol-v4";
import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@zcode/contracts";
import { resolveContextProfile, resolveExecutionState, type ExecutionState } from "@zcode/shared";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  buildExecutionStateEntry,
  installRuntimeExecutionState,
  readRuntimeExecutionState,
} from "./execution-state.js";
import { getPendingSessionPersistence } from "./methods/events.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Map<string, SessionEvent>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
export async function grantPermissionMode(
  this: AgentRuntimeInternal,
  interactionId: string,
  mode: "guarded" | "yolo",
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
    const appliedEvent = appliedGrants.get(this)?.get(interactionId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else if (appliedEvent) {
      // 草稿没有 receipt；发布失败后必须复用原事件，不能重复提权或覆盖后续用户选择。
      event = appliedEvent;
    } else {
      const projection = await this.rebuildProjection();
      // sampling 可并发创建父记录；最后一次异步准备后等待它，避免写子行或被旧权限覆盖。
      const pendingPersistence = getPendingSessionPersistence(this);
      if (pendingPersistence) await pendingPersistence;
      signal?.throwIfAborted();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      // Beta 已是完全访问权限：授权保留 Beta。事件、持久化执行状态与内存安装必须写同一个
      // 值，不能只改内存——否则投影/重启会回 yolo，下一次提交静默退出 Beta。
      // 必须用带 ExecutionState 上下文的对象字面量：条件表达式不是字面量初始化，
      // 先存到变量会把 "beta" | "yolo" 拓宽成 string，导致 buildExecutionStateEntry 拒绝入参。
      const next: ExecutionState = {
        ...previous,
        mode: previous.mode === "beta" ? "beta" : "yolo",
      };
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
      // 草稿尚无 session 父行；首发会按当前内存配置统一保存，不能为授权提前登记任务。
      if (this.sessionPersisted)
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
    // 重试只允许完成原授权，不能把另一模式的既有回执当作本次选择成功。
    // Beta 会话的授权事件写的是 beta（保留 Beta），这是合法的提权结果，不算模式不符。
    if (payload.mode !== mode && payload.mode !== "beta") {
      if (payload.mode !== "guarded" && payload.mode !== "yolo")
        throw new Error("Invalid committed permission mode");
      throw Object.assign(new Error("Permission grant mode mismatch"), {
        reasonCode: permissionGrantCommittedReasons[payload.mode],
      });
    }
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionMode.call(this, interactionId, mode),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 授权从这里同步应用；之后即使传输取消也必须完成投影发布，不能制造半个授权。
    const applied = appliedGrants.get(this) ?? new Map<string, SessionEvent>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      // 统一走已提交状态安装：授权只改权限，但同样要失效工具缓存并推进派生版本，
      // 否则 minimal→yolo 等切换会沿用旧档位的工具表与前缀。payload 经 receipt 校验
      // 固定为 yolo 或 beta（Beta 会话保留 Beta）；以会话当前状态为基线解析，保留上下文档位。
      const previous = readRuntimeExecutionState(this);
      const grantedMode: "beta" | "yolo" = payload.mode === "beta" ? "beta" : "yolo";
      installRuntimeExecutionState(
        this,
        resolveExecutionState({ mode: grantedMode, planEnabled: payload.planEnabled }, previous),
      );
      // intent 只接受提交模式值域：授权后排队输入沿用本次授权目标（Beta 保留 beta）。
      const intentMode: "beta" | "yolo" = grantedMode;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode: intentMode };
      }
      applied.set(interactionId, event);
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
