import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_FEATURE_FOLLOW_MODEL_VALUE,
  buildAiFeatureModelChoice,
  buildAiFeatureModelGroups,
  buildAiFeatureSelection,
  findAiFeatureModel,
  formatAiFeatureModelValue,
  migrateAiFeatureSelectionLevel,
  resolveAiFeatureDisplayLevel,
} from "../src/settings/ai-features/aiFeatureModelOptions.js";

const view = {
  providers: [
    {
      providerId: "openai",
      providerName: "OpenAI",
      models: [
        {
          modelId: "gpt-5",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
        },
        { modelId: "gpt-4.1", config: { optionSpecs: {} } },
      ],
    },
    { providerId: "empty", providerName: "Empty", models: [] },
  ],
} as never;

const groups = buildAiFeatureModelGroups(view);

test("模型目录按 provider 分组并过滤空 provider", () => {
  const groups = buildAiFeatureModelGroups(view);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.models.map((model) => model.modelId),
    ["gpt-5", "gpt-4.1"],
  );
  assert.deepEqual(groups[0]?.models[0]?.levels, ["low", "high"]);
  assert.deepEqual(groups[0]?.models[1]?.levels, []);
  assert.equal(groups[0]?.label, "OpenAI");
});

test("模型值在跟随与具体模型之间稳定转换", () => {
  assert.equal(formatAiFeatureModelValue(null), AI_FEATURE_FOLLOW_MODEL_VALUE);
  assert.equal(formatAiFeatureModelValue(undefined), AI_FEATURE_FOLLOW_MODEL_VALUE);
  assert.equal(
    formatAiFeatureModelValue({ providerId: "openai", modelId: "gpt-5" }),
    "openai/gpt-5",
  );
});

test("按 provider/model 查找选择，缺失时返回 undefined", () => {
  const groups = buildAiFeatureModelGroups(view);
  assert.equal(
    findAiFeatureModel(groups, { providerId: "openai", modelId: "gpt-5" })?.modelId,
    "gpt-5",
  );
  assert.equal(findAiFeatureModel(groups, { providerId: "openai", modelId: "missing" }), undefined);
  assert.equal(findAiFeatureModel(groups, null), undefined);
});

test("重建选择时保留显式档位，缺省/空白则回到无档选择", () => {
  assert.deepEqual(buildAiFeatureSelection("openai", "gpt-5", "high"), {
    providerId: "openai",
    modelId: "gpt-5",
    options: { reasoningLevel: "high" },
  });
  assert.deepEqual(buildAiFeatureSelection("openai", "gpt-5", undefined), {
    providerId: "openai",
    modelId: "gpt-5",
  });
  assert.deepEqual(buildAiFeatureSelection("openai", "gpt-5", "   "), {
    providerId: "openai",
    modelId: "gpt-5",
  });
});

test("选模型落盘最低公开档；模型不在目录/无档位目录时保持无档", () => {
  assert.deepEqual(buildAiFeatureModelChoice(groups, "openai", "gpt-5"), {
    providerId: "openai",
    modelId: "gpt-5",
    options: { reasoningLevel: "low" },
  });
  assert.deepEqual(buildAiFeatureModelChoice(groups, "openai", "missing"), {
    providerId: "openai",
    modelId: "missing",
  });
  // 无 reasoningLevel 目录的模型（gpt-4.1）：无从解析档位，保持无档。
  assert.deepEqual(buildAiFeatureModelChoice(groups, "openai", "gpt-4.1"), {
    providerId: "openai",
    modelId: "gpt-4.1",
  });
});

test("档位显示：显式有效档保持，缺档/失效档回落最低档", () => {
  const gpt5 = groups[0]?.models[0];
  const gpt41 = groups[0]?.models[1];
  assert.equal(resolveAiFeatureDisplayLevel(gpt5, undefined), "low");
  assert.equal(
    resolveAiFeatureDisplayLevel(gpt5, { providerId: "openai", modelId: "gpt-5" }),
    "low",
  );
  assert.equal(
    resolveAiFeatureDisplayLevel(gpt5, {
      providerId: "openai",
      modelId: "gpt-5",
      options: { reasoningLevel: "high" },
    }),
    "high",
  );
  assert.equal(
    resolveAiFeatureDisplayLevel(gpt5, {
      providerId: "openai",
      modelId: "gpt-5",
      options: { reasoningLevel: "removed" },
    }),
    "low",
  );
  assert.equal(resolveAiFeatureDisplayLevel(gpt41, undefined), undefined);
});

test("存量迁移：无档/失效档补最低档，显式有效档与模型缺席目录均不动", () => {
  const gpt5 = { providerId: "openai", modelId: "gpt-5" };
  assert.equal(migrateAiFeatureSelectionLevel(null, view), null);
  assert.equal(
    migrateAiFeatureSelectionLevel({ ...gpt5, options: { reasoningLevel: "high" } }, view),
    null,
  );
  assert.deepEqual(migrateAiFeatureSelectionLevel(gpt5, view), {
    ...gpt5,
    options: { reasoningLevel: "low" },
  });
  assert.deepEqual(
    migrateAiFeatureSelectionLevel({ ...gpt5, options: { reasoningLevel: "removed" } }, view),
    {
      ...gpt5,
      options: { reasoningLevel: "low" },
    },
  );
  // 模型已下线：无从解析档位，保持原样让执行侧如实报错。
  assert.equal(
    migrateAiFeatureSelectionLevel({ providerId: "openai", modelId: "ghost" }, view),
    null,
  );
});
