import type { ZCodeProvider } from "@zcode/shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    default: "mode.label.glm.default",
    build: "mode.label.glm.build",
    edit: "mode.label.glm.edit",
    plan: "mode.label.glm.plan",
    research: "mode.label.glm.research",
    minimal: "mode.label.glm.minimal",
    zcodeUpdate: "mode.label.glm.zcodeUpdate",
    yolo: "mode.label.glm.yolo",
    guarded: "mode.label.glm.guarded",
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
    zcodeUpdate: "mode.description.glm.zcodeUpdate",
    yolo: "mode.description.glm.yolo",
    guarded: "mode.description.glm.guarded",
  },
};
