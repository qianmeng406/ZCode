import { resolveContextProfile, resolveExecutionState, type ExecutionState } from "@zcode/shared";
import { resolveRuntimeModeIdentity } from "./helpers/runtime-reminders.js";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

export function readRuntimeExecutionState(runtime: AgentRuntimeInternal): ExecutionState {
  return resolveExecutionState(runtime.config);
}

export async function persistExecutionState(
  runtime: AgentRuntimeInternal,
  state = readRuntimeExecutionState(runtime),
): Promise<void> {
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(buildExecutionStateEntry(runtime.sessionId, state));
}

export function buildExecutionStateEntry(
  sessionId: SessionId,
  state: ExecutionState,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: state,
  };
}

/**
 * 安装一份已提交（或已恢复）的执行状态，并失效由 mode/plan 派生的上下文与工具投影。
 * 只做同步内存安装：不持久化、不发布事件、不等待 MCP 连接——那些仍归 applyRuntimeExecutionState。
 *
 * 为什么要集中在这里：极简档位的提示词前缀与模型可见工具表都在「读 mode」的派生层构建
 * （ContextBuilder 的 promptProfile、getTools 的 minimal 过滤）。任何改 mode 的写路径若不
 * 同时失效缓存并推进派生版本，切换后请求仍会带上一档位的 system 段与工具表。
 */
export function installRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  next: ExecutionState,
  previous: ExecutionState = readRuntimeExecutionState(runtime),
): void {
  // 自包含解析：缺省档位按 next.mode 做旧 minimal 兼容映射。
  // 「改权限/Plan/授权保留档位」由 patch 语义的 resolveExecutionState(input, previous)
  // 在调用方完成；这里不做二次 patch 解析，否则恢复持久化状态会被 invocation 档位污染。
  const resolved = resolveExecutionState(next);
  runtime.config.mode = resolved.mode;
  runtime.config.planEnabled = resolved.planEnabled;
  runtime.config.contextProfile = resolved.contextProfile;
  if (
    previous.mode === resolved.mode &&
    previous.planEnabled === resolved.planEnabled &&
    resolveContextProfile(previous) === resolved.contextProfile
  ) {
    return;
  }
  // 模式 activation 变化（含 update→build→update 重新进入）后，下一个模式提醒必须全文；
  // 不能靠「最后一个 runtime_mode 是不是同名」判定，否则重新进入会被旧节流压掉。
  if (
    resolveRuntimeModeIdentity(previous.mode, previous.planEnabled) !==
    resolveRuntimeModeIdentity(resolved.mode, resolved.planEnabled)
  ) {
    runtime.runtimeModeReminderPendingFull = true;
  }
  if (previous.planEnabled !== resolved.planEnabled)
    runtime.needsPlanModeExitReminder = !resolved.planEnabled;
  runtime.invalidateToolCache();
  runtime.contextProjectionRevision += 1;
}

/** 权限与 Plan 是一个已消费状态；保存失败不发布成功快照，也不提前改内存。 */
export async function applyRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean; contextProfile?: string },
  cause: { source: "command" | "tool"; toolCallId?: string; traceContext?: TraceContext },
): Promise<ExecutionState> {
  if (runtime.permissionFullAccessPending)
    throw new Error("Permission update is busy; retry mode change");
  if (unpublishedPermissionGrants.has(runtime)) await recoverPendingPermissionGrant(runtime);
  const previous = readRuntimeExecutionState(runtime);
  const next = resolveExecutionState(input, previous);
  // 根因：早返回此前只比较 mode/planEnabled，contextProfile 单独变化时被误判为无变化而
  // 幂等短路——既不持久化也不发布事件，下一次请求仍按旧档位构建上下文。修复：三字段全部
  // 相同才算真正无变化；保存失败时错误向上冒泡，安装与事件天然不会执行，内存事实不变。
  if (
    next.mode === previous.mode &&
    next.planEnabled === previous.planEnabled &&
    resolveContextProfile(next) === resolveContextProfile(previous)
  ) {
    return next;
  }
  if (next.planEnabled && !previous.planEnabled) {
    const goal = await runtime.readSessionTargetForContext?.(
      cause.traceContext ?? runtime.rootTraceContext,
    );
    if (goal?.status === "active")
      throw new Error("Plan and Goal cannot be active at the same time.");
  }
  await persistExecutionState(runtime, next);
  installRuntimeExecutionState(runtime, next, previous);
  const trace = cause.traceContext ?? runtime.rootTraceContext;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionModeChanged,
      {
        ...next,
        previousMode: previous.mode,
        previousPlanEnabled: previous.planEnabled,
        previousContextProfile: resolveContextProfile(previous),
        source: cause.source,
        ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      },
      trace,
    ),
    trace,
  );
  return next;
}
