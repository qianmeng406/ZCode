import assert from "node:assert/strict";
import test from "node:test";
import {
  CLI_PICKER_DEFAULT_EFFORTS,
  EXTERNAL_AGENT_BINDABLE_PRESETS,
  EXTERNAL_AGENT_PRESETS,
  findExternalAgentPreset,
  isChannelReadyPreset,
  readChannelBlockedReason,
  resolveChannelCandidates,
  resolveExploreChannelCandidates,
  parseCommandCodeModelCatalog,
  parseCommandCodeModelList,
  parseModelCatalogFromProductJson,
  parseModelListFromHelp,
  parseServerModelCache,
  resolveEffortLevels,
  resolveExternalAgentSessionHomeDir,
  resolveContextWindowLevels,
} from "../src/externalAgentCatalog.js";
import {
  createClaudeStreamParser,
  createCommandCodeStreamParser,
  createOpencodeStreamParser,
  parseClaudeFamilyStreamActivities,
  parseCommandCodeStreamActivities,
  parseOpencodeStreamActivities,
} from "../src/externalAgentStream.js";
import {
  buildExternalAgentInvocation,
  externalAgentBindingSchema,
  parseCommandCodeResult,
  parseExternalAgentResult,
  parseOpencodeRunResult,
  readModelContextWindow,
  readModelEffort,
  withModelContextWindow,
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
    ["codebuddy", "opencode", "qodercli-cn", "qodercli", "commandcode"],
  );
  // 目录里不删它们：老绑定还要靠 findExternalAgentPreset 回显 label 与调用参数。
  for (const id of ["claude-code", "codex"]) {
    const preset = findExternalAgentPreset(id);
    assert.ok(preset);
    assert.equal(preset.adaptation, "partial");
  }
});

