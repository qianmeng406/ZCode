/**
 * settings-ai-features 对外契约：设置页只负责展示与归一化，不直接写设置。
 * 调用方通过受控 props 注入当前值与保存回调。
 */
export type { AiFeatureModelSettingProps } from "./AiFeatureModelSetting.js";
export type { AiFeatureModelGroup, AiFeatureModelOption } from "./aiFeatureModelOptions.js";
export {
  buildAiFeatureModelChoice,
  buildAiFeatureModelGroups,
  buildAiFeatureSelection,
  findAiFeatureModel,
  formatAiFeatureModelValue,
  migrateAiFeatureSelectionLevel,
  resolveAiFeatureDisplayLevel,
  AI_FEATURE_FOLLOW_MODEL_VALUE,
} from "./aiFeatureModelOptions.js";
