// 外部 backend（backend: external）在设置页读写链路上的行为。
//
// 覆盖三件事：
// 1. services parser 能读出外部字段（S6 前读了就丢，列表/表单全瞎）；
// 2. serializer 往返保留外部字段（S6 前保存即静默降级为 native 的真实缺陷）；
// 3. createAgent/updateAgent 的保存校验与落盘结果（坏 preset 挡在写盘前）。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SubAgentConfig } from "@zcode/shared";
import {
  parseSubagentMarkdown,
  serializeSubagentMarkdown,
} from "../src/subagents/subagentMarkdown.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";
import { resolveSpawnInvocation } from "../src/subagents/externalAgentProbeAdapter.js";

const EXTERNAL_MARKDOWN = [
  "---",
  'name: "cb-runner"',
  'description: "把实现类任务交给 CodeBuddy CLI 执行"',
  "backend: external",
  "preset: codebuddy",
  "model: DeepSeek-V4-Pro",
  "effort: high",
  "contextWindow: 128000",
  "---",
  "你是执行型子智能体。",
].join("\n");

function externalConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
  return {
    name: "cb-runner",
    description: "把实现类任务交给 CodeBuddy CLI 执行",
    systemPrompt: "你是执行型子智能体。",
    color: "yellow",
    backend: "external",
    presetId: "codebuddy",
    externalModel: "DeepSeek-V4-Pro",
    externalEffort: "high",
    externalContextWindow: 128000,
    ...overrides,
  };
}

test("外部 frontmatter 解析出 backend/presetId/model/effort/contextWindow", () => {
  const parsed = parseSubagentMarkdown({
    content: EXTERNAL_MARKDOWN,
    path: "~/.zcode/agents/cb-runner.md",
    scope: "user",
  });
  assert.equal(parsed.diagnostic, undefined);
  assert.equal(parsed.agent?.backend, "external");
  assert.equal(parsed.agent?.presetId, "codebuddy");
  assert.equal(parsed.agent?.externalModel, "DeepSeek-V4-Pro");
  assert.equal(parsed.agent?.externalEffort, "high");
  assert.equal(parsed.agent?.externalContextWindow, 128000);
});

test("外部 profile 的 CLI 模型名不被误解析成 native ModelSelection", () => {
  // opencode 的模型 id 形如 provider/model（anthropic/claude-sonnet-4），
  // 按 native 格式解析会得到一个看似合法实则错误的 ModelSelection。
  const parsed = parseSubagentMarkdown({
    content: EXTERNAL_MARKDOWN.replace(
      "model: DeepSeek-V4-Pro",
      "model: anthropic/claude-sonnet-4",
    ),
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent?.modelSelection, undefined);
  assert.equal(parsed.agent?.externalModel, "anthropic/claude-sonnet-4");
});

test("未知 preset 产生 agent_unknown_external_preset 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: EXTERNAL_MARKDOWN.replace("preset: codebuddy", "preset: no-such-cli"),
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_unknown_external_preset");
});

test("partial 预设产生 agent_external_preset_not_bindable 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: EXTERNAL_MARKDOWN.replace("preset: codebuddy", "preset: claude-code"),
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_external_preset_not_bindable");
});

test("native profile 上写 preset 产生 agent_preset_requires_external_backend 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: '---\nname: "a"\ndescription: "b"\npreset: codebuddy\n---\np\n',
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_preset_requires_external_backend");
});

test("非法 backend 值产生 agent_invalid_backend 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: '---\nname: "a"\ndescription: "b"\nbackend: cloud\n---\np\n',
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_invalid_backend");
});

test("external 缺 preset 产生 agent_missing_required_frontmatter 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: '---\nname: "a"\ndescription: "b"\nbackend: external\n---\np\n',
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_missing_required_frontmatter");
});

test("非法 contextWindow 产生 agent_invalid_context_window 诊断", () => {
  const parsed = parseSubagentMarkdown({
    content: EXTERNAL_MARKDOWN.replace("contextWindow: 128000", "contextWindow: zero"),
    path: "x.md",
    scope: "user",
  });
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.diagnostic?.code, "agent_invalid_context_window");
});

