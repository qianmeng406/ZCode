import type {
  SessionExecutionEnvironment,
  SessionExecutionState,
  ZCodeSessionExecutionParams,
  ZCodeSessionExecutionResult,
} from "@zcode/shared";

/**
 * 会话级执行环境（session-linux-execution）宿主执行桥。
 *
 * Agent（CLI session owner）经反向 RPC `interaction/sessionExecution` 把 typed channel
 * 操作转给 window Host；desktop host 装配时注入本 executor（复用 Main 注入的
 * sessionExecutionRemoteAssets 部署 WSL 执行端）。缺省 = 该链路不可用，
 * 所有操作 fail closed 返回 backend_unavailable，绝不回落本地执行。
 */
export type SessionExecutionExecutor = (
  params: ZCodeSessionExecutionParams,
  workspace: { workspaceKey: string; workspacePath: string; workspaceIdentity?: string },
  signal?: AbortSignal,
) => Promise<ZCodeSessionExecutionResult>;

export interface ZCodeAgentGetExecutionEnvironmentParams {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
}

export interface ZCodeAgentSetExecutionEnvironmentParams extends ZCodeAgentGetExecutionEnvironmentParams {
  environment: SessionExecutionEnvironment;
}

export interface ZCodeAgentExecutionEnvironmentResult {
  state: SessionExecutionState;
}
