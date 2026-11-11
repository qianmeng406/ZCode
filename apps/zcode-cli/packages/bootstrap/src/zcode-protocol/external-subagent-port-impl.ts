// 外部 CLI 作为子智能体的执行后端（bootstrap 侧实现）。
//
// 与「主控模式」的区别（这是本模块存在的理由）：
// - 主控模式：整个会话绑定一个外部 agent（session entry），主会话转只读，
//   工具是 DelegateToExternalAgent / Start / Get / Cancel；
// - 子智能体模式：主 agent 通过 Agent 工具按需创建外部 agent 子智能体，主会话
//   保持正常权限，身份/注册表/通知/后台转换/取消全部复用原生子智能体。
//
// 本实现只回答两个问题：这一次执行怎么跑（preset → binding → driver）、
// 以及取消能不能真的停住进程。生命周期归 core 的 runner 所有。
//
// 三个关键取舍：
// 1. **profile 固化为 binding，但不是会话绑定**：不写 session entry、不碰只读锁。
//    每次 run 从 profile 现场构造一份 binding（preset/model/effort/contextWindow
//    全部来自 profile），所以同一会话里多个外部子智能体各自独立。
// 2. **每次 run 独立的 externalSessionId 存储**：主控模式把 CLI 会话 id 写回会话
//    绑定，那是"一条工作线"的语义。子智能体按实例保存，互不串台。
// 3. **不伪造事件**：外部 CLI 没有 ZCode 原生 model/tool 事件，返回空 events，
//    上层如实显示"暂无统计"，而不是编造 token/工具计数。
import type {
  ExecutionPort,
  ExternalSubagentPort,
  ExternalSubagentRunRequest,
  ExternalSubagentRunOptions,
  ExternalSubagentRunResult,
} from "@zcode/contracts";
import type { AgentProfile, ExternalAgentBinding } from "@zcode/shared";
import { findExternalAgentPreset } from "@zcode/shared";
import { createOneShotExternalAgentDriver } from "./external-agent-driver.js";