test("外部 config 序列化写出 backend/preset/model/effort/contextWindow", () => {
  const markdown = serializeSubagentMarkdown(externalConfig());
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /backend: external/);
  assert.match(markdown, /preset: codebuddy/);
  assert.match(markdown, /model: DeepSeek-V4-Pro/);
  assert.match(markdown, /effort: high/);
  assert.match(markdown, /contextWindow: 128000/);
  // 外部 profile 上不写 native 选择格式，两种 model 语义互斥。
  assert.doesNotMatch(markdown, /thoughtLevel/);
  assert.doesNotMatch(markdown, /"builtin:/);
});

test("往返：外部 markdown parse→serialize→parse 外部字段不丢（降级 bug 回归）", () => {
  const first = parseSubagentMarkdown({ content: EXTERNAL_MARKDOWN, path: "x.md", scope: "user" });
  assert.ok(first.agent);
  const roundTrip = parseSubagentMarkdown({
    content: serializeSubagentMarkdown({
      name: first.agent.name,
      description: first.agent.description,
      systemPrompt: first.agent.systemPrompt,
      color: first.agent.color,
      backend: first.agent.backend,
      presetId: first.agent.presetId,
      externalModel: first.agent.externalModel,
      externalEffort: first.agent.externalEffort,
      externalContextWindow: first.agent.externalContextWindow,
    }),
    path: "x.md",
    scope: "user",
  });
  assert.equal(roundTrip.diagnostic, undefined);
  assert.equal(roundTrip.agent?.backend, "external");
  assert.equal(roundTrip.agent?.presetId, "codebuddy");
  assert.equal(roundTrip.agent?.externalModel, "DeepSeek-V4-Pro");
  assert.equal(roundTrip.agent?.externalEffort, "high");
  assert.equal(roundTrip.agent?.externalContextWindow, 128000);
});

test("外部→native 转换后文件不再含外部字段", () => {
  const markdown = serializeSubagentMarkdown(externalConfig({ backend: undefined }));
  assert.doesNotMatch(markdown, /backend:/);
  assert.doesNotMatch(markdown, /preset:/);
  assert.doesNotMatch(markdown, /effort:/);
  assert.doesNotMatch(markdown, /contextWindow:/);
});

test("外部 profile 上保留的 native 专属字段（tools 等）序列化不丢", () => {
  // 用户手写的 tools 对外部不生效（runtime 软警告），但保存端删掉就是数据丢失；
  // 与 mcpServers 既有先例同口径：保留原样。
  const markdown = serializeSubagentMarkdown(
    externalConfig({ tools: ["Read", "Grep"], mcpServers: [{ name: "x" }] }),
  );
  assert.match(markdown, /tools:/);
  assert.match(markdown, /- Read/);
  assert.match(markdown, /mcpServers:/);
});

