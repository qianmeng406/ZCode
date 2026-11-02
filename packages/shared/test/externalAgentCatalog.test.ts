import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_AGENT_PRESETS,
  findExternalAgentPreset,
  parseModelListFromHelp,
  resolveEffortLevels,
} from "../src/externalAgentCatalog.js";
import {
  buildExternalAgentInvocation,
  externalAgentBindingSchema,
  parseExternalAgentResult,
  readModelEffort,
  withModelEffort,
} from "../src/externalAgentBinding.js";

// 外部 agent 预设目录与探测解析。
//
// 这一层决定"对话框里能看到什么"。两个最容易错的地方各钉一条：
// 1. 模型清单解析（codebuddy 把支持列表印在 --help 里）；解析失败必须回空数组，
//    而不是把整段帮助文本当成模型名；
// 2. 预设的调用形状必须与实测参数一致——猜错的参数会让绑定在运行时静默失败。

test("EXTERNAL_AGENT_PRESETS: 每个预设 id 唯一且 command 非空", () => {
  const ids = EXTERNAL_AGENT_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of EXTERNAL_AGENT_PRESETS) {
    assert.ok(preset.command.trim().length > 0);
    assert.ok(preset.description.trim().length > 0);
  }
});

test("findExternalAgentPreset: 命中已知 id，未知/空返回 undefined", () => {
  assert.equal(findExternalAgentPreset("codebuddy")?.command, "codebuddy");
  assert.equal(findExternalAgentPreset("nope"), undefined);
  assert.equal(findExternalAgentPreset(undefined), undefined);
});

test("codex 预设用 codex-exec 族与 exec 子命令", () => {
  const codex = findExternalAgentPreset("codex")!;
  assert.equal(codex.driver, "codex-exec");
  assert.deepEqual(codex.args, ["exec"]);
  assert.equal(codex.modelFlag, "-m");
});

test("claude-family 预设都是 -p + json 输出 + 末尾追加 prompt", () => {
  for (const preset of EXTERNAL_AGENT_PRESETS.filter((p) => p.driver === "claude-family")) {
    assert.deepEqual(preset.args, ["-p", "--output-format", "json"]);
    assert.equal(preset.promptDelivery, "argv-append");
  }
});

test("parseModelListFromHelp: 从 codebuddy 帮助文本抽出模型清单", () => {
  const help =
    "  --model <model>   Model for the current session. Please provide the model ID. " +
    "Currently supported: (hy4-preview, hy3, deepseek-v4-pro)";
  assert.deepEqual(parseModelListFromHelp(help), ["hy4-preview", "hy3", "deepseek-v4-pro"]);
});

test("parseModelListFromHelp: 没有列表时回空数组（不把正文当模型名）", () => {
  assert.deepEqual(parseModelListFromHelp("Usage: codebuddy [options]"), []);
  assert.deepEqual(parseModelListFromHelp(""), []);
});

const baseBinding = externalAgentBindingSchema.parse({
  label: "cb",
  driver: "claude-family",
  command: "codebuddy",
  promptDelivery: "argv-append",
});

test("模型注入: claude-family 用 --model，插在 prompt 之前、permissionMode 之后", () => {
  const invocation = buildExternalAgentInvocation(
    { ...baseBinding, model: "hy3", permissionMode: "acceptEdits" },
    "干活",
  );
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "hy3",
    "--permission-mode",
    "acceptEdits",
    "干活",
  ]);
});

test("模型注入: 未指定 model 时不出现任何模型 flag", () => {
  const invocation = buildExternalAgentInvocation(baseBinding, "干活");
  assert.ok(!invocation.args.includes("--model"));
});

test("模型注入: codex-exec 用 -m 且保留 exec 子命令", () => {
  const codex = externalAgentBindingSchema.parse({
    label: "codex",
    driver: "codex-exec",
    command: "codex",
    args: ["exec"],
    promptDelivery: "argv-append",
    model: "gpt-5-codex",
  });
  assert.deepEqual(buildExternalAgentInvocation(codex, "干活").args, [
    "exec",
    "-m",
    "gpt-5-codex",
    "干活",
  ]);
});

test("模型注入: generic-template 忽略 model（该族不接受模型参数）", () => {
  const template = externalAgentBindingSchema.parse({
    label: "x",
    driver: "generic-template",
    command: "my-agent",
    promptDelivery: "argv-append",
    model: "whatever",
  });
  assert.deepEqual(buildExternalAgentInvocation(template, "干活").args, ["干活"]);
});

test("codex-exec 输出解析: stdout 原样返回", () => {
  const codex = externalAgentBindingSchema.parse({
    label: "codex",
    driver: "codex-exec",
    command: "codex",
    promptDelivery: "argv-append",
  });
  assert.deepEqual(parseExternalAgentResult(codex, "修好了 3 处"), {
    text: "修好了 3 处",
    isError: false,
  });
});

