// ExternalAgentPort 的 bootstrap 实现：绑定读取 → 选 driver → 执行 → 回结果。
//
// 这是「会话绑定外部 agent」的运行时落点。core 的 DelegateToExternalAgent 工具
// 只认 ExternalAgentPort 契约，不关心进程怎么起、输出怎么解析。
import type {
  ExecutionPort,
  ExternalAgentDelegateInput,
  ExternalAgentDelegateOutcome,
  ExternalAgentPort,
} from "@zcode/contracts";
import type { ExternalAgentBinding } from "@zcode/shared";
import { readSessionExternalAgent } from "./session-external-agent.js";
import { createOneShotExternalAgentDriver } from "./external-agent-driver.js";

export interface CreateExternalAgentPortOptions {
  executionPort: ExecutionPort;
  /** 读会话绑定；缺省用 sessionStore 的持久化读取。 */
  readBinding: (sessionId: string) => Promise<ExternalAgentBinding | undefined>;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** 把 task + context 组装成给外部 agent 的完整提示词。 */
export function composeDelegationPrompt(input: { task: string; context?: string }): string {
  if (!input.context?.trim()) return input.task;
  return `${input.task}

## 补充材料
${input.context}`;
}

export function createExternalAgentPort(
  options: CreateExternalAgentPortOptions,
): ExternalAgentPort {
  const driver = createOneShotExternalAgentDriver({
    executionPort: options.executionPort,
  });

  return {
    async delegate(input: ExternalAgentDelegateInput): Promise<ExternalAgentDelegateOutcome> {
      const binding = await options.readBinding(String(input.sessionId)).catch(() => undefined);
      if (!binding) return { kind: "unbound" };

      const result = await driver.run({
        binding,
        prompt: composeDelegationPrompt({
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
        }),
        cwd: input.cwd,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
        ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      });

      return {
        kind: "delegated",
        label: binding.label,
        text: result.text,
        exitCode: result.exitCode,
        isError: result.isError,
        durationMs: result.durationMs,
      };
    },
  };
}

/** 便捷构造：直接绑到 sessionStore 的持久化读取。 */
export function createSessionExternalAgentPort(options: {
  executionPort: ExecutionPort;
  sessionStore: Parameters<typeof readSessionExternalAgent>[0]["sessionStore"];
  logger?: CreateExternalAgentPortOptions["logger"];
}): ExternalAgentPort {
  return createExternalAgentPort({
    executionPort: options.executionPort,
    readBinding: (sessionId) =>
      readSessionExternalAgent({
        sessionId,
        sessionStore: options.sessionStore,
      }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
