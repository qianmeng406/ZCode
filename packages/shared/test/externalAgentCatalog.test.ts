import assert from "node:assert/strict";
import test from "node:test";
import {
  CLI_PICKER_DEFAULT_EFFORTS,
  EXTERNAL_AGENT_BINDABLE_PRESETS,
  EXTERNAL_AGENT_PRESETS,
  findExternalAgentPreset,
  parseModelCatalogFromProductJson,
  parseModelListFromHelp,
  parseServerModelCache,
  resolveEffortLevels,
} from "../src/externalAgentCatalog.js";
import {
  createClaudeStreamParser,
  createOpencodeStreamParser,
  parseClaudeFamilyStreamActivities,
  parseOpencodeStreamActivities,
} from "../src/externalAgentStream.js";
import {
  buildExternalAgentInvocation,
  externalAgentBindingSchema,
  parseExternalAgentResult,
  parseOpencodeRunResult,
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

test("EXTERNAL_AGENT_BINDABLE_PRESETS: 只列完整适配的", () => {
  // 绑定列表的准入条件只有一个：调用形状 + 流式过程 + 模型目录 + 会话落盘都实测过。
  // codex / claude-code 目前只验证过最基本的调用形状，列出来用户会以为能完整用。
  assert.deepEqual(
    EXTERNAL_AGENT_BINDABLE_PRESETS.map((preset) => preset.id),
    ["codebuddy", "opencode"],
  );
  // 目录里不删它们：老绑定还要靠 findExternalAgentPreset 回显 label 与调用参数。
  for (const id of ["claude-code", "codex"]) {
    const preset = findExternalAgentPreset(id);
    assert.ok(preset);
    assert.equal(preset.adaptation, "partial");
  }
});

test("codex 预设用 codex-exec 族与 exec 子命令", () => {
  const codex = findExternalAgentPreset("codex")!;
  assert.equal(codex.driver, "codex-exec");
  assert.deepEqual(codex.args, ["exec"]);
  assert.equal(codex.modelFlag, "-m");
});

test("claude-family 预设都是 -p + stream-json 输出 + stdin 交付 prompt", () => {
  for (const preset of EXTERNAL_AGENT_PRESETS.filter((p) => p.driver === "claude-family")) {
    assert.deepEqual(preset.args, [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
    ]);
    // 交付形状由驱动族知识决定（Windows .cmd shim 会截断多行 argv），落库值不参与分流。
    assert.equal(preset.promptDelivery, "stdin");
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

test("模型注入: claude-family 用 --model，插在 permissionMode 之后；prompt 走 stdin", () => {
  const invocation = buildExternalAgentInvocation(
    { ...baseBinding, model: "hy3", permissionMode: "acceptEdits" },
    "干活",
  );
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    "hy3",
    "--permission-mode",
    "acceptEdits",
  ]);
  assert.equal(invocation.stdin, "干活");
});

test("claude-family 多行 prompt 完整进 stdin，绝不进 argv（cmd shim 截断防线）", () => {
  const prompt = "第一行\n第二行\n\n第四行";
  const invocation = buildExternalAgentInvocation(baseBinding, prompt);
  assert.equal(invocation.stdin, prompt);
  for (const line of prompt.split("\n")) {
    assert.ok(!invocation.args.includes(line));
  }
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

test("档位候选：opencode（variant）探测到空候选时不回落到缺省档", () => {
  const preset = findExternalAgentPreset("opencode")!;
  // 实测（v2.2.5）：big-pickle 的 reasoning_options 是空数组，传 #low 报
  // `Variant unavailable`。回落到 CLI 缺省档（codebuddy 的做法）在这里必然失败，
  // 所以 variant 族的空候选必须当成"该模型没有档位"。
  assert.deepEqual(
    resolveEffortLevels(preset, "opencode/big-pickle", [
      { id: "opencode/big-pickle", name: "opencode/big-pickle", supportedEfforts: [] },
    ]),
    [],
  );
  // 有候选时照常按模型给。
  assert.deepEqual(
    resolveEffortLevels(preset, "opencode/beam-free", [
      {
        id: "opencode/beam-free",
        name: "opencode/beam-free",
        supportedEfforts: ["low", "medium", "high"],
      },
    ]),
    ["low", "medium", "high"],
  );
});

test("档位候选：claude-family 探测到空候选时仍回落缺省档（与 opencode 相反）", () => {
  // 行为差异的依据：codebuddy 的固定档模型（hy4free）传任意档都不报错，
  // 隐藏档位入口反而让用户以为该模型不支持推理档位。
  const preset = findExternalAgentPreset("codebuddy")!;
  const levels = resolveEffortLevels(preset, "hy4free", [
    { id: "hy4free", name: "hy4free", supportedEfforts: [] },
  ]);
  // 回落的是 CLI 选择器的缺省档（不是预设那张含 minimal 的静态表）。
  assert.deepEqual(levels, [...CLI_PICKER_DEFAULT_EFFORTS]);
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
  const invocation = buildExternalAgentInvocation(bound, "干活");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    "hy3",
    "--effort",
    "high",
  ]);
  assert.equal(invocation.stdin, "干活");
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
  const invocation = buildExternalAgentInvocation(bound, "干活");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--model",
    "hy3",
    "--effort",
    "max",
    "--permission-mode",
    "acceptEdits",
  ]);
  assert.equal(invocation.stdin, "干活");
});

