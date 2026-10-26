import { zcodeWorkspaceUpdateForkToolPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * fork 工具开关（Monitor / NotebookEdit / ApplyPatch）是 workspace 级偏好，但真正生效的是
 * 每个 session runtime 的工具注册表。与 model-io 同模式：先更新进程级缓存供新建/冷恢复
 * 继承，再推给每个活跃 session，避免"新会话能看见、老会话看不见"的分裂。
 *
 * 与 off-peak / dynamic-workflow 的策略不同，这里必须动活跃 session——用户的要求是
 * 会话内即时生效，而不是下次冷恢复才生效。
 */
export async function updateForkToolPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateForkToolPreferencesParamsSchema, rawParams);
  const preferences = params.preferences;
  context.appRuntimePreferences.forkToolPreferences = preferences;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    record.app.runtime.updateForkToolSwitches(preferences);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    preferences,
    updatedSessionCount,
  };
}