test("qodercli-cn 预设：claude-family 同构 + 预设级覆盖项", () => {
  // 2026-11-09 本机实测（qoderclicn 1.1.32）：stream-json 输出与 claude-family
  // 逐字段同构，差异全部收敛在预设字段里。
  const preset = findExternalAgentPreset("qodercli-cn")!;
  assert.equal(preset.driver, "claude-family");
  assert.equal(preset.adaptation, "full");
  assert.equal(preset.command, "qoderclicn");
  assert.deepEqual(preset.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ]);
  // 权限档位值用下划线（不是 claude 的驼峰）。
  assert.equal(preset.permissionMode, "bypass_permissions");
  // 档位 flag 不同名：传 --effort 会被静默吞掉。
  assert.equal(preset.effortFlag, "--reasoning-effort");
  // 逐模型档位来自 CLI /model + /effort 面板枚举（1.1.85）：集合各不相同，
  // 不能拿 CLI 级值域套所有模型。
  assert.deepEqual(resolveEffortLevels(preset, "Qwen3.8-Max"), [
    "none",
    "low",
    "medium",
    "xhigh",
    "ultracode",
  ]);
  assert.deepEqual(resolveEffortLevels(preset, "DeepSeek-V4-Pro"), ["none", "high", "max"]);
  assert.deepEqual(resolveEffortLevels(preset, "MiniMax-M3.1-Flash"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  // 元模型（Auto/Fast）与未知模型都没有档位入口。
  assert.deepEqual(resolveEffortLevels(preset, "Auto"), []);
  assert.deepEqual(resolveEffortLevels(preset, undefined), []);
  assert.deepEqual(resolveEffortLevels(preset, "brand-new-model"), []);
  // 会话落盘在 ~/.qoder-cn（CN CLI 的 config root，与 IDE 的 ~/.qoder 是两棵树）。
  assert.equal(preset.sessionHomeDir, ".qoder-cn");
  assert.equal(resolveExternalAgentSessionHomeDir("qodercli-cn"), ".qoder-cn");
  // 老预设不带字段时保持既有事实：.codebuddy。
  assert.equal(resolveExternalAgentSessionHomeDir("codebuddy"), ".codebuddy");
  assert.equal(resolveExternalAgentSessionHomeDir(undefined), ".codebuddy");
});

test("qodercli 预设：国际版与 CN 版是两份独立预设", () => {
  // 2026-11-10 本机实测（qodercli 1.1.86）：同一 CLI 代码，但 config root、
  // project slug、模型集合都不同，必须分两份预设。
  const intl = findExternalAgentPreset("qodercli")!;
  const cn = findExternalAgentPreset("qodercli-cn")!;
  assert.equal(intl.label, "Qoder CLI");
  assert.equal(intl.command, "qodercli");
  assert.equal(intl.adaptation, "full");
  assert.equal(intl.driver, "claude-family");
  assert.equal(intl.effortFlag, "--reasoning-effort");
  assert.equal(intl.permissionMode, "bypass_permissions");
  // 国际版 config root 是 ~/.qoder；CN 是 ~/.qoder-cn。
  assert.equal(intl.sessionHomeDir, ".qoder");
  assert.equal(cn.sessionHomeDir, ".qoder-cn");
  assert.equal(resolveExternalAgentSessionHomeDir("qodercli"), ".qoder");
  // projects 目录名两个版本都是 qoder 规则（C:\x → C--x）。
  assert.equal(intl.projectDirSlug, "qoder");
  assert.equal(cn.projectDirSlug, "qoder");
  // 逐模型档位（/model + /effort 面板枚举）：国际版多出 Ultimate/Sonus/Cantus。
  assert.deepEqual(resolveEffortLevels(intl, "Ultimate"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  assert.deepEqual(resolveEffortLevels(intl, "Sonus"), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  assert.deepEqual(resolveEffortLevels(intl, "Qwen3.8-Max"), [
    "none",
    "low",
    "medium",
    "xhigh",
    "ultracode",
  ]);
  assert.deepEqual(resolveEffortLevels(intl, "DeepSeek-V4-Pro"), ["none", "high", "max"]);
  // 元模型没有档位入口。
  assert.deepEqual(resolveEffortLevels(intl, "Auto"), []);
  assert.deepEqual(resolveEffortLevels(intl, "Fast"), []);
  assert.deepEqual(resolveEffortLevels(intl, "Efficient"), []);
});

test("qodercli-cn 绑定的调用形状：档位 flag、权限值、stdin 与续接", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "Qoder CLI CN",
    driver: "claude-family",
    command: "qoderclicn",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    presetId: "qodercli-cn",
    model: "Qwen3.8-Max",
    effortsByModel: { "Qwen3.8-Max": "xhigh" },
    contextWindowByModel: { "Qwen3.8-Max": 1000000 },
    externalSessionId: "abc-123",
  });
  const invocation = buildExternalAgentInvocation(binding, "任务书");
  // 预设 argv 跟随代码；档位用预设声明的 --reasoning-effort（--effort 会被静默吞掉）。
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    "Qwen3.8-Max",
    "--reasoning-effort",
    "xhigh",
    "--context-window",
    "1000000",
    "--permission-mode",
    "bypass_permissions",
    "-r",
    "abc-123",
  ]);
  // prompt 走 stdin（claude-family 分支固定）。
  assert.equal(invocation.stdin, "任务书");
});

test("qoder 预设：上下文窗口逐模型候选（200K/400K/1M，token 数）", () => {
  // 2026-11-10 用 CLI 的 /model 面板 space→context 逐模型枚举：
  // 两个 qoder 版本的全部模型都是这三层（Step-5-Preview 未能选中，按兜底）。
  for (const id of ["qodercli", "qodercli-cn"]) {
    const preset = findExternalAgentPreset(id)!;
    assert.equal(preset.contextWindowFlag, "--context-window");
    assert.deepEqual(resolveContextWindowLevels(preset, "Qwen3.8-Max"), [200000, 400000, 1000000]);
    assert.deepEqual(resolveContextWindowLevels(preset, undefined), [200000, 400000, 1000000]);
  }
  // 非 qoder 预设不提供上下文窗口入口。
  const codebuddy = findExternalAgentPreset("codebuddy")!;
  assert.equal(codebuddy.contextWindowFlag, undefined);
  assert.deepEqual(resolveContextWindowLevels(codebuddy, "hy3"), []);
});

