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
import type { ExternalAgentBinding, ExternalAgentPreset } from "@zcode/shared";
import {
  findExternalAgentPreset,
  readModelEffort,
  resolveEffortLevels,
  withModelEffort,
} from "@zcode/shared";
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

/**
 * 取会话级 sessionStore（host 注入的 context.deps.sessionStore）。
 *
 * 缺失必须显式拒绝：静默跳过持久化会造出"本次内存里只读、重启后绑定消失"的
 * 半态绑定，用户无从察觉。
 */
function requireSessionStore(host: V4CommandCoreHost) {
  if (!host.sessionStore) {
    throw new Error("fault.command.externalAgentStoreUnavailable");
  }
  return host.sessionStore;
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
  const sessionStore = requireSessionStore(host);

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
    // 档位挂在"这次选的模型"名下：换模型后各记各的，不互相污染。
    ...(payload.effort ? { effortsByModel: { [payload.model ?? ""]: payload.effort } } : {}),
    ...(payload.externalSessionId ? { externalSessionId: payload.externalSessionId } : {}),
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

  await publishBindingChanged(record, binding, await resolveEffortLevelsForBinding(record, binding));
  return undefined;
}

async function unbindExternalAgent(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const sessionStore = requireSessionStore(host);
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

/**
 * 没有 presetId 时的档位兜底（用户手填了命令）。
 *
 * 按驱动族造一个等价形状：手填的 CLI 多半与某一族同构，档位候选沿用该族的已知集合。
 * 这只是"给一点合理默认"，不改变调用形状——真正决定 argv 的仍是 binding.driver。
 */
function fallbackEffortPreset(binding: ExternalAgentBinding): ExternalAgentPreset {
  return {
    id: "custom",
    label: binding.label,
    description: "",
    driver: binding.driver,
    command: binding.command,
    args: binding.args,
    promptDelivery: binding.promptDelivery,
    modelFlag: "none",
    modelSource: "free-text",
    models: [],
    effortDelivery: binding.driver === "codex-exec" ? "config" : "flag",
    // claude-family 的 --effort 合法值集合（实测）；generic-template 为空 = 不提供档位。
    effortLevelsByModel:
      binding.driver === "generic-template" ? {} : { "": ["low", "medium", "high", "xhigh", "max"] },
  };
}

/**
 * 解析"当前模型能选哪些档位"。
 *
 * 优先读本机探测到的模型目录（App 的 probeExternalAgents）——那是 CLI 自带的
 * 逐模型事实；探测不可用时才退回预设的静态兜底表。每条绑定事件的档位候选都走这里，
 * 保证 UI 看到的候选与实际能用的集合一致。
 */
export async function resolveEffortLevelsForBinding(
  record: V4SessionRecordView,
  binding: ExternalAgentBinding,
): Promise<string[]> {
  const preset = findExternalAgentPreset(binding.presetId) ?? fallbackEffortPreset(binding);
  try {
    const probe = await record.app.probeExternalAgents?.();
    const status = probe?.agents.find((entry) => entry.preset.id === preset.id);
    return resolveEffortLevels(preset, binding.model, status?.modelCatalog);
  } catch {
    // 探测失败退回静态表：宁可给一组"可能不够精确"的候选，也不让档位入口消失。
    return resolveEffortLevels(preset, binding.model);
  }
}

/** 发一条 ExternalAgentBindingChanged：payload 只带 UI 需要的事实。 */
export async function publishBindingChanged(
  record: V4SessionRecordView,
  binding: ExternalAgentBinding | null,
  effortLevels: string[] = [],
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
          // 档位按"当前模型"解析后一起下发：UI 不该自己拿全局表猜候选。
          ...(readModelEffort(binding, binding.model)
            ? { effort: readModelEffort(binding, binding.model) }
            : {}),
          effortLevels,
          // 续接会话跟着绑定走：UI 的会话子菜单据此回显当前项。
          ...(binding.externalSessionId ? { externalSessionId: binding.externalSessionId } : {}),
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
  const sessionStore = requireSessionStore(host);
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
 * 只更新绑定的模型字段。
 *
 * 刻意不复用 bindExternalAgent：绑定会重新快照 previousPlanEnabled/previousMode，
 * 把用户原本的权限再覆盖一层——连改两次设置，解绑就恢复不到原状态了。
 * 这里只改 model，entry 原子覆盖，只读契约与授权完全不动。
 *
 * 换模型**不动**档位：档位按模型分开记（effortsByModel），切到哪个模型就自动
 * 用那个模型自己记着的值——这正是"档位属于模型"的直接体现。
 */
async function setExternalAgentModel(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentModel"];
  const record = requireRecord(host, envelope.sessionId);
  const { binding, sessionStore } = await requireBoundExternalAgent(host, record);
  const model = payload.model?.trim() || undefined;
  if (binding.model === model) {
    throw new V4CommandNoopError(BINDING_UNCHANGED);
  }
  const next: ExternalAgentBinding = { ...binding };
  if (model) next.model = model;
  else delete next.model;
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding: next,
    logger: warningLogger(host),
  });
  await publishBindingChanged(record, next, await resolveEffortLevelsForBinding(record, next));
  return undefined;
}

/**
 * 切换**当前模型**的推理档位。
 *
 * 写入的是 effortsByModel[当前模型]，不是绑定上的全局值：
 * 同一个 CLI 的不同模型支持不同档位，A 模型记 high 不该让 B 模型也变成 high。
 */
async function setExternalAgentEffort(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentEffort"];
  const record = requireRecord(host, envelope.sessionId);
  const { binding, sessionStore } = await requireBoundExternalAgent(host, record);
  const next = withModelEffort(binding, binding.model, payload.effort);
  // 同值判定放在 withModelEffort 之后再比：它已经把 null/空串归一成"删除该键"。
  if (JSON.stringify(next.effortsByModel ?? {}) === JSON.stringify(binding.effortsByModel ?? {})) {
    throw new V4CommandNoopError(BINDING_UNCHANGED);
  }
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding: next,
    logger: warningLogger(host),
  });
  await publishBindingChanged(record, next, await resolveEffortLevelsForBinding(record, next));
  return undefined;
}

/**
 * 切换续接的外部会话。
 *
 * 与换模型/换档位同构：只改 externalSessionId 字段（null = 清除，回到每次
 * 委派开新会话），不动只读契约、授权与 previous* 快照。委派时该 id 会以
 * `-r <id>` 传给 CLI（见 buildExternalAgentInvocation）；CLI 起不到旧会话时
 * 自动开新会话，不阻塞任务。
 */
async function setExternalAgentSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setExternalAgentSession"];
  const record = requireRecord(host, envelope.sessionId);
  const { binding, sessionStore } = await requireBoundExternalAgent(host, record);
  const sessionId = payload.sessionId?.trim() || undefined;
  if (binding.externalSessionId === sessionId) {
    throw new V4CommandNoopError(BINDING_UNCHANGED);
  }
  const next: ExternalAgentBinding = { ...binding };
  if (sessionId) next.externalSessionId = sessionId;
  else delete next.externalSessionId;
  await persistSessionExternalAgent({
    sessionId: record.app.sessionId,
    sessionStore,
    binding: next,
    logger: warningLogger(host),
  });
  await publishBindingChanged(record, next, await resolveEffortLevelsForBinding(record, next));
  return undefined;
}

export const externalAgentHandlers = {
  bindExternalAgent,
  unbindExternalAgent,
  setExternalAgentModel,
  setExternalAgentEffort,
  setExternalAgentSession,
};
