import { SESSION_ENTRY_EXECUTION_ENVIRONMENT } from "@zcode/contracts";
import {
  normalizeSessionExecutionEnvironment,
  parseSessionExecutionEnvironment,
  sessionExecutionStateSchema,
  zcodeProtocolMethods,
  zcodeSessionExecutionParamsSchema,
  zcodeSessionExecutionResultSchema,
  type SessionExecutionEnvironment,
  type SessionExecutionState,
  type ZCodeSessionExecutionResult,
  type SessionExecutionOperationError,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { ProtocolRequestError } from "./server-types.js";

// ============================================================
// 会话级执行环境（session-linux-execution）CLI server 操作
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
//
// 职责切分（严格 split，避免 Host 误路由）：
// - 控制面（getExecutionEnvironment / setExecutionEnvironment /
//   cancelExecutionEnvironmentPreparation）：CLI session owner 在本进程本地裁决与持久化，
//   不发往 Host。
// - 执行面（prepare/run/poll/cancel/start/readBackground/getBackgroundTask/
//   cancelBackgroundTask/bashBackgroundLifecycle/release）：经 requestClient 转回
//   window Host 的 sessionExecutionExecutor（interaction/sessionExecution 反向请求），
//   CLI 不自建 WSL 进程。

const EXECUTION_ENVIRONMENT_ENTRY_ID_SUFFIX = "runtime:execution_environment";

export interface SessionExecutionEnvironmentSnapshot {
  environment: SessionExecutionEnvironment | undefined;
  state: SessionExecutionState;
}

/** 读取本会话持久化的执行环境配置（缺省 = 未配置，保持本地行为）。 */
export async function readSessionExecutionEnvironment(options: {
  sessionId: string;
  sessionStore: ZCodeProtocolAgentServerContext["deps"]["sessionStore"] | undefined;
}): Promise<SessionExecutionEnvironment | undefined> {
  if (!options.sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await options.sessionStore.sessionEntries({
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXECUTION_ENVIRONMENT,
    });
    const latest = entries.at(-1);
    if (!latest) return undefined;
    return parseSessionExecutionEnvironment(latest.data);
  } catch {
    // 读取失败按未配置处理，保持默认本地行为；不阻塞会话。
    return undefined;
  }
}

async function persistSessionExecutionEnvironment(options: {
  context: ZCodeProtocolAgentServerContext;
  sessionId: string;
  environment: SessionExecutionEnvironment | undefined;
}): Promise<void> {
  const sessionStore = options.context.deps.sessionStore;
  if (!sessionStore?.saveSessionEntry) return;
  const normalized = normalizeSessionExecutionEnvironment(options.environment);
  const timestamp = Date.now();
  try {
    await sessionStore.saveSessionEntry({
      // local/未配置归一为空；同一稳定 entry 原子覆盖。
      ...(normalized ? { data: normalized } : { data: { kind: "local" } }),
      id: `${options.sessionId}:${EXECUTION_ENVIRONMENT_ENTRY_ID_SUFFIX}`,
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXECUTION_ENVIRONMENT,
      // 配置补写不代表用户新活动（与 model_selection 同一语义）。
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
    });
  } catch (error) {
    options.context.logger?.warn("session execution environment persistence failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.execution_environment.persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId: options.sessionId,
    });
  }
}

function idleState(environment: SessionExecutionEnvironment | undefined): SessionExecutionState {
  const parsed = sessionExecutionStateSchema.safeParse({
    status: "idle",
    environment: environment ?? { kind: "local" },
  });
  return parsed.success ? parsed.data : { status: "idle", environment: { kind: "local" } };
}

function rejection(
  code: SessionExecutionOperationError["code"],
  message: string,
): ProtocolRequestError {
  return new ProtocolRequestError(-32090, message, { code });
}

/** 切换 admission：无运行 turn/排队、无阻塞交互、无存活后台执行。 */
export function assertExecutionEnvironmentSwitchIdle(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): void {
  const record = context.sessions.get(sessionId);
  if (!record) return;
  if (record.app.runtime.hasActiveOrQueuedTurnWork()) {
    throw rejection(
      "environment_unavailable",
      "session has an active or queued turn; execution environment switch is rejected",
    );
  }
  if (context.v4Interactions.hasPendingForSession(sessionId)) {
    throw rejection(
      "environment_unavailable",
      "session has a pending blocking interaction; execution environment switch is rejected",
    );
  }
  if (record.app.runtime.hasRunningBackgroundTasks()) {
    throw rejection(
      "environment_unavailable",
      "session has running background executions; execution environment switch is rejected",
    );
  }
}

/**
 * 切换 admission 锁（record 级 in-flight 标记）：
 * prepare 是跨进程异步操作，期间必须拒绝第二个 set 与新 submit，否则
 * 两个准备可能交错提交，破坏「准备成功才原子切换」的验收语义。
 * set 提交/失败（finally）与 cancel 都会释放锁；进程崩溃时随 CLI 进程消失，
 * Host 侧 generation 失效兜底拒绝孤儿 lease。
 */
