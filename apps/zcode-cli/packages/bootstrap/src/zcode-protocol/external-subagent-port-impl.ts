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
   * 同一父会话同时运行的外部子智能体上限。
   *
   * 为什么需要：外部 CLI 各自是独立进程，共享同一个工作区与同一份 CLI 配置/凭据。
   * 不设上限时模型可以一次 fan-out 出十几个进程互相改同一批文件，出问题也没有
   * 可读的因果链。缺省 3：够用且不至于把机器打满。
   */
  maxConcurrentPerSession?: number;
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
  /**
   * 检查当前会话的执行目标是否可安全跑外部 CLI；抛错即拒绝执行。
   *
   * 首版**只支持本地执行**：会话切到 WSL/远程时，会话执行路由端口不转发 run
   * options（进度与取消都丢），driver 的 artifact 重建又是本地 fs 读，跨目标路径
   * 读不到。与其得到"能启动但看不到进度、取消不掉"的半残执行，不如明确拒绝。
   */
  assertLocalExecution?: () => void;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** 缺省并发上限（同一父会话）。 */
const DEFAULT_MAX_CONCURRENT_PER_SESSION = 3;

export function createExternalSubagentPort(
  options: CreateExternalSubagentPortOptions,
): ExternalSubagentPort {
  const driver = createOneShotExternalAgentDriver({ executionPort: options.executionPort });
  const maxConcurrent = Math.max(
    1,
    options.maxConcurrentPerSession ?? DEFAULT_MAX_CONCURRENT_PER_SESSION,
  );
  // 在跑的实例：close 时要等它们收口，也要能拒绝新执行。
  const running = new Set<AbortController>();
  // 父会话 → 当前活动实例数：并发上限按会话算，不按进程全局算。
  const runningBySession = new Map<string, number>();
  // agentId → 该实例 run 的串行队列尾巴。
  //
  // 为什么按实例串行：一个实例的外部会话 id 是单条对话，两个 run 并发会交错写
  // 同一个 CLI 会话（续接时更明显）。终态续跑走同一条队列，天然不重叠。
  const instanceQueues = new Map<string, Promise<unknown>>();
  let closed = false;

  /** 真正的执行体：并发准入 → onSessionReady → driver → 失败冒泡。 */
  const runOnce = async (
    request: ExternalSubagentRunRequest,
    runOptions: ExternalSubagentRunOptions,
  ): Promise<ExternalSubagentRunResult> => {
    const binding = buildBindingFromProfile(request.profile);
    // 首版锁本地执行：远程/WSL 下进度与取消都会在路由层丢失（见 options 注释）。
    options.assertLocalExecution?.();
    const sessionKey = String(request.parentSessionId);
    const active = runningBySession.get(sessionKey) ?? 0;
    if (active >= maxConcurrent) {
      // 明确拒绝而不是排队：模型据此可以决定"先等或减少并发"；排队会让父轮
      // 莫名卡住且看不到原因。
      throw new Error(
        `本会话同时在跑的外部子智能体已达上限（${maxConcurrent} 个）；请等其中一些结束后再启动新的`,
      );
    }
    runningBySession.set(sessionKey, active + 1);
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

    // 正文是否已经通过流式条目产出（用于收口时决定要不要补全文）。
    let streamedText = false;
    // transcript 条目先**缓冲**，等收口知道成败后再落库。
    //
    // 为什么不能边跑边写：driver 在 `is_error` 的 result 上同样会推 text 条目，
    // 而这是失败语义。边写边落会让错误文本作为"回答"进面板，收口时还得回删；
    // 缓冲一次按成败写入，既不用回删，也不可能出现"两份并存"。
    let pendingEntries: Array<{
      kind: "text" | "reasoning" | "tool";
      text: string;
      mode: "append" | "replace";
    }> = [];
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
          // 结构化过程条目先缓冲（见 pendingEntries 的注释）。
          if (!request.onTranscript) return;
          if (chunk.entries?.length) {
            const mode = chunk.replace ? ("replace" as const) : ("append" as const);
            if (mode === "replace") {
              // 权威重建（全量 stdout 重解析）直接替换缓冲：收口只落这一份，
              // 执行期的尾窗差分版本从来不会进库，也就无所谓"旧 part 残留"。
              pendingEntries = chunk.entries.map((entry) => ({
                kind: entry.kind,
                text: entry.text,
                mode,
              }));
            } else {
              for (const entry of chunk.entries) {
                pendingEntries.push({ kind: entry.kind, text: entry.text, mode });
              }
            }
            if (chunk.entries.some((entry) => entry.kind === "text" && entry.text.trim())) {
              streamedText = true;
            }
            return;
          }
          // 没有结构化条目（非流式驱动）才用原始文本兜底；
          // 有 entries 时 raw text 是同一份内容的另一视图，再写一遍会重复。
          if (chunk.text) {
            pendingEntries.push({ kind: "text", text: chunk.text, mode: "append" });
            if (chunk.text.trim()) streamedText = true;
          }
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

      // 失败必须冒泡，不能被压成"已完成"。
      //
      // runner 的 `runAgentToCompletion` 无条件写 `status: "completed"`，它只把
      // **抛错**当作失败。所以外部 CLI 的非零退出、`is_error: true`、以及 driver
      // 停滞看门狗的中止（该分支返回 `isError: true, exitCode: 1`）如果只体现在
      // 返回值里，卡片与终态通知都会显示"已完成"，错误文本还会被当成回答正文
      // ——用户会以为代码真的改好了。这里统一转成异常，让 runner 走 failed 路径。
      //
      // 顺序：先判外层取消（那是 cancelled 语义，不是失败），再判执行失败。
      // **补写正文必须在失败判定之后**：失败时 result.text 是错误文本，先写进
      // transcript 它在下钻面板里看起来就是子智能体的"回答"。
      if (runOptions.signal?.aborted) {
        throw runOptions.signal.reason ?? new Error("外部子智能体已被取消");
      }
      if (result.isError || result.exitCode !== 0) {
        const failure = describeExternalSubagentFailure(result);
        // 失败：执行期缓冲的内容一律不写（它可能是错误文本被解析成的正文），
        // 只写一条 error 条目。面板据此区分"它执行失败了"与"它说了什么"。
        await request.onTranscript?.({ kind: "error", text: failure }).catch(() => undefined);
        throw new Error(failure);
      }

      // 成功：把缓冲的条目按顺序落库（权威重建已在缓冲里替换过）。
      // 没流式到正文时补最终回答：非流式驱动与「模型只回 result」靠这一步。
      if (request.onTranscript) {
        const toWrite =
          streamedText || !result.text.trim()
            ? pendingEntries
            : [
                ...pendingEntries,
                { kind: "text" as const, text: result.text, mode: "append" as const },
              ];
        for (const entry of toWrite) {
          await request
            .onTranscript({ kind: entry.kind, text: entry.text, mode: entry.mode })
            .catch(() => undefined);
        }
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
      const remaining = (runningBySession.get(sessionKey) ?? 1) - 1;
      if (remaining <= 0) runningBySession.delete(sessionKey);
      else runningBySession.set(sessionKey, remaining);
    }
  };

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
      // 同一实例串行：两个 run 并发会交错写同一个 CLI 会话（续接时更明显）。
      // 排队而不是拒绝——同实例的第二次调用通常是终态续跑，等前一次收口即可。
      const previous = instanceQueues.get(request.agentId) ?? Promise.resolve();
      const queued = previous.then(
        () => runOnce(request, runOptions),
        () => runOnce(request, runOptions),
      );
      instanceQueues.set(
        request.agentId,
        queued.catch(() => undefined),
      );
      return queued;
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
 * 把失败的 driver 结果写成给人和模型都能读的一句话。
 *
 * 带上退出码与正文尾部：外部 CLI 的失败往往只有 stderr 里一句英文，用户需要它
 * 才能判断是权限、额度还是命令写错。正文过长时只留尾部（结论通常在最后）。
 */
export function describeExternalSubagentFailure(result: {
  text: string;
  exitCode: number;
  isError: boolean;
}): string {
  const tail = result.text.trim();
  const head = `外部 agent 执行失败（exitCode: ${result.exitCode}）`;
  if (!tail) return head;
  const clipped = tail.length > 800 ? `…${tail.slice(-800)}` : tail;
  return `${head}：${clipped}`;
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
