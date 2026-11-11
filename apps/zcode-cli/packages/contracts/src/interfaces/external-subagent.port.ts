// ============================================================
// External Subagent Port - 外部 CLI 作为子智能体执行后端
// ============================================================
//
// 与 ExternalAgentPort（会话绑定的主控模式）是两件事：
// - ExternalAgentPort：整个会话交给一个外部 agent，主会话转只读，工具是
//   DelegateToExternalAgent/Start/Get/Cancel；
// - ExternalSubagentPort：主 agent 通过 Agent 工具按需创建外部 agent 子智能体，
//   主会话保持正常权限，生命周期/身份/通知全部复用原生子智能体。
//
// 为什么是这个形状：核心 runner 的 `runExploreAgent` 是唯一的执行回调，签名是
// `(request, options) => { response, events }`。外部后端只要满足这个返回形状，
// 就能直接接入 native 身份（agentId/childSessionId）、任务注册表、终态通知队列、
// 前台转后台、取消与 owner 清理——一行生命周期代码都不用重写。
//
// 反过来，如果外部后端自己造一套任务体系，TaskOutput/TaskStop/通知/UI 卡片全都
// 要再实现一遍，还会和原生子智能体在活动面板与侧栏里长得不一样。
//
// **事件必须真实**：返回的 `events` 用于派生 usage/tool 计数。外部 CLI 没有
// 原生 model 事件，就不要伪造——返回空数组（或只带真实可得的摘要），让上层
// 如实显示"暂无统计"，而不是给出编造的数字。

import type { AgentProfile } from "@zcode/shared";
import type { SessionEvent } from "../events/index.js";
import type { SessionId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/** 一次外部子智能体执行请求。 */
export interface ExternalSubagentRunRequest {
  /** 实例 id（原生格式 `agent_<uuid>`）；也是 taskId。 */
  agentId: string;
  /**
   * 父会话 id。
   *
   * 并发配额按**父会话**算，不按进程全局算：一个会话 fan-out 十几个外部进程
   * 互相改同一批文件是这里最需要防的场景，而别的会话不该被它连坐。
   */
  parentSessionId: SessionId;
  /** 子会话 id（`subagent_<agentId>`）：下钻与观察都靠它。 */
  childSessionId: SessionId;
  /** profile 名字（= Agent 工具的 subagent_type）。 */
  agentType: string;
  description: string;
  /** 交给外部 CLI 的任务正文（profile 正文前言 + 调用方 prompt 已合成）。 */
  prompt: string;
  /** backend=external 的 profile：preset/model/effort/contextWindow 从这里读。 */
  profile: AgentProfile;
  workingDirectory: string;
  workspaceRoot: string;
  traceContext: TraceContext;
  /**
   * 子会话已可被读取时调用（投影/查询就绪），首次执行前。
   *
   * 与原生 runner 的 `onSessionReady` 同义：调用之前 UI 订阅不到这个子会话，
   * 所以实现必须**先持久化、再回调**，最后才启动进程。
   */
  onSessionReady?: () => Promise<void>;
  /** 执行进度：实现可以按需上报（活动卡、工具进度都由它转出）。 */
  reportActivity?: () => void;
  /**
   * 运行中收到的新消息（原生是 steerTurn）。
   *
   * 外部 CLI 的 headless 模式没有可注入的输入通道，所以本端口不声明支持；
   * 存在这个字段只是为了将来接入支持 stdin 注入的实现，当前实现不注册。
   */
  registerMessageSink?: (sink: unknown) => void;
}

/** 一次外部子智能体执行结果。 */
export interface ExternalSubagentRunResult {
  /** 外部 CLI 的最终回答正文。 */
  response: string;
  /**
   * 派生统计用的事件。
   *
   * 外部 CLI 不产生 ZCode 的原生事件流：正常实现返回空数组，让上游如实显示
   * "没有统计"。**不要**为了凑出非零 token/工具计数而伪造 model 事件。
   */
  events: SessionEvent[];
}

export interface ExternalSubagentRunOptions {
  signal?: AbortSignal;
}

/**
 * 外部子智能体的执行后端。
 *
 * 只负责"跑一次并给出正文"和"取消能真的停住进程"，其余生命周期由原生 runner 管。
 */
export interface ExternalSubagentPort {
  /**
   * 该 profile 是否由本端口执行。
   *
   * 路由判定放在端口内部（而不是 core 里判断 `backend === "external"`），
   * 这样将来"哪些外部预设可用"的策略变化不需要动 core。
   */
  handles(profile: AgentProfile): boolean;
  /** 执行一次；抛错表示失败（文本错误会透传到子智能体结果与通知）。 */
  run(
    request: ExternalSubagentRunRequest,
    options?: ExternalSubagentRunOptions,
  ): Promise<ExternalSubagentRunResult>;
  /** 关闭准入并等待在跑的进程收口（owner 关闭路径）。 */
  close?(): Promise<void>;
}