// ── opencode 适配 ──
// 调用形状来自 v2.2.5 实测：`opencode run --format json` 输出 JSONL，prompt 走 stdin，
// 模型清单来自 `opencode models`，没有独立 effort flag。

test("opencode 预设：run --format json + stdin 交付 + models 子命令 + 无档位", () => {
  const opencode = findExternalAgentPreset("opencode")!;
  assert.equal(opencode.driver, "opencode-exec");
  assert.equal(opencode.adaptation, "full");
  assert.deepEqual(opencode.args, ["run", "--format", "json"]);
  assert.equal(opencode.promptDelivery, "stdin");
  assert.equal(opencode.permissionMode, "auto");
  assert.equal(opencode.modelFlag, "--model");
  assert.equal(opencode.modelSource, "command");
  assert.deepEqual(opencode.modelListCommand, ["models"]);
  // 档位走 --model 的 #variant（实测 v2.2.5）：没有独立 effort flag，但每档真实存在，
  // 传错档位会报 Variant unavailable。逐模型候选由探测（models.json）给出，预设本身为空表。
  assert.equal(opencode.effortDelivery, "variant");
  assert.deepEqual(opencode.effortLevelsByModel, {});
  // 静态兜底（探测不可用时）：opencode 没有 CLI 级兜底档，空 = 不显示档位入口。
  assert.deepEqual(resolveEffortLevels(opencode, "anthropic/claude"), []);
});

const opencodeBinding = externalAgentBindingSchema.parse({
  label: "OpenCode",
  driver: "opencode-exec",
  command: "opencode",
  args: ["run", "--format", "json"],
  promptDelivery: "stdin",
  permissionMode: "auto",
  presetId: "opencode",
});

test("opencode invocation: 无 model 无续接 → run --format json --auto，prompt 只在 stdin", () => {
  const invocation = buildExternalAgentInvocation(opencodeBinding, "干活");
  assert.deepEqual(invocation.args, ["run", "--format", "json", "--auto"]);
  assert.equal(invocation.stdin, "干活");
  assert.equal(invocation.args.includes("干活"), false);
});

test("opencode invocation: 多行 prompt 绝不进 argv（Windows .cmd shim 截断防线）", () => {
  const prompt = "第一行\n第二行\n\n第四行";
  const invocation = buildExternalAgentInvocation(
    { ...opencodeBinding, model: "anthropic/claude", externalSessionId: "ses_123" },
    prompt,
  );
  // prompt 必须整段留在 stdin：cmd.exe 会在第一个换行处截断多行 argv，
  // 且命令行有 8191 字符上限，进 argv 就只剩第一行。
  assert.equal(invocation.stdin, prompt);
  assert.equal(invocation.args.includes(prompt), false);
  for (const line of prompt.split("\n")) {
    assert.equal(invocation.args.includes(line), false);
  }
});

