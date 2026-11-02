// 外部 coding agent 绑定的命令组：bindExternalAgent / unbindExternalAgent。
//
// 不变量（贯穿本文件）：
// 1. **绑定即只读**：绑定成功后本会话强制进入 plan（只读）状态。原先的 plan/mode
//    记进 binding.previous*，解绑时恢复——用户不该因为试一次绑定就永久丢掉原权限。
// 2. **只读期间不许切走**：switchCollaborationMode 已拒绝（model-config.ts）；
//    这里再拒绝一次"绑定嵌套绑定"，避免 previous* 被第二层覆盖后无法还原。
// 3. **写顺序**：先落 binding entry，再改执行状态。反过来的话，改状态成功而写 entry
//    失败会留下"只读但无绑定"的会话——既不能委派，也切不回去。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ExternalAgentBinding } from "@zcode/shared";
import { createSessionEvent, SessionEventType } from "@zcode/contracts";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { V4InputAdmissionRejectedError } from "../input-admission.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  persistSessionExternalAgent,
  readSessionExternalAgent,
} from "../../../zcode-protocol/session-external-agent.js";

/** 同值绑定的 noop reasonCode。 */
const BINDING_UNCHANGED = "proto.externalAgentUnchanged";

/** 从 record 取会话级 sessionStore；缺失说明宿主没接线，绑定无从落地。 */
function requireSessionStore(record: V4SessionRecordView) {
  const store = (record as { sessionStore?: unknown }).sessionStore;
  if (!store) {
    throw new Error("v4 bindExternalAgent requires a session-scoped storage capability");
  }
  return store as Parameters<typeof readSessionExternalAgent>[0]["sessionStore"];
}

/** 把 host 的可选 logger 收窄成 external-agent 需要的 warn。 */
function warningLogger(host: V4CommandCoreHost) {
  const warn = host.logger?.warn?.bind(host.logger);
  return warn ? { warn } : undefined;
}

async function bindExternalAgent(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["bindExternalAgent"];
  const record = requireRecord(host, envelope.sessionId);
  const sessionStore = requireSessionStore(record);

  const existing = await readSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
  });
  // 绑定嵌套会让 previous* 被第二层覆盖：解绑时只能恢复到"第一层的只读状态"，
  // 用户原本的权限永久丢失。要求先解绑。
  if (existing) {
    if (
      existing.command === payload.command &&
      existing.driver === payload.driver &&
      existing.label === payload.label
    ) {
      throw new V4CommandNoopError(BINDING_UNCHANGED);
    }
    throw new V4InputAdmissionRejectedError(
      "proto.externalAgentAlreadyBound",
      "该会话已绑定外部 agent；请先解绑再绑定新的",
    );
  }

  const binding: ExternalAgentBinding = {
    label: payload.label,
    driver: payload.driver,
    command: payload.command,
    args: payload.args ?? [],
    promptDelivery: payload.promptDelivery ?? "argv-append",
    ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
    ...(payload.presetId ? { presetId: payload.presetId } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.effort ? { effort: payload.effort } : {}),
    ...(payload.env ? { env: payload.env } : {}),
    ...(payload.timeoutMs ? { timeoutMs: payload.timeoutMs } : {}),
    // 快照原状态：解绑时恢复。planEnabled 单独记，因为 plan 模式可以独立于 mode 存在。
    previousPlanEnabled: record.app.runtime.getPlanEnabled(),
    previousMode: record.app.getMode(),
  };

  // 先落 binding：写失败时下面的只读切换不会发生，会话保持原样。
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding,
    logger: warningLogger(host),
  });

  // 绑定即只读。先上锁、再切状态：execution-state 的唯一写入口会拒绝一切
  // "放出只读"的写入，这次进入 plan 本身是放行的（next 仍是只读）。
  record.app.runtime.setExternalAgentReadOnly(true);
  if (!record.app.runtime.getPlanEnabled()) {
    await record.app.runtime.setExecutionState(
      { mode: "plan", planEnabled: true },
      record.traceContext,
    );
  }

  await publishBindingChanged(record, binding);
  return undefined;
}

