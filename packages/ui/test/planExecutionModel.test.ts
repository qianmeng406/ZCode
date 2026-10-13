import assert from "node:assert/strict";
import test from "node:test";
import {
  completePlanExecutionModelChoice,
  isPlanExecutionModelChoiceValid,
} from "../src/lib/planExecutionModel.js";

const GROUPS = [
  {
    providerId: "custom-provider",
    providerName: "CustomProvider",
    models: [
      { modelId: "m-high", reasoningLevels: ["low", "medium", "high"] },
      { modelId: "m-single", reasoningLevels: ["standard"] },
      { modelId: "m-no-levels", reasoningLevels: [] },
    ],
  },
  {
    providerId: "other",
    models: [{ modelId: "m-other", reasoningLevels: ["minimal", "high"] }],
  },
];

test("选中模型即补齐最高档（values 末位），与 Composer 切模型同语义", () => {
  assert.deepEqual(
    completePlanExecutionModelChoice(GROUPS, { providerId: "custom-provider", modelId: "m-high" }),
    {
      providerId: "custom-provider",
      modelId: "m-high",
      reasoningLevel: "high",
    },
  );
  assert.deepEqual(
    completePlanExecutionModelChoice(GROUPS, { providerId: "other", modelId: "m-other" }),
    {
      providerId: "other",
      modelId: "m-other",
      reasoningLevel: "high",
    },
  );
});

test("单档模型补齐该唯一档位", () => {
  assert.deepEqual(
    completePlanExecutionModelChoice(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-single",
    }),
    {
      providerId: "custom-provider",
      modelId: "m-single",
      reasoningLevel: "standard",
    },
  );
});

test("无任何档位的模型或未知模型返回 undefined（不能生成 registry 拒绝的选择）", () => {
  assert.equal(
    completePlanExecutionModelChoice(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-no-levels",
    }),
    undefined,
  );
  assert.equal(
    completePlanExecutionModelChoice(GROUPS, { providerId: "missing", modelId: "m" }),
    undefined,
  );
  assert.equal(
    completePlanExecutionModelChoice(undefined, {
      providerId: "custom-provider",
      modelId: "m-high",
    }),
    undefined,
  );
});

test("有效性校验要求模型在目录内且档位仍受支持", () => {
  assert.equal(
    isPlanExecutionModelChoiceValid(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-high",
      reasoningLevel: "high",
    }),
    true,
  );
  // 档位被移除
  assert.equal(
    isPlanExecutionModelChoiceValid(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-high",
      reasoningLevel: "ultra",
    }),
    false,
  );
  // 模型已不可见（被禁用/删除）
  assert.equal(
    isPlanExecutionModelChoiceValid(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-removed",
      reasoningLevel: "high",
    }),
    false,
  );
  // 缺档位
  assert.equal(
    isPlanExecutionModelChoiceValid(GROUPS, {
      providerId: "custom-provider",
      modelId: "m-high",
    }),
    false,
  );
  assert.equal(
    isPlanExecutionModelChoiceValid(undefined, {
      providerId: "custom-provider",
      modelId: "m-high",
      reasoningLevel: "high",
    }),
    false,
  );
});
