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
  // 完整 fork 开关（含记忆类）：非工具门禁读这里，工具面仍只认 preferences。
  if (params.forkFeatures !== undefined) {
    context.appRuntimePreferences.forkFeatures = params.forkFeatures;
  }

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    // record.forkFeatures 是会话级解析结果（冷恢复/子会话继承都落在它上面）；记忆类
    // 门禁在没有进程级缓存时回退读它，因此这里必须一并刷新，否则会读到冷启动的旧值。
    if (params.forkFeatures !== undefined) {
      record.forkFeatures = params.forkFeatures;
    }
    record.app.runtime.updateForkToolSwitches(preferences);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    preferences,
    updatedSessionCount,
  };
}
