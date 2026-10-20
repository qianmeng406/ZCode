/**
 * shared-ai-features 对外契约：提示词优化方式与上下文范围的唯一合法取值。
 * 调用方只应依赖这里的守卫与联合类型；新增取值必须同时更新 contract.test.ts。
 */
export {
  PROMPT_OPTIMIZER_CONTEXT_RANGES,
  PROMPT_OPTIMIZER_MODES,
  isPromptOptimizerContextRange,
  isPromptOptimizerMode,
  type PromptOptimizerContextRange,
  type PromptOptimizerMode,
} from "./ai-feature-preferences.js";
