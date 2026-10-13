import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);
  // prefix 重建完成即认为它反映了当前派生版本；请求准备边界据此跳过重复重建。
  runtime.contextPrefixRevision = runtime.contextProjectionRevision;

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

/**
 * canonical prefix 重投影（没有 turn-local 条目时使用，例如手动 compact 的摘要请求）。
 * 只在派生版本变化后重建，正常路径零成本。
 */
export function refreshCanonicalContextProjection(
  runtime: AgentRuntimeInternal,
  model?: Model,
): void {
  if (!runtime.contextInitialized || !runtime.contextBuilder) return;
  if (runtime.contextPrefixRevision === runtime.contextProjectionRevision) return;
  rebuildContextPrefix(runtime, { model });
}

/**
 * 请求准备边界：把 turn-local 请求条目重投影为「当前执行状态 + 当前实际 Model」的
 * context prefix 与后缀保留集合。
 *
 * 只在派生版本（mode/plan/档位、工具注册）或模型身份变化时重建，正常工具往返零成本。
 * 必须在 provider 请求前调用——Submission/Guide 会在这一步之前改执行状态，而
 * turn.ts 的首轮 context 构建发生在 Submission 应用之前，不重投影就会带上一档位前缀。
 */
export function prepareTurnRequestProjection(
  runtime: AgentRuntimeInternal,
  state: {
    turnRequestState: { entries: readonly RuntimeMessageEntry[] };
    appliedProjectionRevision: number;
    appliedProjectionModelKey?: string;
  },
  model: Model,
): void {
  const modelKey = `${model.providerId}/${model.modelId}/${model.options.reasoningLevel ?? ""}`;
  if (
    state.appliedProjectionRevision === runtime.contextProjectionRevision &&
    state.appliedProjectionModelKey === modelKey
  ) {
    return;
  }
  if (!runtime.contextInitialized || !runtime.contextBuilder) {
    // 尚未初始化：保留现有条目，等 ensureContextInitialized 安装完整 prefix。
    return;
  }
  state.turnRequestState.entries = rebuildContextPrefix(runtime, {
    model,
    turnRequestEntries: state.turnRequestState.entries,
  });
  state.appliedProjectionRevision = runtime.contextProjectionRevision;
  state.appliedProjectionModelKey = modelKey;
}