async function unbindExternalAgent(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const sessionStore = requireSessionStore(record);
  const binding = await readSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
  });
  if (!binding) {
    throw new V4InputAdmissionRejectedError(
      "proto.externalAgentNotBound",
      "该会话没有绑定外部 agent",
    );
  }

  // 先清 binding：之后无论恢复模式是否成功，会话都不会停在"有绑定但没写 entry"的半态。
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding: undefined,
    logger: warningLogger(host),
  });

  // 先解锁再恢复：恢复是"放出只读"的写入，带着锁调用会被唯一写入口拒绝。
  record.app.runtime.setExternalAgentReadOnly(false);

  // 恢复绑定时被覆盖的权限。previousMode 非法（历史脏数据）时只解锁 plan，不改 mode。
  const previousMode = binding.previousMode;
  const previousPlanEnabled = binding.previousPlanEnabled ?? false;
  await record.app.runtime.setExecutionState(
    {
      ...(previousMode && previousMode !== "plan" ? { mode: previousMode } : {}),
      planEnabled: previousPlanEnabled,
    },
    record.traceContext,
  );
  // 原状态若就停在 plan 模式，上面只改 planEnabled 会把 mode 留在 plan；
  // 用户解绑后的预期是能编辑，所以显式回到一个可写模式。
  if (!previousPlanEnabled && record.app.getMode() === "plan") {
    await record.app.runtime.setExecutionState(
      { mode: previousMode ?? "build", planEnabled: false },
      record.traceContext,
    );
  }

  await publishBindingChanged(record, null);
  return undefined;
}

/** 发一条 ExternalAgentBindingChanged：payload 只带 UI 需要的事实。 */
async function publishBindingChanged(
  record: V4SessionRecordView,
  binding: ExternalAgentBinding | null,
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.ExternalAgentBindingChanged,
    record.app.sessionId as never,
    binding
      ? {
          label: binding.label,
          driver: binding.driver,
          command: binding.command,
          promptDelivery: binding.promptDelivery,
          ...(binding.permissionMode ? { permissionMode: binding.permissionMode } : {}),
          ...(binding.presetId ? { presetId: binding.presetId } : {}),
          ...(binding.model ? { model: binding.model } : {}),
          ...(binding.effort ? { effort: binding.effort } : {}),
          readOnly: true as const,
        }
      : null,
    { traceId: record.traceContext.traceId },
  );
  await record.app.runtime.appendEvent(event, record.traceContext);
}

/**
 * 读取绑定 + 明确拒绝未绑定。换模型/换档位共用。
 *
 * 未绑定必须拒绝而不是静默成功：调用方（UI）据此给出"先绑定"的提示，
 * 静默成功会让用户以为设置生效了。
 */
async function requireBoundExternalAgent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
): Promise<{ binding: ExternalAgentBinding; sessionStore: ReturnType<typeof requireSessionStore> }> {
  const sessionStore = requireSessionStore(record);
  const binding = await readSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
  });
  if (!binding) {
    throw new V4InputAdmissionRejectedError(
      "proto.externalAgentNotBound",
      "该会话没有绑定外部 agent",
    );
  }
  return { binding, sessionStore };
}

/**
 * 只更新绑定的一个可选字段（model / effort）。
 *
 * 刻意不复用 bindExternalAgent：绑定会重新快照 previousPlanEnabled/previousMode，
 * 把用户原本的权限再覆盖一层——连改两次设置，解绑就恢复不到原状态了。
 * 这里只改目标字段，entry 原子覆盖，只读契约与授权完全不动。
 */
async function updateBoundField(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  field: "model" | "effort",
  value: string | null,
): Promise<void> {
  const { binding, sessionStore } = await requireBoundExternalAgent(host, record);
  const normalized = value?.trim() || undefined;
  if (binding[field] === normalized) {
    throw new V4CommandNoopError(BINDING_UNCHANGED);
  }
  const next: ExternalAgentBinding = { ...binding };
  if (normalized) next[field] = normalized;
  else delete next[field];
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding: next,
    logger: warningLogger(host),
  });
  // 模型与档位都是徽标文案的一部分，必须走同一条投影链路。
  await publishBindingChanged(record, next);
}

/** 切换已绑定外部 agent 的模型。 */
async function setExternalAgentModel(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentModel"];
  await updateBoundField(host, requireRecord(host, envelope.sessionId), "model", payload.model);
  return undefined;
}

/**
 * 切换已绑定外部 agent 的推理档位。
 *
 * 独立于换模型：两者的合法值域随 CLI 不同（claude 没有 minimal、codebuddy 有），
 * 合成一条命令会让校验落在一个不属于任何一方的地方。
 */
async function setExternalAgentEffort(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentEffort"];
  await updateBoundField(host, requireRecord(host, envelope.sessionId), "effort", payload.effort);
  return undefined;
}

export const externalAgentHandlers = {
  bindExternalAgent,
  unbindExternalAgent,
  setExternalAgentModel,
  setExternalAgentEffort,
};