test("withModelContextWindow/readModelContextWindow：窗口按模型分开记", () => {
  const base = externalAgentBindingSchema.parse({
    label: "Qoder CLI",
    driver: "claude-family",
    command: "qodercli",
    args: [],
    promptDelivery: "stdin",
    presetId: "qodercli",
    model: "Qwen3.8-Max",
  });
  const withWindow = withModelContextWindow(base, "Qwen3.8-Max", 400000);
  assert.equal(readModelContextWindow(withWindow, "Qwen3.8-Max"), 400000);
  // 另一个模型不受影响。
  assert.equal(readModelContextWindow(withWindow, "DeepSeek-Flash"), undefined);
  // null 清除该键。
  const cleared = withModelContextWindow(withWindow, "Qwen3.8-Max", null);
  assert.equal(readModelContextWindow(cleared, "Qwen3.8-Max"), undefined);
  // 非整数/非正数不接受。
  const invalid = withModelContextWindow(base, "Qwen3.8-Max", 0);
  assert.equal(readModelContextWindow(invalid, "Qwen3.8-Max"), undefined);
});

test("未声明 contextWindowFlag 的预设不产出 --context-window", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "stream-json"],
    promptDelivery: "stdin",
    presetId: "codebuddy",
    model: "hy3",
    contextWindowByModel: { hy3: 400000 },
  });
  const invocation = buildExternalAgentInvocation(binding, "x");
  assert.ok(!invocation.args.includes("--context-window"));
});