test("opencode invocation: --model 与 --session 的位置固定（续接由用户钉死）", () => {
  const invocation = buildExternalAgentInvocation(
    { ...opencodeBinding, model: "anthropic/claude", externalSessionId: "ses_123" },
    "继续",
  );
  assert.deepEqual(invocation.args, [
    "run",
    "--format",
    "json",
    "--auto",
    "--model",
    "anthropic/claude",
    "--session",
    "ses_123",
  ]);
  assert.equal(invocation.stdin, "继续");
  // 与 claude-family 同语义：模型传 fresh 也不打断"一直续接"。
  const fresh = buildExternalAgentInvocation(
    { ...opencodeBinding, externalSessionId: "ses_123" },
    "新任务",
    { continuation: "fresh" },
  );
  assert.deepEqual(fresh.args.slice(-2), ["--session", "ses_123"]);
});

test("opencode invocation: 无 externalSessionId 时不带 --session（新会话）", () => {
  const invocation = buildExternalAgentInvocation(opencodeBinding, "新任务");
  assert.equal(invocation.args.includes("--session"), false);
});

test("opencode invocation: 档位拼成 --model 的 #variant 后缀（不是独立 flag）", () => {
  const model = "opencode/deepseek-v4.1-flash-free";
  const invocation = buildExternalAgentInvocation(
    { ...opencodeBinding, model, effortsByModel: { [model]: "high" } },
    "干活",
  );
  // 档位是模型串的一部分：单独 push 一个 "#high" 会被当成位置参数（prompt 片段），
  // CLI 不报错但档位静默失效——这是与 claude-family 最大的形状差异。
  assert.deepEqual(invocation.args, [
    "run",
    "--format",
    "json",
    "--auto",
    "--model",
    `${model}#high`,
  ]);
  assert.equal(invocation.args.includes("#high"), false);
});

test("opencode invocation: 该模型没记录档位 → 模型串不带 #（用 CLI 默认档）", () => {
  const model = "opencode/big-pickle";
  const invocation = buildExternalAgentInvocation(
    // 别的模型的档位不能串到当前模型上：档位是模型的能力。
    { ...opencodeBinding, model, effortsByModel: { "opencode/beam-free": "medium" } },
    "干活",
  );
  assert.deepEqual(invocation.args.slice(-2), ["--model", model]);
});

test("opencode invocation: 换模型时档位按各自模型的键取，互不串档", () => {
  const binding = {
    ...opencodeBinding,
    effortsByModel: { "opencode/beam-free": "medium", "opencode/big-pickle": "max" },
  };
  const beam = buildExternalAgentInvocation({ ...binding, model: "opencode/beam-free" }, "a");
  const pickle = buildExternalAgentInvocation({ ...binding, model: "opencode/big-pickle" }, "b");
  assert.deepEqual(beam.args.slice(-2), ["--model", "opencode/beam-free#medium"]);
  assert.deepEqual(pickle.args.slice(-2), ["--model", "opencode/big-pickle#max"]);
});

test("opencode invocation: 预设 argv 跟随代码，老绑定落库的 args 不覆盖 --format json", () => {
  const stale = externalAgentBindingSchema.parse({
    label: "OpenCode",
    driver: "opencode-exec",
    command: "opencode",
    // 假设老绑定落库时没有 --format json（拿不到逐事件过程）。
    args: ["run"],
    promptDelivery: "argv-append",
    presetId: "opencode",
  });
  assert.deepEqual(buildExternalAgentInvocation(stale, "干活").args, [
    "run",
    "--format",
    "json",
    "--auto",
  ]);
});

