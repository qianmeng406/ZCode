/** 提示词优化与审查功能的全局偏好枚举；设置 schema、设置页和输入栏共用。 */

export const PROMPT_OPTIMIZER_MODES = ["polish", "structure"] as const;
export type PromptOptimizerMode = (typeof PROMPT_OPTIMIZER_MODES)[number];

export const PROMPT_OPTIMIZER_CONTEXT_RANGES = ["draft", "conversation"] as const;
export type PromptOptimizerContextRange = (typeof PROMPT_OPTIMIZER_CONTEXT_RANGES)[number];

export function isPromptOptimizerMode(value: unknown): value is PromptOptimizerMode {
  return typeof value === "string" && (PROMPT_OPTIMIZER_MODES as readonly string[]).includes(value);
}

export function isPromptOptimizerContextRange(
  value: unknown,
): value is PromptOptimizerContextRange {
  return (
    typeof value === "string" &&
    (PROMPT_OPTIMIZER_CONTEXT_RANGES as readonly string[]).includes(value)
  );
}
