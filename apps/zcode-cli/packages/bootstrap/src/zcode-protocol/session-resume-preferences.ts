import { zcodeWorkspaceUpdateSessionResumePreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 冷恢复提速是 App 全局偏好：v4 冷订阅在发起时读取当前值决定首帧前的工作范围，
 * 因此协议层只需缓存最新值（新订阅立即生效，进行中的订阅保持发起时的快照）。
 */
export async function updateSessionResumePreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateSessionResumePreferencesParamsSchema, rawParams);
  const enabled = params.preferences.fastResumeEnabled;
  context.appRuntimePreferences.fastSessionResumeEnabled = enabled;

  return {
    workspace: params.workspace,
    fastResumeEnabled: enabled,
  };
}