test("commandcode 预设：headless NDJSON + 目录缓存 + 会话落盘", () => {
  // 2026-11-09 实测 command-code 1.88.5：`-p --output-format json` 是 NDJSON，
  // 模型目录与逐模型档位在 CLI 自己拉取的服务端缓存里。
  const preset = findExternalAgentPreset("commandcode")!;
  assert.equal(preset.driver, "commandcode-exec");
  assert.equal(preset.adaptation, "full");
  // Windows 上 cmd 是系统 shell，必须用全名（或 cmdc）。
  assert.equal(preset.command, "command-code");
  assert.deepEqual(preset.args, ["-p", "--output-format", "json", "--trust", "--skip-onboarding"]);
  assert.equal(preset.promptDelivery, "stdin");
  // headless 解除写文件/执行 shell 限制的开关是 --yolo（invocation 翻译）。
  assert.equal(preset.permissionMode, "yolo");
  assert.equal(preset.modelSource, "catalog-cache");
  assert.equal(preset.effortDelivery, "flag");
  assert.equal(preset.effortFlag, "--effort");
  assert.equal(preset.sessionHomeDir, ".commandcode");
  assert.equal(resolveExternalAgentSessionHomeDir("commandcode"), ".commandcode");

  // 探测不可用时不提供档位入口（不能套 CLI 级 low..max 表）。
  assert.deepEqual(resolveEffortLevels(preset, "deepseek/deepseek-v4.1-flash"), []);
  assert.deepEqual(
    resolveEffortLevels(preset, "deepseek/deepseek-v4.1-flash", [
      {
        id: "deepseek/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        supportedEfforts: ["off", "low", "high", "max"],
      },
    ]),
    ["off", "low", "high", "max"],
  );
  // 缓存目录里没有 reasoningEfforts 的模型：空候选 = 没有档位入口（与 opencode 同）。
  assert.deepEqual(
    resolveEffortLevels(preset, "moonshotai/Kimi-K2.7-Code", [
      { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", supportedEfforts: [] },
    ]),
    [],
  );
});

test("commandcode 绑定的调用形状：--yolo、模型/档位、-r 与 stdin", () => {
  const preset = findExternalAgentPreset("commandcode")!;
  const binding = externalAgentBindingSchema.parse({
    label: "Command Code",
    driver: "commandcode-exec",
    command: preset.command,
    args: [...preset.args],
    promptDelivery: "stdin",
    presetId: preset.id,
    model: "deepseek/deepseek-v4.1-flash",
    effortsByModel: { "deepseek/deepseek-v4.1-flash": "high" },
    externalSessionId: "sess-1",
  });
  const invocation = buildExternalAgentInvocation(binding, "任务书");
  assert.equal(invocation.command, "command-code");
  assert.deepEqual(invocation.args, [
    "-p",
    "--output-format",
    "json",
    "--trust",
    "--skip-onboarding",
    "--model",
    "deepseek/deepseek-v4.1-flash",
    "--effort",
    "high",
    "--yolo",
    "-r",
    "sess-1",
  ]);
  // prompt 走 stdin（多行与 Windows 命令行长度的共同防线）。
  assert.equal(invocation.stdin, "任务书");
});

test("commandcode 结果解析：result 帧的 finalText / subtype / sessionId", () => {
  const success = [
    JSON.stringify({ type: "event", event: { type: "text_delta", delta: "过程" } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      sessionId: "sess-9",
      finalText: "完成",
    }),
  ].join("\n");
  assert.deepEqual(parseCommandCodeResult(success), {
    text: "完成",
    isError: false,
    sessionId: "sess-9",
  });
  // 失败结果：finalText 为空时退回 error 文本。
  assert.deepEqual(
    parseCommandCodeResult(JSON.stringify({ type: "result", subtype: "error", error: "额度不足" })),
    { text: "额度不足", isError: true },
  );
  // max_turns 也是没跑完。
  assert.deepEqual(
    parseCommandCodeResult(
      JSON.stringify({ type: "result", subtype: "max_turns", finalText: "半截" }),
    ),
    { text: "半截", isError: true },
  );
  // 没有 result 帧：原文兜底，不能吞成空报告。
  assert.deepEqual(parseCommandCodeResult("plain output"), {
    text: "plain output",
    isError: false,
  });

  // 绑定层分流：commandcode-exec 走上面的解析，而不是原文短路。
  const binding = externalAgentBindingSchema.parse({
    label: "Command Code",
    driver: "commandcode-exec",
    command: "command-code",
    promptDelivery: "stdin",
    presetId: "commandcode",
  });
  assert.equal(parseExternalAgentResult(binding, success).text, "完成");
});

test("parseCommandCodeStreamActivities: delta 累积到边界，tool_running 产出工具", () => {
  const stdout = [
    { type: "event", event: { type: "thinking_delta", delta: "想" } },
    { type: "event", event: { type: "thinking_end", text: "想清楚了" } },
    { type: "event", event: { type: "text_delta", delta: "先" } },
    { type: "event", event: { type: "text_delta", delta: "说" } },
    { type: "event", event: { type: "tool_running", toolName: "bash", description: "ls -la" } },
    { type: "event", event: { type: "text_delta", delta: "结果" } },
    { type: "result", subtype: "success", finalText: "结果" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(parseCommandCodeStreamActivities(stdout), [
    { kind: "reasoning", text: "想清楚了" },
    { kind: "text", text: "先说" },
    { kind: "tool", text: "bash: ls -la" },
    { kind: "text", text: "结果" },
  ]);
});

test("commandcode 流解析：半行 JSON 留缓冲，flush 时产出", () => {
  const parser = createCommandCodeStreamParser();
  const line = JSON.stringify({
    type: "event",
    event: { type: "text_delta", delta: "你好" },
  });
  assert.deepEqual(parser.push(line.slice(0, 12)), []);
  assert.deepEqual(parser.push(`${line.slice(12)}\n`), []);
  assert.deepEqual(parser.flush(), [{ kind: "text", text: "你好" }]);
  // 空输出不产出。
  assert.deepEqual(parseCommandCodeStreamActivities(""), []);
});

test("parseCommandCodeModelCatalog: 读缓存 body.data 的逐模型档位并按 order 排序", () => {
  const raw = {
    body: {
      data: [
        {
          id: "moonshotai/Kimi-K3.1-Pro",
          name: "Kimi K3.1 Pro",
          display: { label: "Kimi K3.1 Pro", order: 2 },
          reasoningEfforts: ["low", "high", "max"],
        },
        {
          id: "moonshotai/Kimi-K2.7-Code",
          name: "Kimi K2.7 Code",
          display: { label: "Kimi K2.7 Code", order: 1 },
          // 没有 reasoningEfforts 的模型保持空候选。
        },
        {
          id: "hidden/model",
          name: "Hidden",
          hidden: true,
          display: { label: "Hidden", order: 0 },
          reasoningEfforts: ["low"],
        },
      ],
    },
  };
  assert.deepEqual(parseCommandCodeModelCatalog(raw), [
    { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", supportedEfforts: [] },
    {
      id: "moonshotai/Kimi-K3.1-Pro",
      name: "Kimi K3.1 Pro",
      supportedEfforts: ["low", "high", "max"],
    },
  ]);
  assert.deepEqual(parseCommandCodeModelCatalog(null), []);
  assert.deepEqual(parseCommandCodeModelCatalog({ body: { data: "nope" } }), []);
});

test("parseCommandCodeModelList: 从人类可读表格取 id，跳过标题与分组", () => {
  const stdout = [
    "Available models  ·  96 models",
    "",
    "Open Source",
    "",
    "deepseek/deepseek-v4-pro                hybrid-attention long-context reasoning",
    "MiniMaxAI/MiniMax-M3                    frontier coding",
    "",
    "Anthropic",
    "claude-sonnet-5-5                       best combo of speed & intelligence",
  ].join("\n");
  assert.deepEqual(parseCommandCodeModelList(stdout), [
    "deepseek/deepseek-v4-pro",
    "MiniMaxAI/MiniMax-M3",
    "claude-sonnet-5-5",
  ]);
  assert.deepEqual(parseCommandCodeModelList(""), []);
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

test("parseExternalAgentResult: 只有裸 error 事件时必须报失败（失效 -r 不许静默成功）", () => {
  // 2026-11-12 实测 codebuddy：`-r <已失效 id>` 只发这一行、**不发 result**，
  // 退出码还是 0。以前这里退回"原文当正文 + isError:false"，子智能体卡片显示
  // "已完成"、正文是一行原始 JSON，而任务一行都没跑。
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    presetId: "codebuddy",
  });
  const stdout = `${JSON.stringify({
    type: "error",
    error: "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
  })}\n`;
  assert.deepEqual(parseExternalAgentResult(binding, stdout), {
    text: "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
    isError: true,
  });
});

test("parseExternalAgentResult: 裸 error 与后续 result 并存时以 result 为准", () => {
  // CLI 可能先报一条可恢复的 error 警告、再正常收口。只有"完全没有 result"
  // 才按失败处理，否则会把成功的执行误判成失败。
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    presetId: "codebuddy",
  });
  const stdout = [
    JSON.stringify({ type: "error", error: "transient retry" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "完成" }),
    "",
  ].join("\n");
  assert.deepEqual(parseExternalAgentResult(binding, stdout), {
    text: "完成",
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

// ── S7：内置身份执行渠道（D5 逐 CLI 适配 + Explore 只读映射）──

test("渠道候选：逐 CLI 开启（codebuddy + qoderclicn + commandcode + opencode），四家都能承接 Explore", () => {
  // 候选清单是"哪些 CLI 已过完 §3.7 清单"的用户可见投影，所以这里用精确列表钉死：
  // 新增一个开启项必须同时改这里（= 提醒填实测记录），而不是让测试自动跟着变。
  const channel = resolveChannelCandidates();
  // 顺序 = 目录里 EXTERNAL_AGENT_PRESETS 的声明顺序（opencode 在 qoder 之前）。
  assert.deepEqual(
    channel.map((preset) => preset.id),
    ["codebuddy", "opencode", "qodercli-cn", "commandcode"],
  );
  const explore = resolveExploreChannelCandidates();
  assert.deepEqual(
    explore.map((preset) => preset.id),
    ["codebuddy", "opencode", "qodercli-cn", "commandcode"],
  );
  // 只读档位值因 CLI 而异，全部来自 preset 声明、不许写死。
  assert.equal(findExternalAgentPreset("codebuddy")?.readOnlyPermissionMode, "plan");
  assert.equal(findExternalAgentPreset("qodercli-cn")?.readOnlyPermissionMode, "dont_ask");
  assert.equal(findExternalAgentPreset("commandcode")?.readOnlyPermissionMode, "plan");
  assert.equal(findExternalAgentPreset("opencode")?.readOnlyPermissionMode, "plan");
});

test("opencode 的只读是 Plan **agent**，经 --agent 传而不是 --permission-mode", () => {
  // 实测（2026-11-12）：opencode 没有任何只读 permission mode——不加 --auto 也照样
  // 写文件、跑 shell、删目录、执行 npm install。它的只读形态是 Plan agent：
  // `--agent plan` 下写/删/npm install/git init/-e 绕过全部被拒，读与 grep 照常。
  const explore = externalAgentBindingSchema.parse({
    label: "OpenCode",
    driver: "opencode-exec",
    command: "opencode",
    args: ["run", "--format", "json"],
    promptDelivery: "stdin",
    presetId: "opencode",
    permissionMode: "auto",
    permissionModeOverride: "plan",
  });
  const { args } = buildExternalAgentInvocation(explore, "检索任务");
  assert.equal(args.includes("--auto"), false, "只读身份不得解锁");
  assert.equal(args.includes("--permission-mode"), false, "opencode 不认 permission-mode");
  const agentIndex = args.indexOf("--agent");
  assert.ok(agentIndex >= 0, "只读必须以 --agent 传给 opencode");
  assert.equal(args[agentIndex + 1], "plan");
});

test("opencode 执行型身份仍是 --auto", () => {
  const general = externalAgentBindingSchema.parse({
    label: "OpenCode",
    driver: "opencode-exec",
    command: "opencode",
    args: ["run", "--format", "json"],
    promptDelivery: "stdin",
    presetId: "opencode",
    permissionMode: "auto",
  });
  const { args } = buildExternalAgentInvocation(general, "执行任务");
  assert.ok(args.includes("--auto"));
  assert.equal(args.includes("--agent"), false);
});

test("渠道候选：未过清单的 CLI 不出现，且 qodercli 带出显式阻塞原因", () => {
  // qodercli 国际版：已评估但**未完成**——真实任务长期卡在服务端 p4 队列
  // （三模型 6min+ 无响应），§3.7 第 1 项「运行」拿不到实测证据。
  // 用显式 false + blockedBy 表达"结论"而不是"疏漏"。
  const ids = resolveChannelCandidates().map((preset) => preset.id);
  assert.equal(ids.includes("qodercli"), false);
  assert.equal(isChannelReadyPreset("qodercli"), false);
  const preset = findExternalAgentPreset("qodercli");
  assert.equal(preset?.subagentChannelReady, false);
  assert.match(preset?.subagentChannelBlockedBy ?? "", /队列/);
  // 它没有声明只读档位（虽然本地已确认 dont_ask 可用，但运行证据缺失时不承诺）。
  assert.equal(preset?.readOnlyPermissionMode, undefined);
});

test("显式 false 与字段缺席在行为上完全等价（只差可读性）", () => {
  // 这条钉住语义：`=== true` 的严格判定保证两者都不进候选。若将来有人把判断
  // 改成 `!== false`，显式 false 会突然变成"可用"，测试立刻红。
  assert.equal(isChannelReadyPreset("qodercli"), false); // 显式 false
  assert.equal(isChannelReadyPreset("claude-code"), false); // 字段缺席
  assert.equal(resolveChannelCandidates().includes(findExternalAgentPreset("qodercli")!), false);
  assert.equal(resolveChannelCandidates().includes(findExternalAgentPreset("claude-code")!), false);
});

test("readChannelBlockedReason：只对未就绪且登记了原因的 preset 返回内容", () => {
  // 已就绪 → undefined（没问题要报）。
  assert.equal(readChannelBlockedReason("codebuddy"), undefined);
  assert.equal(readChannelBlockedReason("opencode"), undefined);
  // 未就绪且登记了原因 → 返回人话原因。
  assert.match(readChannelBlockedReason("qodercli") ?? "", /队列|运行/);
  // 未就绪但没登记（还没评估）→ undefined，不编造原因。
  assert.equal(readChannelBlockedReason("claude-code"), undefined);
  assert.equal(readChannelBlockedReason("no-such-cli"), undefined);
  assert.equal(readChannelBlockedReason(undefined), undefined);
});

test("isChannelReadyPreset：未标记/未知 preset 一律 false（fail-closed）", () => {
  assert.equal(isChannelReadyPreset("codebuddy"), true);
  // qodercli（国际版）与 codex/claude-code 未过 §3.7 清单，一律不可开启。
  assert.equal(isChannelReadyPreset("qodercli"), false);
  assert.equal(isChannelReadyPreset("claude-code"), false);
  assert.equal(isChannelReadyPreset("no-such-cli"), false);
  assert.equal(isChannelReadyPreset(undefined), false);
});

test("permissionModeOverride 压过预设值（Explore 只读 plan）", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    presetId: "codebuddy",
    permissionMode: "bypassPermissions",
    permissionModeOverride: "plan",
  });
  const invocation = buildExternalAgentInvocation(binding, "检索任务");
  const modeIndex = invocation.args.indexOf("--permission-mode");
  assert.ok(modeIndex >= 0, "--permission-mode 应存在");
  assert.equal(invocation.args[modeIndex + 1], "plan");
});

test("override 缺席时既有优先级逐字不变（预设 bypassPermissions 仍生效）", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "CodeBuddy",
    driver: "claude-family",
    command: "codebuddy",
    args: ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    promptDelivery: "stdin",
    presetId: "codebuddy",
    permissionMode: "bypassPermissions",
  });
  const invocation = buildExternalAgentInvocation(binding, "执行任务");
  const modeIndex = invocation.args.indexOf("--permission-mode");
  assert.ok(modeIndex >= 0);
  assert.equal(invocation.args[modeIndex + 1], "bypassPermissions");
});

