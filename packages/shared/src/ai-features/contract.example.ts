/**
 * shared-ai-features 标准调用示例：设置值来自持久化或旧版本迁移，必须经守卫归一化。
 */
import { isPromptOptimizerMode, type PromptOptimizerMode } from "./contract.js";

export function exampleSharedAiFeatures(raw: unknown): PromptOptimizerMode {
  return isPromptOptimizerMode(raw) ? raw : "polish";
}
