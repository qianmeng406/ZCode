import type { SessionExecutionEnvironment, SessionExecutionLease } from "@zcode/shared";
import {
  normalizeSessionExecutionEnvironment,
  parseSessionExecutionEnvironment,
  zcodeProtocolMethods,
  zcodeSessionExecutionResultSchema,
} from "@zcode/shared";
import type { SessionExecutionPortBinding } from "../app/session-execution-port-binding.js";
import { createSessionExecutionPortBinding } from "../app/session-execution-port-binding.js";
import type { ZCodeAppOptions } from "../app/types.js";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";

// ============================================================
// 会话执行端口注入（session-linux-execution）
// ============================================================
// spec: docs/research/session-linux-execution.spec.md
//
// 每次会话创建/恢复时读取该会话持久化的执行环境配置；为协议会话构造一个「可切换
// 端口绑定」（session-execution-port-binding.ts），App 用它作为本会话的 ExecutionPort /
// FileSystemPort：
//   - WSL 配置：创建期即 prepare 借用 lease 并激活（恢复路径 fail-closed——WSL 未就绪
//     时抛错阻止执行，绝不回落本地）；
//   - 未配置/local：门面转发到 App 解析出的本地端口（行为不变）。
//
// 绑定同时暴露给 CLI session owner（避免重建 App）：会话内切换环境时只切换绑定内部的
// 真实端口（本地↔WSL），保留同一 session 历史/模型/权限/配置。
//
// FileSystemPort 必须随环境一起换：模型在 Linux 会话里产出的 /home/... POSIX 路径若仍走
// 控制端本地 node fs，会被 resolve 成 Windows 盘的 C:\home\...，与 WSL bash 执行的同一
// 路径不是同一文件——WSL UNC 适配器把 POSIX 绝对路径落到真实 ext4 文件。

export interface InjectedSessionExecutionPorts {
  binding: SessionExecutionPortBinding;
}

interface ServerRequestClientRef {
  requestClient: ZCodeProtocolAgentServerContext["requestClient"];
}

/** 为协议会话构造执行端口绑定；WSL 配置时创建期即 prepare 借用 lease（失败 fail-closed）。 */
export async function injectSessionExecutionPort(
  appOptions: Omit<ZCodeAppOptions, "providerRegistry">,
  server: ServerRequestClientRef | undefined,
): Promise<InjectedSessionExecutionPorts | undefined> {
  const sessionId = appOptions.sessionId;
  if (!sessionId || !server || !appOptions.sessionStore) return undefined;

  const send = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await server.requestClient(
      zcodeProtocolMethods.interactionSessionExecution,
      params,
      zcodeSessionExecutionResultSchema,
    );
    if (!result.ok) {
      throw new Error(`session execution operation failed: ${result.code} ${result.message}`);
    }
    return result as unknown as Record<string, unknown>;
  };

  const binding = createSessionExecutionPortBinding({ sessionId, send });

  const environment = await readPersistedEnvironment(appOptions);
  const target = normalizeSessionExecutionEnvironment(
    environment as SessionExecutionEnvironment | undefined,
  );
  if (!target || target.kind !== "wsl") {
    // 未配置/local：绑定门面转发到 App 本地端口（行为不变），会话内可再切到 WSL。
    return { binding };
  }

  const workspacePath =
    appOptions.runtimeConfig?.workingDirectory ??
    (appOptions as { workspacePath?: string }).workspacePath;
  let prepareError: unknown;
  const prepared = await server
    .requestClient(
      zcodeProtocolMethods.interactionSessionExecution,
      {
        operation: "prepare",
        sessionId,
        environment: target,
        ...(workspacePath ? { workspacePath } : {}),
      },
      zcodeSessionExecutionResultSchema,
    )
    .catch((error: unknown) => {
      prepareError = error;
      return undefined;
    });

  if (!prepared || !prepared.ok || prepared.operation !== "prepare" || !prepared.prepare) {
    // 恢复/创建时 WSL 未就绪：明确 fail closed，不回落本地执行（spec「恢复不降级」）。
    // 必须带出底层原因：否则用户只看到一句泛化文案，真正原因（如随包服务端包不含
    // session-linux-execution 通道时的 Unknown channel/environment_unavailable）只在宿主日志里。
    throw new Error(
      `session execution environment preparation failed${formatSessionExecutionPrepareFailureDetail(prepareError, prepared)}; execution is blocked until the environment is ready`,
    );
  }
  const lease: SessionExecutionLease = prepared.prepare.lease;
  binding.activateWsl({
    lease,
    capabilities: prepared.prepare.capabilities,
    distro: target.distro,
    user: target.user,
  });
  return { binding };
}

async function readPersistedEnvironment(
  appOptions: Omit<ZCodeAppOptions, "providerRegistry">,
): Promise<unknown> {
  const sessionStore = appOptions.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: appOptions.sessionId!,
      type: "runtime/execution_environment",
    });
    const latest = entries.at(-1);
    return latest ? parseSessionExecutionEnvironment(latest.data) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * fail-closed 文案的底层原因：宿主返回的错误封套（code/message）优先，
 * 其次是抛出的异常消息。取不到原因时返回空串（保持原文案不变）。
 *
 * 现场缺陷：随包服务端包不含 session-linux-execution 通道时，恢复会话只显示
 * 「preparation failed; execution is blocked…」，真正原因（Unknown channel /
 * environment_unavailable … timed out）只在宿主日志里，用户无从判断。
 */
export function formatSessionExecutionPrepareFailureDetail(
  error: unknown,
  prepared: { ok?: boolean; code?: string; message?: string } | undefined,
): string {
  const parts: string[] = [];
  if (prepared && prepared.ok !== true) {
    const envelope = [prepared.code, prepared.message].filter(Boolean).join(": ");
    if (envelope) parts.push(envelope);
  }
  if (error instanceof Error && error.message) {
    parts.push(error.message);
  } else if (typeof error === "string" && error) {
    parts.push(error);
  }
  return parts.length > 0 ? ` (${parts.join(" | ")})` : "";
}
