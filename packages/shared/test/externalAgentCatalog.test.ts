import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_AGENT_PRESETS,
  findExternalAgentPreset,
  parseModelListFromHelp,
} from "../src/externalAgentCatalog.js";
import {
  buildExternalAgentInvocation,
  externalAgentBindingSchema,
  parseExternalAgentResult,
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

// ── 推理档位 ──
// 三家 CLI 传 effort 的形状完全不同：claude/codebuddy 是 --effort，
// codex 根本没有这个 flag，只能 -c model_reasoning_effort="…"。
// 猜错形状会让整个调用失败，所以每种形状各钉一条。

test("预设档位值域: claude 无 minimal，codebuddy 有，codex 走 config", () => {
  const claude = findExternalAgentPreset("claude-code")!;
  const codebuddy = findExternalAgentPreset("codebuddy")!;
  const codex = findExternalAgentPreset("codex")!;
  assert.ok(!claude.effortLevels.includes("minimal"));
  assert.ok(codebuddy.effortLevels.includes("minimal"));
  assert.equal(claude.effortDelivery, "flag");
  assert.equal(codebuddy.effortDelivery, "flag");
  assert.equal(codex.effortDelivery, "config");
  assert.equal(codex.effortConfigKey, "model_reasoning_effort");
});

test("档位注入: claude-family 用 --effort", () => {
  const invocation = buildExternalAgentInvocation({ ...baseBinding, effort: "high" }, "干活");
  assert.deepEqual(invocation.args, ["-p", "--output-format", "json", "--effort", "high", "干活"]);
});

test("档位注入: codex-exec 用 -c model_reasoning_effort=...", () => {
  const codex = externalAgentBindingSchema.parse({
    label: "codex",
    driver: "codex-exec",
    command: "codex",
    args: ["exec"],
    promptDelivery: "argv-append",
    effort: "high",
  });
  assert.deepEqual(buildExternalAgentInvocation(codex, "干活").args, [
    "exec",
    "-c",
    'model_reasoning_effort="high"',
    "干活",
  ]);
});

test("档位注入: 未指定 effort 时不出现任何档位参数", () => {
  const invocation = buildExternalAgentInvocation(baseBinding, "干活");
  assert.ok(!invocation.args.includes("--effort"));
  assert.ok(!invocation.args.some((arg) => arg.startsWith("model_reasoning_effort")));
});

test("档位注入: generic-template 忽略 effort（不猜参数名）", () => {
  const template = externalAgentBindingSchema.parse({
    label: "x",
    driver: "generic-template",
    command: "my-agent",
    promptDelivery: "argv-append",
    effort: "high",
  });
  assert.deepEqual(buildExternalAgentInvocation(template, "干活").args, ["干活"]);
});

test("模型与档位同时给时顺序稳定（model → effort → permissionMode）", () => {
  const invocation = buildExternalAgentInvocation(
    { ...baseBinding, model: "hy3", effort: "max", permissionMode: "acceptEdits" },
    "干活",
  );
  assert.deepEqual(invocation.args, [
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
