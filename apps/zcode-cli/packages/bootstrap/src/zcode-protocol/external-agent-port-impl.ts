// 外部 coding agent 委派端口：绑定读取 → 选 driver → 执行 → 回结果。
//
// 这是「会话绑定外部 agent」的运行时落点。core 的外部 agent 工具只认 ExternalAgentPort
// 契约，不关心进程怎么起、输出怎么解析、会话怎么续接。
//
// 四件事集中在这里，因为它们都需要「绑定 + 进程 + 会话」三件事实同时在场：
// 1. delegate：一次性执行；
// 2. 续接：把 CLI 自报的 externalSessionId 写回绑定，下次 `-r <id>` 共享上下文；
// 3. 变更摘要：执行后用 git 汇总改了哪些文件（主 agent 据此决定要不要复审 diff）；
// 4. 后台任务：start/poll/cancel，长任务不阻塞主对话 turn。
import { randomUUID } from "node:crypto";
import type {
  ExecutionPort,
  ExternalAgentChangeSummary,
  ExternalAgentDelegateInput,
  ExternalAgentDelegateOutcome,
  ExternalAgentPort,
  ExternalAgentTaskSnapshot,
} from "@zcode/contracts";
import type { ExternalAgentBinding } from "@zcode/shared";
import { readSessionExternalAgent } from "./session-external-agent.js";
import { createOneShotExternalAgentDriver } from "./external-agent-driver.js";
import { summarizeWorkspaceChanges } from "./external-agent-changes.js";

export interface CreateExternalAgentPortOptions {
  executionPort: ExecutionPort;
  /** 读会话绑定；缺省用 sessionStore 的持久化读取。 */
  readBinding: (sessionId: string) => Promise<ExternalAgentBinding | undefined>;
  /** 写回绑定（续接 id 落库）；缺席则不持久化，续接退化为每次新会话。 */
  updateBinding?: (sessionId: string, binding: ExternalAgentBinding) => Promise<void>;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** 把 task + context 组装成给外部 agent 的完整提示词。 */
export function composeDelegationPrompt(input: { task: string; context?: string }): string {
  if (!input.context?.trim()) return input.task;
  return `${input.task}

## 补充材料
${input.context}`;
}

/** 后台任务在内存里的记录。只保留最近若干个，避免长会话无限增长。 */
interface RunningTask {
  taskId: string;
  sessionId: string;
  startedAt: number;
  controller: AbortController;
  promise: Promise<ExternalAgentDelegateOutcome>;
  settledAt?: number;
  outcome?: ExternalAgentDelegateOutcome;
  cancelled: boolean;
}

const MAX_RETAINED_TASKS = 20;

export function createExternalAgentPort(
  options: CreateExternalAgentPortOptions,
): ExternalAgentPort {
  const driver = createOneShotExternalAgentDriver({
    executionPort: options.executionPort,
  });
  /** taskId → 任务；插入有序，超上限时丢最旧的已完成项。 */
  const tasks = new Map<string, RunningTask>();

  const pruneTasks = () => {
    if (tasks.size <= MAX_RETAINED_TASKS) return;
    for (const [taskId, task] of tasks) {
      if (tasks.size <= MAX_RETAINED_TASKS) break;
      if (task.settledAt !== undefined) tasks.delete(taskId);
    }
  };

  const snapshot = (task: RunningTask): ExternalAgentTaskSnapshot => {
    const status = task.cancelled
      ? "cancelled"
      : task.outcome
        ? task.outcome.kind === "delegated" && !task.outcome.isError
          ? "completed"
          : "failed"
        : "running";
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status,
      durationMs: (task.settledAt ?? Date.now()) - task.startedAt,
      ...(task.outcome ? { outcome: task.outcome } : {}),
    };
  };

