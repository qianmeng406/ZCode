import {
  resolveContextProfile,
  resolveExecutionState,
  resolveRestoredExecutionState,
  type ExecutionState,
} from "@zcode/shared";
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
  // 读取的是已提交状态（不是用户切换），走恢复语义：只做无损归一
  // （beta+fusion 归一 Beta+standard），build+fusion 等历史组合原样保留，
  // 不把 build+fusion 自动升级成完全访问的 Beta。
  // 用 resolveExecutionState 的切换语义重读会误清遗留融合档位。
  return resolveRestoredExecutionState(runtime.config);
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
  options: { restored?: boolean } = {},
): void {
  // 自包含解析：缺省档位按 next.mode 做旧 minimal 兼容映射。
  // 「改权限/Plan/授权保留档位」由 patch 语义的 resolveExecutionState(input, previous)
  // 在调用方完成；这里不做二次 patch 解析，否则恢复持久化状态会被 invocation 档位污染。
  // 恢复/安装走读取归一入口：beta+fusion 归一 Beta+standard；build+fusion 等历史组合
  // 保留原权限与档位（Beta 是完全访问，不能自动升级）。
  const resolved = resolveRestoredExecutionState(next);
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
  // 恢复不是用户切换：冷恢复先用 mode-only 事件、再用 execution-state entry 两次安装，
  // 中间的 planEnabled=false 只是临时值。若按 activation 变化处理，会把「重新进入」的
  // pending-full 打开——恢复后第一条提醒就变成全文，节流边界与历史计数脱节。
  // 真实切换（命令/工具/config）仍走下面的 activation 判定。
  if (!options.restored) {
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
  }
  // 最小运行态替身（测试 stub）可能未安装方法；真实 runtime 由 methods/index 统一挂载。
  runtime.invalidateToolCache?.();
  // 只有档位（minimal/fusion）改变提示词前缀；Plan／权限切换只影响工具与提醒，
  // 不推进派生版本，否则每次进出 Plan 都会白重建一次 context prefix（prompt cache 失效）。
  if (resolveContextProfile(previous) !== resolved.contextProfile)
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
  // 显式 mode 变更的清融合归一已在 resolveExecutionState 完成（modeChanged 分支）：
  // 命令面 mode 字段从不携带档位意图，真正切换模式时遗留 fusion 统一清掉，防止退出 Beta 后
  // 继续吃融合提示词；同模式重申或仅 planEnabled 变化不触发，历史组合与计划批准保留档位。
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
