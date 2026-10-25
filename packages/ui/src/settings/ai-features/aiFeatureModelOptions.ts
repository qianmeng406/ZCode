import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";

/** Radix Select 不接受空字符串 item value；用哨兵表示「跟随会话模型」。 */
export const AI_FEATURE_FOLLOW_MODEL_VALUE = "__follow_session_model__";

export interface AiFeatureModelOption {
  modelId: string;
  levels: readonly string[];
}

export interface AiFeatureModelGroup {
  providerId: string;
  label: string;
  models: readonly AiFeatureModelOption[];
}

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

/** 用新的推理档位重建选择；档位缺席时保持无档选择（见 buildAiFeatureModelChoice 注释）。 */
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

/**
 * 选模型时的落盘选择：带模型目录的最低公开档——Registry 执行侧强制要求显式档位，
 * 无档位选择会被 "Reasoning level is required" 拒绝，正常路径不允许落盘。
 * 唯一例外是模型不在当前目录（视图未就绪/已下线）：无从解析档位，保持无档落盘，
 * 执行侧会如实报错，目录就绪后由会话层的一次性迁移（migrateAiFeatureSelectionLevel）补齐。
 */
export function buildAiFeatureModelChoice(
  groups: readonly AiFeatureModelGroup[],
  providerId: string,
  modelId: string,
): ModelSelection {
  const model = findAiFeatureModel(groups, { providerId, modelId });
  return buildAiFeatureSelection(providerId, modelId, model?.levels[0]);
}

/**
 * 档位下拉的当前值：显式且在目录内的档位保持，缺档/失效档回落最低公开档。
 * 与优化器执行侧（usePromptOptimizer）的档位解析同一条规则，让下拉显示与
 * 实际执行语义一致——不存在「永不选中」的冗余项。
 */
export function resolveAiFeatureDisplayLevel(
  model: AiFeatureModelOption | undefined,
  selection: ModelSelection | null | undefined,
): string | undefined {
  const levels = model?.levels ?? [];
  const current = selection?.options?.reasoningLevel;
  return current && levels.includes(current) ? current : levels[0];
}

/**
 * 旧「默认档」语义落盘的无档/失效档模型偏好迁移为显式最低公开档（一次性写回设置）。
 * 无需迁移（显式有效档位、无偏好、模型缺席目录）返回 null。执行侧不做静默补档，
 * 存量数据的可执行性由这条迁移保证。
 */
export function migrateAiFeatureSelectionLevel(
  selection: ModelSelection | null | undefined,
  view: ModelSelectionView | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const model = findAiFeatureModel(buildAiFeatureModelGroups(view), selection);
  const levels = model?.levels ?? [];
  if (levels.length === 0) return null;
  const current = selection.options?.reasoningLevel;
  if (current && levels.includes(current)) return null;
  return { ...selection, options: { reasoningLevel: levels[0]! } };
}