test("parseOpencodeRunResult: 多段 text 用空行拼接并带回 sessionID", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "第一段" } }),
    JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { tool: "bash" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "第二段" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_1" }),
  ].join("\n");
  assert.deepEqual(parseOpencodeRunResult(stdout), {
    text: "第一段\n\n第二段",
    isError: false,
    sessionId: "ses_1",
  });
});

test("parseOpencodeRunResult: error 行 → isError 且保留错误前的过程正文", () => {
  const stdout = [
    JSON.stringify({ type: "text", sessionID: "ses_2", part: { text: "做到一半" } }),
    JSON.stringify({
      type: "error",
      sessionID: "ses_2",
      error: { message: "provider unauthorized" },
    }),
  ].join("\n");
  assert.deepEqual(parseOpencodeRunResult(stdout), {
    text: "做到一半\n\nprovider unauthorized",
    isError: true,
    sessionId: "ses_2",
  });
});

test("parseOpencodeRunResult: 只有 error 行时正文就是错误信息", () => {
  const stdout = JSON.stringify({ type: "error", error: { message: "boom" } });
  assert.deepEqual(parseOpencodeRunResult(stdout), { text: "boom", isError: true });
});

test("parseOpencodeRunResult: 一条 JSON 都没解析出来 → 原文兜底且不算错误", () => {
  const stdout = "opencode: command failed\nstack trace";
  assert.deepEqual(parseOpencodeRunResult(stdout), { text: stdout, isError: false });
});

