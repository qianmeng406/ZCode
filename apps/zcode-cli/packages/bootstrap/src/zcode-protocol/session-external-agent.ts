// 会话绑定的外部 coding agent（只读主控 + 委派执行）。
//
// 形状照搬 session-execution.ts 的同名子系统：会话级、非模式、非模型的能力绑定，
// 用稳定的 session_entry 做原子覆盖，只在会话空闲时允许切换。
//
// 两条不变量（本模块存在的理由）：
// 1. **绑定即只读**：写入绑定时强制开启 plan（主会话只能读、分析、出计划），
//    并把原 plan 状态记进 binding.previousPlanEnabled，解绑时恢复。
// 2. **绑定期间不许私自解除只读**：切换协作模式时必须拒绝关闭 plan，
//    否则"主控只读"就形同虚设。
import {
  SESSION_ENTRY_EXTERNAL_AGENT,
  SESSION_ENTRY_EXTERNAL_AGENT_RUN,
  type SessionStorePort,
} from "@zcode/contracts";
import {
  externalAgentBindingSchema,
  externalAgentRunSummarySchema,
  type ExternalAgentBinding,
  type ExternalAgentRunSummary,
} from "@zcode/shared";

const EXTERNAL_AGENT_ENTRY_ID_SUFFIX = "runtime:external_agent";
const EXTERNAL_AGENT_RUN_ENTRY_ID_SUFFIX = "runtime:external_agent_run";

export interface SessionExternalAgentStore {
  read(sessionId: string): Promise<ExternalAgentBinding | undefined>;
  write(sessionId: string, binding: ExternalAgentBinding): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/** 读取本会话的外部 agent 绑定（缺省 = 未绑定）。 */
export async function readSessionExternalAgent(options: {
  sessionId: string;
  sessionStore: SessionStorePort | undefined;
}): Promise<ExternalAgentBinding | undefined> {
  if (!options.sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await options.sessionStore.sessionEntries({
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_AGENT,
    });
    const latest = entries.at(-1);
    if (!latest) return undefined;
    const parsed = externalAgentBindingSchema.safeParse(latest.data);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // 读取失败按未绑定处理：不影响会话本身，只是失去委派能力。
    return undefined;
  }
}

/** 原子覆盖本会话的绑定；`undefined` 表示清除（写一个空标记而非删行）。 */
export async function persistSessionExternalAgent(options: {
  sessionId: string;
  sessionStore: SessionStorePort | undefined;
  binding: ExternalAgentBinding | undefined;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}): Promise<void> {
  const sessionStore = options.sessionStore;
  if (!sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await sessionStore.saveSessionEntry({
      // 清除时写空对象：读取端把解析失败/空对象都视为未绑定，
      // 保持"同一稳定 entry 原子覆盖"的语义，不引入删除路径。
      data: options.binding ?? {},
      id: `${options.sessionId}:${EXTERNAL_AGENT_ENTRY_ID_SUFFIX}`,
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_AGENT,
      // 配置补写不代表用户新活动（与 model_selection / execution_environment 同义）。
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
    });
  } catch (error) {
    options.logger?.warn("session external agent persistence failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.external_agent.persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId: options.sessionId,
    });
  }
}

/** 读取上一次执行的摘要（缺省 = 没跑过/已被解绑清掉）。 */
export async function readSessionExternalAgentRun(options: {
  sessionId: string;
  sessionStore: SessionStorePort | undefined;
}): Promise<ExternalAgentRunSummary | undefined> {
  if (!options.sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await options.sessionStore.sessionEntries({
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_AGENT_RUN,
    });
    const latest = entries.at(-1);
    if (!latest) return undefined;
    const parsed = externalAgentRunSummarySchema.safeParse(latest.data);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // 读不到就当作没有摘要：只是面板少一段历史，不影响执行。
    return undefined;
  }
}

/**
 * 覆盖上一次执行的摘要；`undefined` 表示清除（解绑、换绑时避免串台）。
 *
 * 写失败不影响执行结果：摘要只是"重启后还能回忆起上次跑了什么"的锦上添花。
 */
export async function persistSessionExternalAgentRun(options: {
  sessionId: string;
  sessionStore: SessionStorePort | undefined;
  summary: ExternalAgentRunSummary | undefined;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}): Promise<void> {
  const sessionStore = options.sessionStore;
  if (!sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await sessionStore.saveSessionEntry({
      data: options.summary ?? {},
      id: `${options.sessionId}:${EXTERNAL_AGENT_RUN_ENTRY_ID_SUFFIX}`,
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_AGENT_RUN,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
    });
  } catch (error) {
    options.logger?.warn("session external agent run persistence failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.external_agent_run.persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId: options.sessionId,
    });
  }
}
