// 外部子智能体的子会话 transcript 写入。
//
// 为什么住在 core 而不是 bootstrap：一条消息落库需要会话身份、模型选择、
// semantics/anchor、消息与 part 的 id 生成——这些是 core 的会话存储语义。
// 适配层只回答"CLI 说了什么"，不该重建一套消息写入规则。
//
// 写入形状的选择：外部 CLI 的一次执行就是"一条 user 消息（任务）+ 一条 assistant
// 消息（正文/思考/工具 part）"。这正好对应下钻面板的渲染预期（先看到发起了什么，
// 再看到它做了什么），也让 `readSubagentTranscript` 不需要为外部实例写特例。
//
// **不伪造统计**：assistant 消息的 tokens/cost 一律为 0，因为没有真实数字。
// 面板据此显示"暂无统计"，而不是给出编造的用量。
import type { MessageId, MessagePart, SessionId, TokenUsageInfo } from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { createMessageId, createPartId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExternalSubagentTranscriptEntry } from "@zcode/contracts";
import { buildProjectionAnchor } from "./projection-anchor.js";

/** 外部子智能体在一次执行里的 transcript 累积状态。 */
interface ExternalTranscriptState {
  parentMessageId: MessageId;
  assistantMessageId: MessageId;
  /** 当前累积的 part（正文/思考按 kind 合并，工具与错误各自独立）。 */
  parts: Array<{ id: string; kind: ExternalSubagentTranscriptEntry["kind"]; text: string }>;
}

const EMPTY_TOKENS: TokenUsageInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

/**
 * 为一次外部子智能体执行创建 transcript 写入器。
 *
 * 返回的函数直接作为 `ExternalSubagentRunRequest.onTranscript` 传给端口。
 * 失败只记 warn：transcript 是观察层，写不进去不该让执行本身失败。
 */
export function createExternalSubagentTranscriptWriter(
  this: AgentRuntimeInternal,
  input: { childSessionId: SessionId; prompt: string; agentType: string },
): (entry: ExternalSubagentTranscriptEntry) => Promise<void> {
  const state: ExternalTranscriptState = {
    parentMessageId: createMessageId(),
    assistantMessageId: createMessageId(),
    parts: [],
  };
  let parentPersisted = false;
  let assistantPersisted = false;

  const fail = (error: unknown, phase: string) => {
    this.logger?.warn("External subagent transcript write failed", {
      childSessionId: input.childSessionId,
      error: error instanceof Error ? error.message : String(error),
      event: "subagent.external_transcript.write_failed",
      module: "core.subagent",
      phase,
    });
  };

  /** 首帧到达时才写消息行：没有任何输出的执行不该留下空 transcript。 */
  const ensureMessages = async (): Promise<void> => {
    const created = Date.now();
    const traceContext = this.rootTraceContext;
    if (!parentPersisted) {
      // 任务正文：下钻面板把它渲染成第一条"用户消息"，与原生子智能体一致
      // （面板要能看到"主 agent 发了什么"）。
      await this.persistSyntheticUserNoticeForSession({
        messageID: state.parentMessageId,
        sessionId: input.childSessionId,
        source: "subagent",
        text: input.prompt,
        traceContext,
        visibility: "user-visible",
        metadata: { externalSubagent: { agentType: input.agentType } },
      });
      parentPersisted = true;
    }
    if (!assistantPersisted) {
      const selection = this.getSessionModelSelection();
      await this.persistMessage(
        {
          id: state.assistantMessageId,
          sessionID: input.childSessionId,
          role: "assistant",
          time: { created },
          parentID: state.parentMessageId,
          // 外部 CLI 的模型 id 由 profile 声明，但它是 CLI 侧的字符串，
          // 不一定能对应到本机 provider 目录；能对应上才写，否则留空。
          ...(selection ? { providerId: createModelProviderId(selection.providerId) } : {}),
          ...(selection ? { modelId: createModelId(selection.modelId) } : {}),
          mode: this.config.mode ?? "build",
          planEnabled: this.getPlanEnabled(),
          agent: input.agentType,
          path: {
            cwd: this.workingDirectory,
            root: this.workspaceRoot,
          },
          cost: 0,
          // 外部 CLI 没有 ZCode 的原生 token 计数：如实置零，不编数字。
          tokens: EMPTY_TOKENS,
          semantics: {
            origin: "agent_runtime",
            kind: "assistant_response",
            uiVisibility: "visible",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          anchor: buildProjectionAnchor(traceContext),
          metadata: { externalSubagent: { agentType: input.agentType } },
        },
        traceContext,
      );
      assistantPersisted = true;
    }
  };

  const flushParts = async (): Promise<void> => {
    const traceContext = this.rootTraceContext;
    for (const part of state.parts) {
      await this.persistPart(
        {
          id: part.id as MessagePart["id"],
          sessionID: input.childSessionId,
          messageID: state.assistantMessageId,
          type: part.kind === "reasoning" ? "reasoning" : "text",
          text: part.text,
          // 失败原因用 text part + metadata 标记：不新增 part 类型（渲染层不必
          // 为它写特例），但面板能据此把它画成错误而不是"回答"。
          ...(part.kind === "error"
            ? { metadata: { externalSubagent: { kind: "error" as const } } }
            : {}),
        } as MessagePart,
        traceContext,
      );
    }
  };

  return async (entry) => {
    try {
      if (!entry.text.trim() && entry.mode !== "replace") return;
      await ensureMessages();
      if (entry.mode === "replace") {
        // 权威重建：整体替换（driver 用全量 stdout 重解析，比执行中的尾窗差分可靠）。
        //
        // 关键：必须**先删掉库里已有的旧 part**。只替换内存数组再逐条 save 新 part
        // 是不够的——执行期那些靠差分拼出来的 part 仍留在 store 里，下钻面板会同时
        // 显示"差分版本"和"重建版本"（重复/丢段的原文反而一直在）。
        const stale = state.parts.map((part) => part.id);
        state.parts = entry.text.trim()
          ? [{ id: createPartId(), kind: entry.kind, text: entry.text }]
          : [];
        for (const id of stale) {
          await this.removePersistedPart({
            sessionID: input.childSessionId,
            messageID: state.assistantMessageId,
            partID: id as MessagePart["id"],
          });
        }
        await flushParts();
        return;
      }
      // 追加：同 kind 的相邻条目合并到一个 part（流式正文/思考就是这样长出来的），
      // 工具条目各自独立——它们是不同次调用，合并会让面板看不出调了几次。
      const last = state.parts.at(-1);
      if (last && last.kind === entry.kind && entry.kind === "text") {
        last.text += entry.text;
        await flushParts();
        return;
      }
      state.parts.push({ id: createPartId(), kind: entry.kind, text: entry.text });
      await flushParts();
    } catch (error) {
      fail(error, entry.mode === "replace" ? "replace" : "append");
    }
  };
}
