import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_FEATURE_DEFAULT_LEVEL_VALUE,
  AI_FEATURE_FOLLOW_MODEL_VALUE,
  buildAiFeatureModelGroups,
  buildAiFeatureSelection,
  findAiFeatureModel,
  formatAiFeatureModelValue,
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
  assert.notEqual(AI_FEATURE_FOLLOW_MODEL_VALUE, AI_FEATURE_DEFAULT_LEVEL_VALUE);
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

test("重建选择时保留显式档位，缺省/空白则回到模型默认档", () => {
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
