import type { ZCodeProvider } from "@zcode/shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    default: "mode.label.glm.default",
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    research: "mode.label.glm.research",
    minimal: "mode.label.glm.minimal",
    beta: "mode.label.glm.beta",
    yolo: "mode.label.glm.yolo",
    guarded: "mode.label.glm.guarded",
    orchestrator: "mode.label.glm.orchestrator",
  },
};

export const ZCODE_MODE_OPTION_DESCRIPTION_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    default: "mode.description.glm.default",
    build: "mode.description.glm.build",
    edit: "mode.description.glm.edit",
    plan: "mode.description.glm.plan",
    research: "mode.description.glm.research",
    minimal: "mode.description.glm.minimal",
    beta: "mode.description.glm.beta",
    yolo: "mode.description.glm.yolo",
    guarded: "mode.description.glm.guarded",
    orchestrator: "mode.description.glm.orchestrator",
  },
};

/** 审批框与输入框共用权限颜色，浅色/深色主题由语义 token 决定。 */
export function modeTriggerColor(mode: string) {
  if (mode === "guarded") return "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue";
  if (mode === "yolo") return "text-warning hover:text-warning";
  return undefined;
}