test("parseExternalAgentResult: opencode-exec 走 JSONL 解析而不是原文短路", () => {
  const stdout = [
    JSON.stringify({ type: "text", sessionID: "ses_9", part: { text: "改完了" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_9" }),
  ].join("\n");
  assert.deepEqual(parseExternalAgentResult(opencodeBinding, stdout), {
    text: "改完了",
    isError: false,
    sessionId: "ses_9",
  });
});

test("parseOpencodeStreamActivities: text/reasoning/tool 三类条目，其余事件忽略", () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
  const stdout = [
    line({ type: "step_start", sessionID: "s" }),
    line({ type: "reasoning", sessionID: "s", part: { text: "先看目录" } }),
    line({ type: "text", sessionID: "s", part: { text: "好的，我看看" } }),
    line({
      type: "tool_use",
      sessionID: "s",
      part: { tool: "bash", state: { input: { command: "ls src" }, output: "" } },
    }),
    line({ type: "text", sessionID: "s", part: { text: "   " } }),
    line({ type: "retry", sessionID: "s" }),
    line({ type: "step_finish", sessionID: "s" }),
    '截断的半行 {"type":"text"',
  ].join("");
  assert.deepEqual(parseOpencodeStreamActivities(stdout), [
    { kind: "reasoning", text: "先看目录" },
    { kind: "text", text: "好的，我看看" },
    { kind: "tool", text: "bash: ls src" },
  ]);
});

test("opencode stream 解析器：行被切成多段推送也能接上，flush 处理残行", () => {
  const parser = createOpencodeStreamParser();
  const text = JSON.stringify({ type: "text", part: { text: "分段到达" } });
  // 一行 JSON 被切成两次 feed：前半个事件不能产出（字段是残的）。
  assert.deepEqual(parser.push(text.slice(0, 10)), []);
  assert.deepEqual(parser.push(`${text.slice(10)}\n`), [{ kind: "text", text: "分段到达" }]);
  assert.deepEqual(parser.push('{"type":"text","part":{"text":"末尾"}}'), []);
  assert.deepEqual(parser.flush(), [{ kind: "text", text: "末尾" }]);
});

test("opencode tool_use: 入参按 command/file_path/path/pattern/query 顺序取，缺失时退回工具名", () => {
  const parser = createOpencodeStreamParser();
  const feed = (input: unknown) =>
    parser.push(
      `${JSON.stringify({ type: "tool_use", part: { tool: "read", state: { input } } })}\n`,
    );
  assert.deepEqual(feed({ file_path: "src/a.ts", path: "/other" }), [
    { kind: "tool", text: "read: src/a.ts" },
  ]);
  assert.deepEqual(feed({}), [{ kind: "tool", text: "read" }]);
});

test("parseOpencodeStreamActivities: 空输出与纯 step 事件不产出条目", () => {
  assert.deepEqual(parseOpencodeStreamActivities(""), []);
  assert.deepEqual(
    parseOpencodeStreamActivities(`${JSON.stringify({ type: "step_finish" })}\n`),
    [],
  );
});

// ── 真实模型目录（product.json）优先于静态表 ──
// 静态表只有 CLI 级范围；逐模型事实来自 CLI 自带的 product.json。
// 实测：hy4-preview 只支持 high、glm-5.2 只支持 high/xhigh，
// 而 CLI 对不支持的档位**静默接受**——所以候选必须来自真实目录。

test("parseModelCatalogFromProductJson: 解析 supportedEfforts 与 defaultEffort", () => {
  const catalog = parseModelCatalogFromProductJson({
    models: [
      {
        id: "hy4-preview",
        name: "Hy4 preview",
        supportsReasoning: true,
        reasoning: { canDisableThinking: false, defaultEffort: "high", supportedEfforts: ["high"] },
      },
      {
        id: "glm-5.2",
        name: "GLM-5.2",
        reasoning: { defaultEffort: "high", supportedEfforts: ["high", "xhigh"] },
      },
    ],
  });
  assert.deepEqual(
    catalog.map((m) => [m.id, m.supportedEfforts, m.defaultEffort]),
    [
      ["hy4-preview", ["high"], "high"],
      ["glm-5.2", ["high", "xhigh"], "high"],
    ],
  );
});

test("parseModelCatalogFromProductJson: 固定档（只有 effort 没有 supportedEfforts）→ 不可选", () => {
  const catalog = parseModelCatalogFromProductJson({
    models: [{ id: "deepseek-v4.1-flash", name: "DS", reasoning: { effort: "high" } }],
  });
  assert.deepEqual(catalog[0]!.supportedEfforts, []);
  assert.equal(catalog[0]!.defaultEffort, "high");
});

test("parseModelCatalogFromProductJson: 无 reasoning / 畸形输入 → 空结果不抛", () => {
  assert.deepEqual(parseModelCatalogFromProductJson({ models: [{ id: "x", name: "x" }] }), [
    { id: "x", name: "x", supportedEfforts: [] },
  ]);
  assert.deepEqual(parseModelCatalogFromProductJson(null), []);
  assert.deepEqual(parseModelCatalogFromProductJson({}), []);
  assert.deepEqual(parseModelCatalogFromProductJson({ models: "nope" }), []);
});

test("resolveEffortLevels: 真实目录优先于静态表（逐模型不同）", () => {
  const preset = findExternalAgentPreset("codebuddy")!;
  const catalog = [
    { id: "hy4-preview", name: "Hy4", supportedEfforts: ["high"], defaultEffort: "high" },
    { id: "glm-5.2", name: "GLM-5.2", supportedEfforts: ["high", "xhigh"], defaultEffort: "high" },
  ];
  // 两个模型在同一个 CLI 下得到不同候选——这正是静态表给不出的。
  assert.deepEqual(resolveEffortLevels(preset, "hy4-preview", catalog), ["high"]);
  assert.deepEqual(resolveEffortLevels(preset, "glm-5.2", catalog), ["high", "xhigh"]);
  // 目录里没有的模型退回静态表。
  assert.deepEqual(resolveEffortLevels(preset, "unknown", catalog), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("resolveEffortLevels: 固定档回落到 CLI 选择器缺省档（与 EffortPanel 行为一致）", () => {
  const preset = findExternalAgentPreset("codebuddy")!;
  const catalog = [
    { id: "deepseek-v4.1-flash", name: "DS", supportedEfforts: [], defaultEffort: "high" },
  ];
  // codebuddy 的 EffortPanel 对固定档不隐藏入口，而是回落基础档
  // （filterEffortLevelsForPicker 的缺省 ep = low/medium/high/xhigh）。
  assert.deepEqual(resolveEffortLevels(preset, "deepseek-v4.1-flash", catalog), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

// ── 服务端模型缓存（/model 面板的权威来源）──
// product.json 是构建期快照，与登录后的 /model 列表对不上（实测差 9/13 个、价格过期）；
// 服务端缓存里 deepseek-v4.1-flash 直接带 supportedEfforts: [low,high,max]，与截图一致。

test("parseServerModelCache: 兼容用户数组与单个 data 对象两种输入", () => {
  const models = [
    { id: "hy3", name: "Hy3", reasoning: { effort: "high" } },
    {
      id: "deepseek-v4.1-flash",
      name: "DS",
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "max"] },
    },
  ];
  const users = [
    {
      userId: "u1",
      ts: 1,
      data: { models, agents: [{ name: "cli", models: ["hy3", "deepseek-v4.1-flash"] }] },
    },
  ];
  const fromArray = parseServerModelCache(users);
  const fromData = parseServerModelCache({
    models,
    agents: [{ name: "cli", models: ["hy3", "deepseek-v4.1-flash"] }],
  });
  assert.deepEqual(fromArray, fromData);
  assert.equal(fromArray.length, 2);
  assert.deepEqual(fromArray[1]!.supportedEfforts, ["low", "high", "max"]);
  // hy3 服务端没给 supportedEfforts → 固定档（空；调用方回落缺省档）。
  assert.deepEqual(fromArray[0]!.supportedEfforts, []);
});

test("parseServerModelCache: 只取 cli agent 的模型清单（正是 /model 显示的集合）", () => {
  const raw = [
    {
      ts: 5,
      data: {
        models: [
          { id: "a", name: "A", reasoning: { effort: "high" } },
          { id: "b", name: "B", reasoning: { effort: "high" } },
          { id: "c", name: "C", reasoning: { effort: "high" } },
        ],
        agents: [
          { name: "other", models: ["a"] },
          { name: "cli", models: ["b", "c"] },
        ],
      },
    },
  ];
  assert.deepEqual(
    parseServerModelCache(raw).map((m) => m.id),
    ["b", "c"],
  );
});

test("parseServerModelCache: 多用户缓存取 ts 最新；畸形输入返回空", () => {
  const mk = (id: string) => ({ id, name: id, reasoning: { effort: "high" } });
  const raw = [
    {
      userId: "old",
      ts: 1,
      data: { models: [mk("old-model")], agents: [{ name: "cli", models: ["old-model"] }] },
    },
    {
      userId: "new",
      ts: 9,
      data: { models: [mk("new-model")], agents: [{ name: "cli", models: ["new-model"] }] },
    },
  ];
  assert.deepEqual(
    parseServerModelCache(raw).map((m) => m.id),
    ["new-model"],
  );
  assert.deepEqual(parseServerModelCache(null), []);
  assert.deepEqual(parseServerModelCache({ models: [] }), []);
  // agent 清单里有、目录里没有 → 占位保留（UI 能显示）。
  const withMissing = parseServerModelCache({
    models: [mk("a")],
    agents: [{ name: "cli", models: ["a", "ghost"] }],
  });
  assert.deepEqual(
    withMissing.map((m) => m.id),
    ["a", "ghost"],
  );
  assert.deepEqual(withMissing[1]!.supportedEfforts, []);
});

test("parseExternalAgentResult: codebuddy 消息数组取 result 条目正文", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
  });
  // 实测形状：数组里 message/file-history-snapshot/... 混杂，最后一条 type=result。
  const stdout = JSON.stringify([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] },
    { type: "result", subtype: "success", is_error: false, result: "你好" },
  ]);
  assert.deepEqual(parseExternalAgentResult(binding, stdout), { text: "你好", isError: false });
});

test("parseExternalAgentResult: result 为空时回退最后一条 assistant 正文", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
  });
  const stdout = JSON.stringify([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "旧回答" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "最终回答" }] },
    { type: "result", subtype: "success", is_error: false, result: "" },
  ]);
  assert.deepEqual(parseExternalAgentResult(binding, stdout), {
    text: "最终回答",
    isError: false,
  });
});