test("commandcode override 必须显式传 --permission-mode（只不加 --yolo 不是只读）", () => {
  // 2026-11-12 实测：commandcode headless 不传 --yolo 时，write_file 与
  // shell_command 确实被拒，但 **powershell 工具完全放行**——New-Item、Remove-Item
  // 都成功。所以"没解锁"仍是可写可删；只有显式 `--permission-mode plan` 才能把
  // 四条写入路子全拦住（同时读文件/搜索照常）。
  const binding = externalAgentBindingSchema.parse({
    label: "Command Code",
    driver: "commandcode-exec",
    command: "command-code",
    args: ["-p", "--output-format", "json", "--trust", "--skip-onboarding"],
    promptDelivery: "stdin",
    presetId: "commandcode",
    permissionMode: "yolo",
    permissionModeOverride: "plan",
  });
  const { args } = buildExternalAgentInvocation(binding, "检索任务");
  assert.equal(args.includes("--yolo"), false, "override 生效时不得解锁");
  const modeIndex = args.indexOf("--permission-mode");
  assert.ok(modeIndex >= 0, "override 必须以 --permission-mode 传给 CLI");
  assert.equal(args[modeIndex + 1], "plan");
});

test("commandcode 无 override 时仍是 --yolo（执行型渠道语义不变）", () => {
  const binding = externalAgentBindingSchema.parse({
    label: "Command Code",
    driver: "commandcode-exec",
    command: "command-code",
    args: ["-p", "--output-format", "json", "--trust", "--skip-onboarding"],
    promptDelivery: "stdin",
    presetId: "commandcode",
    permissionMode: "yolo",
  });
  const { args } = buildExternalAgentInvocation(binding, "执行任务");
  assert.ok(args.includes("--yolo"));
  assert.equal(args.includes("--permission-mode"), false);
});