// ── 推理档位：属于模型，不属于 CLI ──
// 同一个 CLI 里不同模型支持不同档位；绑定上挂一个全局值会让换模型后沿用无效档位。
// 所以：候选按模型解析（resolveEffortLevels），值按模型分开记（effortsByModel）。

test("档位候选按模型解析：精确键优先，其次 CLI 默认档，都没有则空", () => {
  const preset = findExternalAgentPreset("codebuddy")!;
  // 预设只登记了 "" 这一档（CLI 级事实），任何模型都能退到它。
  assert.deepEqual(resolveEffortLevels(preset, undefined), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(resolveEffortLevels(preset, "hy3"), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("档位候选：预设有精确模型键时用它，不给该模型套 CLI 默认表", () => {
  const preset = {
    ...findExternalAgentPreset("codebuddy")!,
    effortLevelsByModel: { "": ["low", "high"], "special-model": ["only-one"] },
  };
  assert.deepEqual(resolveEffortLevels(preset, "special-model"), ["only-one"]);
  assert.deepEqual(resolveEffortLevels(preset, "other-model"), ["low", "high"]);
});

test("档位候选：没有任何登记时返回空（调用方应隐藏档位入口）", () => {
  const preset = { ...findExternalAgentPreset("codebuddy")!, effortLevelsByModel: {} };
  assert.deepEqual(resolveEffortLevels(preset, "hy3"), []);
});

test("档位按模型分开记：改 A 模型不影响 B 模型", () => {
  const bound = withModelEffort({ ...baseBinding, model: "model-a" }, "model-a", "high");
  const switched = withModelEffort(bound, "model-b", "low");
  assert.equal(readModelEffort(switched, "model-a"), "high");
  assert.equal(readModelEffort(switched, "model-b"), "low");
});

test("清除某个模型的档位不影响其他模型", () => {
  let bound = withModelEffort({ ...baseBinding, model: "a" }, "a", "high");
  bound = withModelEffort(bound, "b", "low");
  const cleared = withModelEffort(bound, "a", null);
  assert.equal(readModelEffort(cleared, "a"), undefined);
  assert.equal(readModelEffort(cleared, "b"), "low");
});

test("全部清空后 effortsByModel 字段整体消失（不留空对象）", () => {
  const bound = withModelEffort({ ...baseBinding }, undefined, "high");
  assert.deepEqual(bound.effortsByModel, { "": "high" });
  const cleared = withModelEffort(bound, undefined, null);
  assert.equal(cleared.effortsByModel, undefined);
});

test("档位注入: claude-family 取**当前模型**记着的那一档", () => {
  let bound = withModelEffort({ ...baseBinding, model: "hy3" }, "hy3", "high");
  bound = withModelEffort(bound, "glm-5.3", "max");
  assert.deepEqual(buildExternalAgentInvocation(bound, "干活").args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "hy3",
    "--effort",
    "high",
    "干活",
  ]);
});

test("档位注入: 换模型后自动用新模型自己的档位，不会残留旧模型的", () => {
  let bound = withModelEffort({ ...baseBinding, model: "a" }, "a", "high");
  bound = { ...bound, model: "b" };
  // b 没记档位 → 不注入任何 --effort。
  assert.ok(!buildExternalAgentInvocation(bound, "干活").args.includes("--effort"));
});

test("档位注入: codex-exec 用 -c model_reasoning_effort=...", () => {
  const codex = withModelEffort(
    externalAgentBindingSchema.parse({
      label: "codex",
      driver: "codex-exec",
      command: "codex",
      args: ["exec"],
      promptDelivery: "argv-append",
      model: "gpt-5-codex",
    }),
    "gpt-5-codex",
    "high",
  );
  assert.deepEqual(buildExternalAgentInvocation(codex, "干活").args, [
    "exec",
    "-m",
    "gpt-5-codex",
    "-c",
    'model_reasoning_effort="high"',
    "干活",
  ]);
});

test("档位注入: generic-template 忽略档位（不猜参数名）", () => {
  const template = withModelEffort(
    externalAgentBindingSchema.parse({
      label: "x",
      driver: "generic-template",
      command: "my-agent",
      promptDelivery: "argv-append",
    }),
    undefined,
    "high",
  );
  assert.deepEqual(buildExternalAgentInvocation(template, "干活").args, ["干活"]);
});

test("模型与档位同时给时顺序稳定（model → effort → permissionMode）", () => {
  const bound = withModelEffort(
    { ...baseBinding, model: "hy3", permissionMode: "acceptEdits" },
    "hy3",
    "max",
  );
  assert.deepEqual(buildExternalAgentInvocation(bound, "干活").args, [
    "-p",
    "--output-format",
    "json",
    "--model",
    "hy3",
    "--effort",
    "max",
    "--permission-mode",
    "acceptEdits",
    "干活",
  ]);
});
