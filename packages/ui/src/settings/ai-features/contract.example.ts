/**
 * settings-ai-features 标准调用示例：模型行只上报选择，由调用方决定落到哪个设置字段。
 */
import type { AiFeatureModelSettingProps } from "./contract.js";

export function exampleSettingsAiFeatures(props: AiFeatureModelSettingProps): string {
  return props.value ? `${props.value.providerId}/${props.value.modelId}` : props.followLabel;
}
