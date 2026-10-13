import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeConfigOption } from "@zcode/shared";
import { resolveProviderModeIdFromConfigOptions } from "../src/session/sessionModeOptions.js";

const modeConfigOptions = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    options: [
      { value: "build", name: "Ask before changes" },
      { value: "edit", name: "Edit automatically" },
      { value: "plan", name: "Plan mode" },
      { value: "yolo", name: "Full access" },
      { value: "research", name: "Research" },
      { value: "minimal", name: "Minimal" },
      { value: "zcodeUpdate", name: "ZCode update" },
    ],
  },
] as unknown as readonly ZCodeConfigOption[];

test("legacy persisted workflow mode resolves to build", () => {
  // 项目开发模式已移除：旧会话/配置里遗留的 workflow 值必须回退到 build（撤销自动执行授权），
  // 不能抛错，也不能落到无对等档位的 undefined。
  const resolved = resolveProviderModeIdFromConfigOptions({
    configOptions: modeConfigOptions,
    modeId: "workflow",
  });
  assert.equal(resolved, "build");
});

test("known modes still resolve to themselves", () => {
  assert.equal(
    resolveProviderModeIdFromConfigOptions({ configOptions: modeConfigOptions, modeId: "edit" }),
    "edit",
  );
  assert.equal(
    resolveProviderModeIdFromConfigOptions({ configOptions: modeConfigOptions, modeId: "plan" }),
    "plan",
  );
});