test("parseExternalAgentResult: 非 JSON / 非数组退回原文，不抛", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
  });
  assert.deepEqual(parseExternalAgentResult(binding, "纯文本回答"), {
    text: "纯文本回答",
    isError: false,
  });
});

test("parseExternalAgentResult: 带回 session_id 供下一轮续接", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
  });
  const stdout = JSON.stringify([
    { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-123" },
  ]);
  assert.deepEqual(parseExternalAgentResult(binding, stdout), {
    text: "ok",
    isError: false,
    sessionId: "sess-123",
  });
});

test("buildExternalAgentInvocation: 续接由用户钉死——有 externalSessionId 时 fresh 也带 -r", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
    externalSessionId: "sess-123",
  });
  const continued = buildExternalAgentInvocation(binding, "继续");
  assert.deepEqual(continued.args.slice(-2), ["-r", "sess-123"]);
  assert.equal(continued.stdin, "继续");
  // 模型传 fresh 也不能打断"一直续接"（实测模型动辄判定任务无关另开新会话）。
  const fresh = buildExternalAgentInvocation(binding, "新任务", { continuation: "fresh" });
  assert.deepEqual(fresh.args.slice(-2), ["-r", "sess-123"]);
  assert.equal(fresh.stdin, "新任务");
});

test("buildExternalAgentInvocation: 不续接（无 externalSessionId）时不带 -r", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "argv-append",
  });
  const invocation = buildExternalAgentInvocation(binding, "新任务");
  assert.ok(!invocation.args.includes("-r"));
  assert.equal(invocation.stdin, "新任务");
});