test("createAgent 落盘外部 profile 且 list 回读带外部字段", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const { agent } = await service.createAgent({
      config: externalConfig(),
      provider: undefined as never,
      scope: "user",
    });
    assert.equal(agent.backend, "external");
    assert.equal(agent.presetId, "codebuddy");

    const filePath = join(home, ".zcode", "agents", "cb-runner.md");
    const onDisk = await readFile(filePath, "utf-8");
    assert.match(onDisk, /backend: external/);
    assert.match(onDisk, /preset: codebuddy/);

    const listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    const found = listed.agents.find((entry) => entry.name === "cb-runner");
    assert.equal(found?.backend, "external");
    assert.equal(found?.presetId, "codebuddy");
    assert.equal(found?.externalModel, "DeepSeek-V4-Pro");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("updateAgent 编辑外部 profile（改描述）不丢 backend/preset（核心回归）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const created = await service.createAgent({
      config: externalConfig(),
      provider: undefined as never,
      scope: "user",
    });
    // 模拟设置页：从 list 回读的完整 AgentSummary 初始化表单，只改描述后保存。
    const summary = created.agent;
    await service.updateAgent({
      agentId: summary.id,
      config: {
        name: summary.name,
        description: "只改了这一句描述",
        systemPrompt: summary.systemPrompt,
        color: summary.color,
        backend: summary.backend,
        presetId: summary.presetId,
        externalModel: summary.externalModel,
        externalEffort: summary.externalEffort,
        externalContextWindow: summary.externalContextWindow,
      },
      oldFilePath: summary.path,
      provider: undefined as never,
      scope: "user",
    });
    const onDisk = await readFile(join(home, ".zcode", "agents", "cb-runner.md"), "utf-8");
    assert.match(onDisk, /backend: external/);
    assert.match(onDisk, /preset: codebuddy/);
    assert.match(onDisk, /model: DeepSeek-V4-Pro/);
    assert.match(onDisk, /只改了这一句描述/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("updateAgent 外部→native 转换写回干净的 native frontmatter", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const created = await service.createAgent({
      config: externalConfig(),
      provider: undefined as never,
      scope: "user",
    });
    await service.updateAgent({
      agentId: created.agent.id,
      config: {
        name: "cb-runner",
        description: "改回原生",
        systemPrompt: "你是原生子智能体。",
        color: "blue",
      },
      oldFilePath: created.agent.path,
      provider: undefined as never,
      scope: "user",
    });
    const onDisk = await readFile(join(home, ".zcode", "agents", "cb-runner.md"), "utf-8");
    assert.doesNotMatch(onDisk, /backend:/);
    assert.doesNotMatch(onDisk, /preset:/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("保存校验：外部 config 缺 presetId / partial preset / 坏窗口均被挡下", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    await assert.rejects(
      service.createAgent({
        config: externalConfig({ presetId: undefined }),
        provider: undefined as never,
        scope: "user",
      }),
      /必须选择预设/,
    );
    await assert.rejects(
      service.createAgent({
        config: externalConfig({ presetId: "no-such-cli" }),
        provider: undefined as never,
        scope: "user",
      }),
      /未知外部 agent 预设/,
    );
    await assert.rejects(
      service.createAgent({
        config: externalConfig({ presetId: "claude-code" }),
        provider: undefined as never,
        scope: "user",
      }),
      /未完整适配/,
    );
    await assert.rejects(
      service.createAgent({
        config: externalConfig({ externalContextWindow: 0 }),
        provider: undefined as never,
        scope: "user",
      }),
      /正整数/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setBuiltInExecutionChannel：写入/清除投影到 list（general-purpose + Explore）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    await service.setBuiltInExecutionChannel({
      agentName: "general-purpose",
      presetId: "codebuddy",
    });
    let listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    let general = listed.agents.find((agent) => agent.name === "general-purpose");
    assert.equal(general?.backend, "external");
    assert.equal(general?.presetId, "codebuddy");
    // 渠道化后 native 模型覆盖被互斥剥离（未设置过覆盖 → 本就 undefined）。

    await service.setBuiltInExecutionChannel({ agentName: "Explore", presetId: "codebuddy" });
    listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    const explore = listed.agents.find((agent) => agent.name === "Explore");
    assert.equal(explore?.backend, "external");
    assert.equal(explore?.presetId, "codebuddy");

    await service.setBuiltInExecutionChannel({ agentName: "general-purpose" });
    listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    general = listed.agents.find((agent) => agent.name === "general-purpose");
    assert.equal(general?.backend, undefined);
    // Explore 未清除，仍保持 external。
    assert.equal(listed.agents.find((agent) => agent.name === "Explore")?.backend, "external");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setBuiltInExecutionChannel fail-closed：未开渠道 preset / Explore 无只读档位 / 探测未安装 / 探测失败均拒绝", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    // claude-code 未过 §3.7 清单（未标 subagentChannelReady）→ 两个身份都拒绝。
    await assert.rejects(
      service.setBuiltInExecutionChannel({ agentName: "general-purpose", presetId: "claude-code" }),
      /未开启执行渠道/,
    );
    await assert.rejects(
      service.setBuiltInExecutionChannel({ agentName: "Explore", presetId: "claude-code" }),
      /未开启执行渠道/,
    );
    // opencode 已开两个身份（只读经 --agent plan），不再适合当"无只读档位"样例；
    // 用一个 subagentChannelReady 为真、但没声明只读的合成场景覆盖那条分支：
    // 直接验证"未声明的 preset 即便过了第一关也在第二关被拒"由 core 的
    // resolveEffectiveChannelPreset 保证（见 core tests），这里只钉 claude-code
    // 这种两道关都没过的情形。

    const probed = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => [
        {
          preset: { id: "codebuddy", label: "CodeBuddy" },
          installed: false,
          models: [],
          modelCatalog: [],
        },
      ],
    } as never);
    await assert.rejects(
      probed.setBuiltInExecutionChannel({ agentName: "general-purpose", presetId: "codebuddy" }),
      /未安装/,
    );

    const probeError = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => [
        {
          preset: { id: "codebuddy", label: "CodeBuddy" },
          installed: true,
          probeError: "spawn_enoent",
          models: [],
          modelCatalog: [],
        },
      ],
    } as never);
    await assert.rejects(
      probeError.setBuiltInExecutionChannel({
        agentName: "general-purpose",
        presetId: "codebuddy",
      }),
      /探测失败/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setBuiltInExecutionChannel 带 model/effort：写入投影到 list（含探测档位校验）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    // 探测调用计数：下面连调多次（换模型、换档位、非法值），装机探测只该跑一次。
    let probeCalls = 0;
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => {
        probeCalls += 1;
        return [
          {
            preset: { id: "codebuddy", label: "CodeBuddy" },
            installed: true,
            models: ["DeepSeek-V4-Pro", "glm-5.3"],
            modelCatalog: [
              { id: "DeepSeek-V4-Pro", name: "DeepSeek-V4-Pro", supportedEfforts: ["low", "high"] },
            ],
          },
        ];
      },
    } as never);
    // 目录含所选模型：档位在候选内 → 通过并投影。
    await service.setBuiltInExecutionChannel({
      agentName: "general-purpose",
      presetId: "codebuddy",
      model: "DeepSeek-V4-Pro",
      effort: "high",
    });
    const listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    const general = listed.agents.find((agent) => agent.name === "general-purpose");
    assert.equal(general?.backend, "external");
    assert.equal(general?.externalModel, "DeepSeek-V4-Pro");
    assert.equal(general?.externalEffort, "high");

    // 目录含所选模型：档位不在候选 → 拒绝。
    await assert.rejects(
      service.setBuiltInExecutionChannel({
        agentName: "general-purpose",
        presetId: "codebuddy",
        model: "DeepSeek-V4-Pro",
        effort: "ultra",
      }),
      /不支持档位/,
    );

    // 目录没有该模型条目（自由输入模型）→ 档位不强校验，通过。
    await service.setBuiltInExecutionChannel({
      agentName: "general-purpose",
      presetId: "codebuddy",
      model: "free-typed-model",
      effort: "whatever",
    });
    // 空串 / 非法窗口 → 拒绝。
    await assert.rejects(
      service.setBuiltInExecutionChannel({
        agentName: "general-purpose",
        presetId: "codebuddy",
        model: "  ",
      }),
      /空串/,
    );
    await assert.rejects(
      service.setBuiltInExecutionChannel({
        agentName: "general-purpose",
        presetId: "codebuddy",
        contextWindow: -1,
      }),
      /正整数/,
    );
    // 上面共 6 次调用（2 次成功写入 + 4 次校验失败），装机探测只跑 1 次：
    // 全量探测要跑五个 CLI（实测 8.4s），每次换模型/档位都重跑就是"每点一下
    // 都要等十秒"（用户反馈）。缓存 60s，只加速不放松任何一道校验。
    assert.equal(probeCalls, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("探测缓存不掩盖装机状态变化：probeExternalAgents RPC 与写入共用同一份缓存", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    let probeCalls = 0;
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => {
        probeCalls += 1;
        return [
          {
            preset: { id: "codebuddy", label: "CodeBuddy" },
            installed: true,
            models: [],
            modelCatalog: [],
          },
        ];
      },
    } as never);
    // 设置页打开表单先探一次（UI 侧也有 60s 缓存，两层都命中同一次结果）。
    await service.probeExternalAgents();
    // 紧接着切渠道：不该再等一轮全量探测。
    await service.setBuiltInExecutionChannel({
      agentName: "general-purpose",
      presetId: "codebuddy",
    });
    assert.equal(probeCalls, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("探测返回 null（链路未就绪）不写缓存，下次仍会重试", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    let probeCalls = 0;
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => {
        probeCalls += 1;
        return null;
      },
    } as never);
    await service.probeExternalAgents();
    await service.probeExternalAgents();
    // null = "问不到"（冷启动端口未装配），不是"没装"：缓存它会让重试形同虚设。
    assert.equal(probeCalls, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state 文件手改：未开渠道的 preset 一律丢弃（防线之二）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    await service.setEnabled({ agentId: "probe", enabled: true }); // 触发 state 文件生成
    const stateFile = join(home, ".zcode", "v2", "agents-state.json");
    const raw = JSON.parse(await readFile(stateFile, "utf-8"));
    raw.builtInExecutionChannel = {
      // 未过 §3.7 清单的 preset（claude-code）+ 不存在的 id → 都丢弃。
      "general-purpose": { presetId: "claude-code" },
      Explore: { presetId: "no-such-cli" },
    };
    await writeFile(stateFile, JSON.stringify(raw), "utf-8");
    const listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    assert.equal(
      listed.agents.find((agent) => agent.name === "general-purpose")?.backend,
      undefined,
    );
    assert.equal(listed.agents.find((agent) => agent.name === "Explore")?.backend, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state 文件手改：opencode 的 general-purpose 渠道被保留（它确实开了这个身份）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    await service.setEnabled({ agentId: "probe", enabled: true });
    const stateFile = join(home, ".zcode", "v2", "agents-state.json");
    const raw = JSON.parse(await readFile(stateFile, "utf-8"));
    raw.builtInExecutionChannel = { "general-purpose": { presetId: "opencode" } };
    await writeFile(stateFile, JSON.stringify(raw), "utf-8");
    const listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    const general = listed.agents.find((agent) => agent.name === "general-purpose");
    assert.equal(general?.backend, "external");
    assert.equal(general?.presetId, "opencode");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("opencode 能同时承接两个身份（Explore 的只读经 --agent plan 成立）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    await service.setEnabled({ agentId: "probe", enabled: true });
    const stateFile = join(home, ".zcode", "v2", "agents-state.json");
    const raw = JSON.parse(await readFile(stateFile, "utf-8"));
    raw.builtInExecutionChannel = {
      "general-purpose": { presetId: "opencode" },
      Explore: { presetId: "opencode" },
    };
    await writeFile(stateFile, JSON.stringify(raw), "utf-8");
    const listed = await service.list({
      workspacePath: "",
      provider: undefined as never,
      mode: "settingsUserOnly",
    });
    const general = listed.agents.find((agent) => agent.name === "general-purpose");
    const explore = listed.agents.find((agent) => agent.name === "Explore");
    assert.equal(general?.backend, "external");
    assert.equal(explore?.backend, "external");
    assert.equal(explore?.presetId, "opencode");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("probeExternalAgents：未注入返回 null（UI 降级路径），注入后透传", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const plain = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    assert.equal(await plain.probeExternalAgents(), null);

    const status = [
      {
        preset: { id: "codebuddy", label: "CodeBuddy" },
        installed: true,
        models: ["DeepSeek-V4-Pro"],
        modelCatalog: [],
      },
    ] as never;
    const injected = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
      probeExternalAgents: async () => status,
    });
    assert.equal(await injected.probeExternalAgents(), status);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── Windows .cmd shim 探测（实例内实测发现的真缺陷）──

test("resolveSpawnInvocation：win32 上无扩展名的命令经 cmd.exe，显式扩展名原样", () => {
  const bare = resolveSpawnInvocation("codebuddy", ["--version"]);
  if (process.platform === "win32") {
    // npm 全局 bin 是 codebuddy.cmd：shell:false 直接 spawn 报 ENOENT（实测）。
    assert.match(bare.file.toLowerCase(), /cmd\.exe$/u);
    assert.deepEqual(bare.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.ok(bare.args[3]?.includes("codebuddy"));
    assert.equal(bare.windowsVerbatim, true);
  } else {
    assert.deepEqual(bare, {
      file: "codebuddy",
      args: ["--version"],
      windowsVerbatim: false,
    });
  }
  // 显式 .exe 不套 shell（多一层就多一份引号风险）。
  assert.equal(resolveSpawnInvocation("node.exe", ["-e", "1"]).windowsVerbatim, false);
});

test("resolveSpawnInvocation：含空格/引号的参数按 cmd 规则引起来", () => {
  const invocation = resolveSpawnInvocation("codebuddy", ["--model", "a b", 'x"y']);
  if (process.platform === "win32") {
    assert.ok(invocation.args[3]?.includes('"a b"'));
    assert.ok(invocation.args[3]?.includes('x""y'));
  }
});
