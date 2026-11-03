// 外部 coding agent 委派端口（core → bootstrap 的唯一通道）。
//
// 分层：core 的外部 agent 工具只依赖本契约；绑定读取、进程 spawn、输出解析全部住在
// bootstrap。这样 core 不依赖 bootstrap（架构检查要求），也让"外部 agent 怎么跑"
// 成为可替换的实现细节。
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
  /**
   * 是否续接上一次委派的外部会话。
   *
   * - `auto`（默认）：本会话有上一轮的 externalSessionId 就带上它，让两次委派共享
   *   上下文（"接着刚才的改"才有意义）；
   * - `fresh`：强制开新会话（任务与上文无关时用，避免被历史干扰）。
   */
  continuation?: "auto" | "fresh";
}

/** 委派落盘后工作区的改动概况（git 可用时提供）。 */
export interface ExternalAgentChangeSummary {
  files: Array<{ path: string; added: number; deleted: number }>;
  /** 文件过多时只保留前若干个（按改动行数降序）。 */
  truncated: boolean;
  /** 工作区不是 git 仓库 / git 不可用：没有可汇报的摘要。 */
  unavailable?: boolean;
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
      /** 本轮外部会话 id：下一轮续接用（CLI 没给就缺席）。 */
      externalSessionId?: string;
      /** 本轮是否续接了上一轮（续接失败自动开新会话时为 false）。 */
      continued: boolean;
      /** 工作区改动摘要；git 不可用时缺席或 unavailable。 */
      changes?: ExternalAgentChangeSummary;
    }
  /** 当前会话没有绑定外部 agent。 */
  | { kind: "unbound" };

/** 后台委派任务的状态（长任务不阻塞主对话 turn）。 */
export type ExternalAgentTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface ExternalAgentTaskSnapshot {
  taskId: string;
  sessionId: string;
  status: ExternalAgentTaskStatus;
  /** 已运行时长（running 时是当前值，结束后是总时长）。 */
  durationMs: number;
  /** 结束后的结果（running 时为 undefined）。 */
  outcome?: ExternalAgentDelegateOutcome;
}

export interface ExternalAgentPort {
  delegate(input: ExternalAgentDelegateInput): Promise<ExternalAgentDelegateOutcome>;
  /**
   * 后台启动一次委派，立即返回 taskId。
   *
   * 与 delegate 共享同一执行路径，只是不 await 完成；输出仍通过 onOutput 实时回传。
   */
  start?(input: ExternalAgentDelegateInput): Promise<{ taskId: string }>;
  /** 查询后台任务；未知 taskId 返回 undefined。 */
  poll?(taskId: string): Promise<ExternalAgentTaskSnapshot | undefined>;
  /** 取消后台任务；未知/已完成返回 undefined。 */
  cancel?(taskId: string): Promise<ExternalAgentTaskSnapshot | undefined>;
  /** 列出本会话的后台任务（含最近的已完成项，供模型确认状态）。 */
  list?(sessionId: string): Promise<ExternalAgentTaskSnapshot[]>;
}
