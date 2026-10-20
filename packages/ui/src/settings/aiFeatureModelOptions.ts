import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";

/** Radix Select 不接受空字符串 item value；用哨兵表示「跟随会话模型」。 */
export const AI_FEATURE_FOLLOW_MODEL_VALUE = "__follow_session_model__";
/** 推理档位「模型默认档」哨兵。 */
export const AI_FEATURE_DEFAULT_LEVEL_VALUE = "__model_default_level__";

export interface AiFeatureModelOption {
  modelId: string;
  levels: readonly string[];
}

export interface AiFeatureModelGroup {
  providerId: string;
  label: string;
  models: readonly AiFeatureModelOption[];
}

export type AiFeatureReasoningLevelPolicy = "none" | "lowest";

/** 模型选择 → Select 值；null = 跟随会话模型。 */
export function formatAiFeatureModelValue(selection: ModelSelection | null | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : AI_FEATURE_FOLLOW_MODEL_VALUE;
}

/** 从模型目录构建设置页下拉分组；保持 Host 返回的 provider/model 顺序。 */
export function buildAiFeatureModelGroups(
  view: ModelSelectionView | null | undefined,
): AiFeatureModelGroup[] {
  return (view?.providers ?? [])
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      providerId: provider.providerId,
      label: provider.providerName?.trim() || provider.providerId,
      models: provider.models.map((model) => ({
        modelId: model.modelId,
        levels: model.config.optionSpecs.reasoningLevel?.values ?? [],
      })),
    }));
}

export function findAiFeatureModel(
  groups: readonly AiFeatureModelGroup[],
  selection: ModelSelection | null | undefined,
): AiFeatureModelOption | undefined {
  if (!selection) return undefined;
  return groups
    .find((group) => group.providerId === selection.providerId)
    ?.models.find((model) => model.modelId === selection.modelId);
}

/** 用新的推理档位重建选择；未指定档位时删除 options，保持「模型默认档」。 */
export function buildAiFeatureSelection(
  providerId: string,
  modelId: string,
  reasoningLevel: string | undefined,
): ModelSelection {
  const level = reasoningLevel?.trim();
  return {
    providerId,
    modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}