  const execute = async (
    input: ExternalAgentDelegateInput,
    signal?: AbortSignal,
  ): Promise<ExternalAgentDelegateOutcome> => {
    const sessionId = String(input.sessionId);
    const binding = await options.readBinding(sessionId).catch(() => undefined);
    if (!binding) return { kind: "unbound" };
    // 活动卡第一帧就要有"谁在跑"：在进程启动前把 label/模型交出去。
    input.onStart?.({
      label: binding.label,
      ...(binding.model ? { model: binding.model } : {}),
    });

    const result = await driver.run({
      binding,
      prompt: composeDelegationPrompt({
        task: input.task,
        ...(input.context ? { context: input.context } : {}),
      }),
      cwd: input.cwd,
      continuation: input.continuation ?? "auto",
      ...(signal ?? input.abortSignal ? { signal: signal ?? input.abortSignal! } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
    });

    // 续接凭据落库：下一轮 `-r <id>` 靠它。写失败不影响本次结果（只是下次开新会话）。
    if (result.externalSessionId && options.updateBinding) {
      if (result.externalSessionId !== binding.externalSessionId) {
        await options
          .updateBinding(sessionId, {
            ...binding,
            externalSessionId: result.externalSessionId,
          })
          .catch((error: unknown) => {
            options.logger?.warn("external agent session id persist failed", {
              errorMessage: error instanceof Error ? error.message : String(error),
              event: "external_agent.session_id.persist_failed",
              sessionId,
            });
          });
      }
    }

    // 变更摘要只是给主 agent 的线索：拿不到（非 git、无改动）就缺席，不影响委派结果。
    const changes: ExternalAgentChangeSummary | undefined = await summarizeWorkspaceChanges({
      executionPort: options.executionPort,
      cwd: input.cwd,
    }).catch(() => undefined);

    const outcome: ExternalAgentDelegateOutcome = {
      kind: "delegated",
      label: binding.label,
      text: result.text,
      exitCode: result.exitCode,
      isError: result.isError,
      durationMs: result.durationMs,
      ...(result.externalSessionId ? { externalSessionId: result.externalSessionId } : {}),
      continued: result.continued,
      ...(changes ? { changes } : {}),
    };
    // 收口回调给活动卡落终态（同步委派与后台任务共用这条路径）。
    input.onSettled?.(outcome);
    return outcome;
  };

  return {
    async delegate(input) {
      return await execute(input);
    },

    async start(input) {
      const taskId = `ext_${randomUUID()}`;
      const controller = new AbortController();
      const task: RunningTask = {
        taskId,
        sessionId: String(input.sessionId),
        startedAt: Date.now(),
        controller,
        cancelled: false,
        promise: Promise.resolve({ kind: "unbound" } as ExternalAgentDelegateOutcome),
      };
      task.promise = execute(input, controller.signal).then(
        (outcome) => {
          task.outcome = outcome;
          task.settledAt = Date.now();
          pruneTasks();
          return outcome;
        },
        (error: unknown) => {
          task.outcome = {
            kind: "delegated",
            label: "external-agent",
            text: `外部 agent 执行异常：${error instanceof Error ? error.message : String(error)}`,
            exitCode: 1,
            isError: true,
            durationMs: Date.now() - task.startedAt,
            continued: false,
          };
          // 失败/取消同样要落终态：活动卡不能永远停在 running。
          input.onSettled?.(task.outcome);
          task.settledAt = Date.now();
          pruneTasks();
          return task.outcome;
        },
      );
      tasks.set(taskId, task);
      return { taskId };
    },

    async poll(taskId) {
      const task = tasks.get(taskId);
      return task ? snapshot(task) : undefined;
    },

    async cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task || task.settledAt !== undefined) return undefined;
      task.cancelled = true;
      task.controller.abort();
      // 等它真正收口：取消后立刻 poll 应该看到 cancelled 而不是 running。
      await task.promise.catch(() => undefined);
      return snapshot(task);
    },

    async list(sessionId) {
      return [...tasks.values()]
        .filter((task) => task.sessionId === sessionId)
        .map((task) => snapshot(task));
    },
  };
}

/** 便捷构造：直接绑到 sessionStore 的持久化读写。 */
export function createSessionExternalAgentPort(options: {
  executionPort: ExecutionPort;
  sessionStore: Parameters<typeof readSessionExternalAgent>[0]["sessionStore"];
  /** 写回绑定（续接 id）。 */
  updateBinding: (sessionId: string, binding: ExternalAgentBinding) => Promise<void>;
  logger?: CreateExternalAgentPortOptions["logger"];
}): ExternalAgentPort {
  return createExternalAgentPort({
    executionPort: options.executionPort,
    readBinding: (sessionId) =>
      readSessionExternalAgent({
        sessionId,
        sessionStore: options.sessionStore,
      }),
    updateBinding: options.updateBinding,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
