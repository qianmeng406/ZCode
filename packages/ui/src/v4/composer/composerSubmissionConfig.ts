import {
  resolveRestoredExecutionState,
  type ContextProfile,
  type ModelSelection,
} from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";

export interface ComposerSubmissionConfig {
  modelSelection: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
  /** 上下文档位：与权限一起冻结，但独立选择、独立生效。 */
  contextProfile: ContextProfile;
}

/** 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。 */
export function createComposerSubmissionConfig(
  composer:
    | {
        mode?: string;
        planEnabled?: boolean;
        contextProfile?: string;
        modelSelection?: ModelSelection;
      }
    | null
    | undefined,
  view: ModelSelectionView | null,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const selection = composer.modelSelection;
  // Beta 是独立工作模式，shared submissionModeSchema 已含 beta；坏值仍不可提交。
  const draftMode = submissionModeSchema.safeParse(composer.mode);
  // 提交是重申当前草稿，不是显式切换模式：走恢复/读取语义（build+fusion 升级 Beta、
  // 其余历史组合原样保留），用户级显式切换已在草稿模式菜单层归一。
  const state = draftMode.success ? resolveRestoredExecutionState(composer) : null;
  // 读取升级可能把 build+fusion 映射为 beta；plan 在冻结面统一映射为 build。
  const mode = state ? submissionModeSchema.safeParse(state.mode) : null;
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (
    !mode?.success ||
    !state ||
    !selection ||
    !model ||
    !validateModelSelectionOptions(model, selection).ok
  )
    return null;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: mode.data === "plan" ? "build" : mode.data,
    planEnabled: state.planEnabled,
    contextProfile: state.contextProfile,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel: selection.options!.reasoningLevel! }),
    }),
  });
}