const inFlightPreparations = new Set<string>();

/**
 * 已请求取消的会话（与 in-flight 锁配对）。取消只删锁不够：prepare 是跨进程长操作，
 * 删锁后那条 set 仍会跑完并提交配置（真实实例实测：取消后 26ms 返回，而被取消的 set
 * 仍在 77s 后提交 wsl 配置 —— 违反 spec「准备取消不提交」）。提交前必须查这个集合。
 */
const cancelledPreparations = new Set<string>();

/** 供 submit 链路（sendPrompt / command admission）查询该会话是否有环境切换在进行。 */
export function isSessionExecutionPreparationInFlight(sessionId: string): boolean {
  return inFlightPreparations.has(sessionId);
}

/** 控制面：读取当前环境状态投影。 */
export async function getSessionExecutionEnvironment(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionExecutionResult> {
  const params = parseControlParams(context, rawParams);
  const environment = await readSessionExecutionEnvironment({
    sessionId: params.sessionId,
    sessionStore: context.deps.sessionStore,
  });
  return {
    ok: true,
    operation: "getExecutionEnvironment",
    state: idleState(environment),
  };
}

/**
 * 控制面：切换 admission 原子流程。
 * 锁定 admission（拒绝新 submit）→ prepare 新 lease → 提交配置 → 释放旧 lease。
 * prepare 失败保留原环境（fail closed），已开始的准备经 release 回收。
 */
export async function setSessionExecutionEnvironment(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionExecutionResult> {
  const params = parseControlParams(context, rawParams);
  const environment = parseSessionExecutionEnvironment(params.environment);
  if (!environment) {
    throw new ProtocolRequestError(-32602, "Invalid execution environment");
  }
  const record = context.sessions.get(params.sessionId);
  if (!record) {
    throw rejection("unknown_execution", "session is not active in this agent");
  }
  assertExecutionEnvironmentSwitchIdle(context, params.sessionId);

  if (inFlightPreparations.has(params.sessionId)) {
    throw rejection(
      "environment_unavailable",
      "an execution environment switch is already in progress for this session",
    );
  }
  inFlightPreparations.add(params.sessionId);
  // 新的切换请求清除上一次的取消标记（同一会话重新提交即为新意图）。
  cancelledPreparations.delete(params.sessionId);
  try {
    return await runSessionExecutionEnvironmentSwitch(context, params, environment, record);
  } finally {
    inFlightPreparations.delete(params.sessionId);
    cancelledPreparations.delete(params.sessionId);
  }
}

async function runSessionExecutionEnvironmentSwitch(
  context: ZCodeProtocolAgentServerContext,
  params: { sessionId: string; environment?: unknown },
  environment: SessionExecutionEnvironment,
  record: NonNullable<ReturnType<ZCodeProtocolAgentServerContext["sessions"]["get"]>>,
): Promise<ZCodeSessionExecutionResult> {
  const current = await readSessionExecutionEnvironment({
    sessionId: params.sessionId,
    sessionStore: context.deps.sessionStore,
  });
  const target = normalizeSessionExecutionEnvironment(environment);
  // 目标与当前一致：直接提交（幂等），不重复准备。
  const sameTarget =
    (current === undefined && target === undefined) ||
    (current && target && JSON.stringify(current) === JSON.stringify(target));

  let preparedLease: { leaseId: string; generation: number } | undefined;
  let preparedCapabilities:
    | { bashBackgroundLifecycle: boolean; embeddedSearchNative: boolean }
    | undefined;
  try {
    if (target && !sameTarget) {
      const prepared = await context.requestClient(
        zcodeProtocolMethods.interactionSessionExecution,
        {
          operation: "prepare",
          sessionId: params.sessionId,
          environment: target,
          workspacePath: record.workspace.workspacePath,
        },
        zcodeSessionExecutionResultSchema,
      );
      if (!prepared.ok || prepared.operation !== "prepare") {
        // 可诊断性：把底层 code/message 带上，避免 UI 只见 generic 文案无法行动。
        const detail = prepared.ok
          ? `unexpected operation ${prepared.operation}`
          : `${prepared.code} ${prepared.message}`;
        throw rejection(
          prepared.ok ? "internal" : prepared.code,
          `execution environment preparation failed: ${detail}`,
        );
      }
      preparedLease = prepared.prepare.lease;
      preparedCapabilities = prepared.prepare.capabilities;
    }
    // 取消后迟到的 prepare 成功：不提交（spec「准备取消不提交」）。取消是跨进程长操作，
    // 只删 in-flight 锁不够——被取消的 set 仍会跑完并提交（真实实例实测 77s 后才提交）。
    // 这里在提交前拦下；catch 会回收刚分配的 lease（manager 已按 lease 身份收窄 release）。
    if (cancelledPreparations.has(params.sessionId)) {
      throw rejection("cancelled", "execution environment preparation was cancelled");
    }
    await persistSessionExecutionEnvironment({
      context,
      sessionId: params.sessionId,
      environment,
    });
    // 提交成功后切换本会话借用端口（spec「装配本会话新 App/端口」）：不重建 App，
    // 只把绑定门面内部的真实端口换成 WSL 路由端口（或换回本地），保留同一 session
    // 历史/模型/权限/配置。绑定缺失（非协议入口注入的会话）时退化为仅持久化配置。
    // 旧 lease 的释放由绑定负责（activateWsl 释放上一借用端口 / activateLocal 释放当前）：
    // 它是按 lease 身份释放，不会误删刚 prepare 出来的新 lease；不能用会话级 releaseSession
    // （那会把新 lease 一起删掉，导致随后执行 lease_rejected）。
    const binding = record.app.sessionExecutionPortBinding;
    if (binding && !sameTarget) {
      if (target && target.kind === "wsl" && preparedLease && preparedCapabilities) {
        binding.activateWsl({
          lease: preparedLease,
          capabilities: preparedCapabilities,
          distro: target.distro,
          user: target.user,
        });
      } else {
        await binding.activateLocal().catch(() => undefined);
      }
      // 提示词层只认当前生效的绑定：切换提交后立即让下一轮请求重建 context prefix，
      // 让环境路由段出现/更新/消失，而不是等下一次冷启动。
      record.app.runtime.notifySessionExecutionEnvironmentChanged();
    }
    return {
      ok: true,
      operation: "setExecutionEnvironment",
      state: idleState(target),
    };
  } catch (error) {
    // 准备失败：不提交，回收已分配的 lease，保留原环境。
    if (preparedLease) {
      void context
        .requestClient(
          zcodeProtocolMethods.interactionSessionExecution,
          {
            operation: "release",
            sessionId: params.sessionId,
            lease: preparedLease,
          },
          zcodeSessionExecutionResultSchema,
        )
        .catch(() => undefined);
    }
    if (error instanceof ProtocolRequestError) throw error;
    throw rejection(
      "environment_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 控制面：取消进行中的准备；不提交新配置。 */
export async function cancelSessionExecutionEnvironmentPreparation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionExecutionResult> {
  const params = parseControlParams(context, rawParams);
  // in-flight 标记在 set 的 finally 中也会删；这里是显式取消路径（例如 UI 取消按钮）。
  // 取消后 runSessionExecutionEnvironmentSwitch 继续跑时其 finally 是幂等的，无泄漏。
  const wasPreparing = inFlightPreparations.delete(params.sessionId);
  // 记录取消意图：被取消的 set 若 prepare 迟到成功，提交前必须看到这个标记并不提交。
  cancelledPreparations.add(params.sessionId);
  const environment = await readSessionExecutionEnvironment({
    sessionId: params.sessionId,
    sessionStore: context.deps.sessionStore,
  });
  // 取消不提交新配置，环境保持原值；已被取消的 set 在其 catch 中回收已分配的 lease。
  if (wasPreparing) {
    context.logger?.info("session execution environment preparation cancelled", {
      event: "session_execution.preparation_cancelled",
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
  }
  // 同步通知 Host 中止在途 prepare（部署/映射阶段真中断，不再只是确认式 no-op）。
  // 结果忽略：state 权威投影仍在本层（配置 owner）；Host 无在途准备时该操作幂等成功。
  void context
    .requestClient(
      zcodeProtocolMethods.interactionSessionExecution,
      {
        operation: "cancelExecutionEnvironmentPreparation" as const,
        sessionId: params.sessionId,
      },
      zcodeSessionExecutionResultSchema,
    )
    .catch(() => undefined);
  return {
    ok: true,
    operation: "cancelExecutionEnvironmentPreparation",
    state: idleState(environment),
  };
}

function parseControlParams(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): { sessionId: string; environment?: unknown } {
  const parsed = zcodeSessionExecutionParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new ProtocolRequestError(-32602, "Invalid interaction/sessionExecution params");
  }
  return parsed.data as { sessionId: string; environment?: unknown };
}

/**
 * interaction/sessionExecution 总入口：控制面本地裁决，执行面转 Host。
 * 严格 split——Host 端 manager 不认识控制面操作，CLI 也不自建 WSL 执行端。
 */
export async function handleSessionExecutionOperation(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSessionExecutionResult> {
  const parsed = zcodeSessionExecutionParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new ProtocolRequestError(-32602, "Invalid interaction/sessionExecution params");
  }
  const params = parsed.data;
  switch (params.operation) {
    case "getExecutionEnvironment":
      return await getSessionExecutionEnvironment(context, rawParams);
    case "setExecutionEnvironment":
      return await setSessionExecutionEnvironment(context, rawParams);
    case "cancelExecutionEnvironmentPreparation":
      return await cancelSessionExecutionEnvironmentPreparation(context, rawParams);
    default:
      // 执行面操作：原样转回 window Host（requestClient → services 反向桥 → executor）。
      return await context.requestClient(
        zcodeProtocolMethods.interactionSessionExecution,
        params,
        zcodeSessionExecutionResultSchema,
      );
  }
}