test("stream 解析器：正文/思考只取完整 assistant 消息，delta 不产出条目", () => {
  const parser = createClaudeStreamParser();
  const delta = (type: string, payload: Record<string, string>) =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type, ...payload } },
    });
  // 增量不产出：执行端的进度是滚动尾窗快照，用它拼正文会重复/丢段。
  assert.deepEqual(parser.push(`${delta("thinking_delta", { thinking: "先看目录" })}\n`), []);
  assert.deepEqual(parser.push(`${delta("text_delta", { text: "好的，" })}\n`), []);
  // 思考块开始保留为"正在思考"标记。
  const thinkingStart = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "thinking" } },
  });
  assert.deepEqual(parser.push(`${thinkingStart}\n`), [{ kind: "reasoning", text: "" }]);
  // 完整消息是唯一权威来源：思考/正文/工具都从它出。
  const full = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看目录" },
        { type: "text", text: "好的，我看看" },
        { type: "tool_use", name: "Bash", input: { command: "ls src" } },
      ],
    },
  });
  assert.deepEqual(parser.push(`${full}\n`), [
    { kind: "reasoning", text: "先看目录" },
    { kind: "text", text: "好的，我看看" },
    { kind: "tool", text: "Bash: ls src" },
  ]);
  // 半行留缓冲，flush 时再尝试。
  assert.deepEqual(parser.push('{"type":"assistant"'), []);
  assert.deepEqual(parser.flush(), []);
});

test("stream 解析器：全量重解析给收口权威重建用", () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
  const stdout = [
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "第一段" }] },
    }),
    line({ type: "stream_event", event: { type: "content_block_delta" } }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
      },
    }),
    '截断的半行 {"type":"assistant"',
  ].join("");
  assert.deepEqual(parseClaudeFamilyStreamActivities(stdout), [
    { kind: "text", text: "第一段" },
    { kind: "tool", text: "Bash: ls" },
  ]);
});
