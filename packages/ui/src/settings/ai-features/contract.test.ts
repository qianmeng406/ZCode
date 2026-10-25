import { describe, expect, it } from "vitest";

import {
  buildAiFeatureModelChoice,
  buildAiFeatureSelection,
  formatAiFeatureModelValue,
  migrateAiFeatureSelectionLevel,
  resolveAiFeatureDisplayLevel,
  type AiFeatureModelGroup,
} from "./aiFeatureModelOptions.js";
import { settingsAiFeaturesModule } from "./module.js";

// 模型目录 fixture：档位按语义强度从低到高（Registry 侧契约），与主目录一致。
const groups: readonly AiFeatureModelGroup[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    models: [{ modelId: "gpt-5", levels: ["low", "high"] }],
  },
];
const emptyView = { revision: 1, providers: [] } as never;
const viewWithGpt5 = {
  revision: 1,
  providers: [
    {
      providerId: "openai",
      providerName: "OpenAI",
      templateId: "t",
      config: {},
      models: [
        {
          modelId: "gpt-5",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
      ],
    },
  ],
} as never;

describe("settings-ai-features contract", () => {
  it("declares its module manifest", () => {
    expect(settingsAiFeaturesModule.id).toBe("settings-ai-features");
  });

  it("round-trips model selections without inventing a reasoning level", () => {
    const selection = buildAiFeatureSelection("openai", "gpt-5", undefined);
    expect(selection).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect(formatAiFeatureModelValue(selection)).toBe("openai/gpt-5");
  });

  it("选模型落盘最低公开档；模型不在目录时保持无档（执行侧如实报错）", () => {
    expect(buildAiFeatureModelChoice(groups, "openai", "gpt-5")).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
      options: { reasoningLevel: "low" },
    });
    expect(buildAiFeatureModelChoice(groups, "openai", "offline-model")).toEqual({
      providerId: "openai",
      modelId: "offline-model",
    });
  });

  it("档位显示：显式有效档保持，缺档/失效档回落最低档（与优化器同规则）", () => {
    const model = groups[0]!.models[0]!;
    expect(
      resolveAiFeatureDisplayLevel(model, buildAiFeatureSelection("openai", "gpt-5", "high")),
    ).toBe("high");
    expect(
      resolveAiFeatureDisplayLevel(model, buildAiFeatureSelection("openai", "gpt-5", undefined)),
    ).toBe("low");
    // 目录更新后移除的失效档位同样回落，而不是原样显示。
    expect(
      resolveAiFeatureDisplayLevel(model, buildAiFeatureSelection("openai", "gpt-5", "removed")),
    ).toBe("low");
    expect(resolveAiFeatureDisplayLevel(undefined, undefined)).toBeUndefined();
  });

  it("存量迁移：无档/失效档补最低档，显式有效档与模型缺席目录均不动", () => {
    expect(migrateAiFeatureSelectionLevel(null, viewWithGpt5)).toBeNull();
    expect(
      migrateAiFeatureSelectionLevel(
        buildAiFeatureSelection("openai", "gpt-5", "high"),
        viewWithGpt5,
      ),
    ).toBeNull();
    expect(
      migrateAiFeatureSelectionLevel(
        buildAiFeatureSelection("openai", "gpt-5", undefined),
        viewWithGpt5,
      ),
    ).toEqual({ providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "low" } });
    expect(
      migrateAiFeatureSelectionLevel(
        buildAiFeatureSelection("openai", "gpt-5", "removed"),
        viewWithGpt5,
      ),
    ).toEqual({ providerId: "openai", modelId: "gpt-5", options: { reasoningLevel: "low" } });
    // 模型已下线：无从解析档位，保持原样让执行侧如实报错。
    expect(
      migrateAiFeatureSelectionLevel(
        buildAiFeatureSelection("openai", "ghost", undefined),
        viewWithGpt5,
      ),
    ).toBeNull();
    expect(
      migrateAiFeatureSelectionLevel(
        buildAiFeatureSelection("openai", "gpt-5", undefined),
        emptyView,
      ),
    ).toBeNull();
  });
});
