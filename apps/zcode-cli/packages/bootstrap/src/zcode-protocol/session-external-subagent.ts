// 外部子智能体实例的外部会话 id（续接凭据）持久化。
//
// 为什么与会话绑定分开存（这是本模块存在的理由）：
// - `runtime/external_agent` 是「整个会话绑定一个外部 agent」的单条工作线，主控模式用；
// - 本模块按 **agentId**（一个子智能体实例）各存各的。
//
// 混用会让同一会话里多个外部子智能体共用一条 CLI 会话：B 的 `-r` 会接上 A 的上下文，
// 拿到完全无关的历史。这种串台在结果里表现为"它怎么知道我上一个任务"，
// 排查成本很高，所以从一开始就用独立 entry 类型。
//
// 只存会话 id，不存执行配置：preset/model/effort 每次从 profile 现场构造，
// 所以改 profile 会立即影响下一次续跑，而不会留下过期的配置副本。
import { SESSION_ENTRY_EXTERNAL_SUBAGENT_SESSION, type SessionStorePort } from "@zcode/contracts";

const ENTRY_ID_PREFIX = "runtime:external_subagent_session";

/** 一条实例级续接记录的数据形状。 */
interface ExternalSubagentSessionEntryData {
  agentId: string;
  externalSessionId: string;
}

export interface ReadExternalSubagentSessionOptions {
  /** 父会话 id（entry 挂在父会话下，按 agentId 区分）。 */
  sessionId: string;
  agentId: string;
  sessionStore: SessionStorePort | undefined;
}

/**
 * 读取某个外部子智能体实例的上次外部会话 id。
 *
 * 读不到（首次执行、entry 被清理、旧宿主没这个类型）一律当作"没有"，
 * 语义是"这次开新会话"——续接是优化，不是正确性前提。
 */
export async function readExternalSubagentSessionId(
  options: ReadExternalSubagentSessionOptions,
): Promise<string | undefined> {
  const entries = await options.sessionStore
    ?.sessionEntries?.({
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_SUBAGENT_SESSION,
    })
    .catch(() => undefined);
  const latest = entries
    ?.filter(
      (entry) =>
        (entry.data as Partial<ExternalSubagentSessionEntryData>)?.agentId === options.agentId,
    )
    .at(-1);
  const value = (latest?.data as Partial<ExternalSubagentSessionEntryData> | undefined)
    ?.externalSessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface SaveExternalSubagentSessionOptions {
  sessionId: string;
  agentId: string;
  externalSessionId: string;
  sessionStore: SessionStorePort | undefined;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * 写回某个实例的外部会话 id（同一 agentId 原子覆盖）。
 *
 * 写失败只 warn：续接凭据丢了最差是下次开新会话，不能影响本次执行结果。
 */
export async function saveExternalSubagentSessionId(
  options: SaveExternalSubagentSessionOptions,
): Promise<void> {
  const sessionStore = options.sessionStore;
  if (!sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await sessionStore.saveSessionEntry({
      id: `${options.sessionId}:${ENTRY_ID_PREFIX}:${options.agentId}`,
      sessionID: options.sessionId as never,
      type: SESSION_ENTRY_EXTERNAL_SUBAGENT_SESSION,
      data: {
        agentId: options.agentId,
        externalSessionId: options.externalSessionId,
      } satisfies ExternalSubagentSessionEntryData,
      // 配置补写不代表用户新活动（与 model_selection / external_agent 同义）。
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
    });
  } catch (error) {
    options.logger?.warn("external subagent session id persistence failed", {
      agentId: options.agentId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.external_subagent_session.persist_failed",
      module: "bootstrap.zcode_protocol",
      sessionId: options.sessionId,
    });
  }
}
