import type { PlanExecutionModelChoice, PlanExecutionModelGroup } from "@/ElicitationDialog.js";

/**
 * 计划批准卡片「执行模型」选择的纯函数助手。
 *
 * 计划批准是显式的执行入口：用户在批准卡片上点选某个模型，就是要用它执行本计划，
 * 而不是“先选模型、档位留空”。registry 的 ModelSelection 校验要求 reasoningLevel
 * 必须存在且受支持（provider-registry-model-runtime.modelFactory → validateSelection），
 * 普通 Composer 切模型也走 completeNewModelSelection 补齐最高档。因此这里沿用同一
 * 语义：选中模型即补齐该模型的最高档（reasoningLevels 末位，顺序为弱→强）。
 * 模型无任何档位时返回 undefined——这类模型无法被 registry 校验，不能生成执行选择。
 */
export function completePlanExecutionModelChoice(
  groups: readonly PlanExecutionModelGroup[] | undefined,
  picked: PlanExecutionModelChoice,
): PlanExecutionModelChoice | undefined {
  const model = groups
    ?.find((group) => group.providerId === picked.providerId)
    ?.models.find((candidate) => candidate.modelId === picked.modelId);
  const reasoningLevel = model?.reasoningLevels.at(-1);
  if (!reasoningLevel) return undefined;
  return { providerId: picked.providerId, modelId: picked.modelId, reasoningLevel };
}

/**
 * 候选目录更新后，当前选择必须仍指向目录内的模型，且档位仍受支持，才算有效。
 * 已禁用/删除的模型或已移除的档位会让执行回合在 registry 校验阶段启动失败，
 * 因此必须在提交前发现并回退到「跟随会话模型」。
 */
export function isPlanExecutionModelChoiceValid(
  groups: readonly PlanExecutionModelGroup[] | undefined,
  choice: PlanExecutionModelChoice,
): boolean {
  const model = groups
    ?.find((group) => group.providerId === choice.providerId)
    ?.models.find((candidate) => candidate.modelId === choice.modelId);
  if (!model) return false;
  return (
    choice.reasoningLevel !== undefined && model.reasoningLevels.includes(choice.reasoningLevel)
  );
}