export interface CreateExternalSubagentPortOptions {
  executionPort: ExecutionPort;
  /**
   * 实例级外部会话 id（续接凭据）的读写。
   *
   * 与主控模式的 session binding 存储刻意分开：那里的键是 sessionId（一条工作线），
   * 这里的键是 agentId（一个子智能体实例）。缺省不持久化——单次任务没有续接需求，
   * 而"能续接"要等的下一轮在本功能第一期里并不存在（SendMessage 对运行中的外部
   * 进程不可用）。
   */
  readExternalSessionId?: (agentId: string) => Promise<string | undefined>;
  saveExternalSessionId?: (agentId: string, externalSessionId: string) => Promise<void>;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export function createExternalSubagentPort(
  options: CreateExternalSubagentPortOptions,
): ExternalSubagentPort {
  const driver = createOneShotExternalAgentDriver({ executionPort: options.executionPort });
  // 在跑的实例：close 时要等它们收口，也要能拒绝新执行。
  const running = new Set<AbortController>();
  let closed = false;

  return {
    handles(profile: AgentProfile): boolean {
      return profile.backend === "external";
    },

    async run(
      request: ExternalSubagentRunRequest,
      runOptions: ExternalSubagentRunOptions = {},
    ): Promise<ExternalSubagentRunResult> {
      if (closed) {
        throw new Error("外部子智能体端口已关闭，不能再发起执行");
      }
      const binding = buildBindingFromProfile(request.profile);
      // 先声明"子会话已就绪、可以开始执行"：core 的 runner 在这个回调里发布
      // SubagentSpawned，UI 从这一刻起能订阅到下钻会话。顺序必须是
      // 持久化 → onSessionReady → 启动进程，否则用户会看到一个没有内容的卡片。
      await request.onSessionReady?.();

      const controller = new AbortController();
      running.add(controller);
      // 外部取消与 owner 关闭汇流：两条来源都可能在中途叫停，任一到达都要
      // 传到 driver（driver 自己再把用户取消与停滞看门狗汇进同一个信号）。
      const onOuterAbort = () => controller.abort();
      if (runOptions.signal) {
        if (runOptions.signal.aborted) controller.abort();
        else runOptions.signal.addEventListener("abort", onOuterAbort, { once: true });
      }

      const externalSessionId = await options
        .readExternalSessionId?.(request.agentId)
        .catch(() => undefined);
      // 续接靠 binding 上的 externalSessionId（argv 构造读它决定 `-r`）；
      // continuation 只是"愿不愿意续"的开关，两者必须一致。
      const runBinding: ExternalAgentBinding = externalSessionId
        ? { ...binding, externalSessionId }
        : binding;

      try {
        const result = await driver.run({
          binding: runBinding,
          // profile 正文是用户给这个子智能体的常驻指令（就像原生 profile 的
          // systemPrompt）；Agent 工具传来的 prompt 是一次性任务。两者都要给到
          // CLI——它没有 system/user 分离，只能按先后拼接。
          prompt: composePrompt(request.profile.systemPrompt, request.prompt),
          cwd: request.workingDirectory,
          continuation: externalSessionId ? "auto" : "fresh",
          signal: controller.signal,
          onOutput: (chunk) => {
            // 只要还在出东西就刷新活动时间——活动卡的"还在工作"判定靠它。
            request.reportActivity?.();
            // 进度条目透传给活动卡：core 侧目前没有为外部子智能体单独开活动槽，
            // 这里只驱动 watchdog；transcript 投影在 S3 接。
            void chunk;
          },
        });

        if (result.externalSessionId && options.saveExternalSessionId) {
          await options
            .saveExternalSessionId(request.agentId, result.externalSessionId)
            .catch((error: unknown) => {
              options.logger?.warn("external subagent session id persist failed", {
                agentId: request.agentId,
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "external_subagent.session_id.persist_failed",
              });
            });
        }

        return {
          response: result.text,
          // 外部 CLI 不产生原生事件：空数组让上游如实显示"没有统计"。
          events: [],
        };
      } finally {
        if (runOptions.signal) {
          runOptions.signal.removeEventListener("abort", onOuterAbort);
        }
        running.delete(controller);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const controller of running) controller.abort();
      // 不 await 进程退出：driver 的 abort 会走 ExecutionPort 的进程树关停，
      // 真正的收口信号由各 run 自己的 promise 决定（close 只需保证"不再新起"）。
      running.clear();
    },
  };
}

/**
 * profile → 一次性 binding。
 *
 * 不落库、不复用会话 binding：外部子智能体的执行配置就是它 profile 的那一刻，
 * 之后改 profile 也不影响已经跑起来的实例，更不会污染主控模式的会话绑定。
 *
 * model/effort/contextWindow 走 binding 的 `*ByModel` 映射（键是"本次选的模型"），
 * 与绑定弹窗完全同构——这样 argv 构造、档位校验、上下文窗口 flag 全部复用同一段代码。
 */
export function buildBindingFromProfile(profile: AgentProfile): ExternalAgentBinding {
  const preset = findExternalAgentPreset(profile.preset);
  if (!preset) {
    throw new Error(
      `外部子智能体的预设不存在：${profile.preset ?? "(未指定)"}；请在 profile 里修正 preset`,
    );
  }
  // 防御性校验：解析期已经拦过一次，但 profile 也可能来自旧版本缓存/插件模板。
  if (preset.adaptation !== "full") {
    throw new Error(`外部子智能体的预设只做了部分适配，无法执行：${preset.id}`);
  }
  const modelKey = profile.model ?? "";
  return {
    label: preset.label,
    driver: preset.driver,
    command: preset.command,
    // 预设的 args 跟随代码（driver 内部也会优先读预设），这里给空由预设决定。
    args: [],
    promptDelivery: preset.promptDelivery,
    presetId: preset.id,
    ...(preset.permissionMode ? { permissionMode: preset.permissionMode } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effortsByModel: { [modelKey]: profile.effort } } : {}),
    ...(profile.contextWindow
      ? { contextWindowByModel: { [modelKey]: profile.contextWindow } }
      : {}),
  };
}

/**
 * 拼出交给外部 CLI 的正文：profile 正文（常驻指令）+ 本次任务。
 *
 * 外部 CLI 只有一个 prompt 入口，没有 system/user 之分；把 profile 正文放在前面
 * 当"角色设定"，任务放后面，是唯一能同时保留两者的形状。profile 正文为空时
 * 不留下多余的段落分隔。
 */
export function composeExternalSubagentPrompt(systemPrompt: string, prompt: string): string {
  const head = systemPrompt.trim();
  const task = prompt.trim();
  if (!head) return prompt;
  if (!task) return head;
  return `${head}\n\n${task}`;
}

const composePrompt = composeExternalSubagentPrompt;
