// 外部 coding agent 委派端口（core → bootstrap 的唯一通道）。
//
// 分层：core 的 DelegateToExternalAgent 工具只依赖本契约；绑定读取、进程 spawn、
// 输出解析全部住在 bootstrap。这样 core 不依赖 bootstrap（架构检查要求），
// 也让"外部 agent 怎么跑"成为可替换的实现细节。
import type { SessionId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface ExternalAgentDelegateInput {
  sessionId: SessionId;
  /** 交给外部 agent 的完整任务/计划正文。 */
  task: string;
  /** 可选补充材料（验收标准、约束、文件线索）。 */
  context?: string;
  /** 外部 agent 的工作目录（通常是会话 workspace root）。 */
  cwd: string;
  abortSignal?: AbortSignal;
  trace?: TraceContext;
  /** 输出增量回调：bootstrap 用它把外部进程输出转成工具进度事件。 */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void | Promise<void>;
}

export type ExternalAgentDelegateOutcome =
  | {
      kind: "delegated";
      /** 绑定的展示名（如 "workbuddy"）。 */
      label: string;
      text: string;
      exitCode: number;
      isError: boolean;
      durationMs: number;
    }
  /** 当前会话没有绑定外部 agent。 */
  | { kind: "unbound" };

export interface ExternalAgentPort {
  delegate(input: ExternalAgentDelegateInput): Promise<ExternalAgentDelegateOutcome>;
}
