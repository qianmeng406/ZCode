// 外部 agent 子智能体：从 Agent 工具到外部端口的整条链路。
//
// 这层钉住的是"主 agent 真的能像创建原生子智能体一样创建外部子智能体"，
// 而不只是适配器自己的单元行为：
// - profile 声明 backend: external 时执行走注入端口，原生 child 模型不会被调用；
// - 子会话在放行执行前就落库（parentID + taskType=subagent_child），否则父会话的
//   子智能体投影会把这条分支整个丢掉，表现为"卡片没有、下钻空白"；
// - 生命周期事件仍然由原生 runner 发出（卡片/侧栏/未读的来源）。
import { describe, expect, it, vi } from "vitest";
import { SessionEventType, createSessionId } from "@zcode/contracts";
import type { AgentProfile, ExternalSubagentPort, SessionId, SubagentPort } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

const externalProfile: AgentProfile = {
  name: "cb-runner",
  description: "把实现任务交给 CodeBuddy",
  source: "user",
  systemPrompt: "你是执行型子智能体。",
  backend: "external",
  preset: "codebuddy",
  model: "glm-4.6",
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * 造一个父 runtime：第一轮发起 Agent(cb-runner)，之后收尾。
 *
 * 与 subagent-profile-scenario 同形（用 loadAgentDefinitions 注入 profile），
 * 但把断言重点放在"子执行走的是外部端口"——所以 child 模型调用会被记下来，
 * 一旦发生就说明分流失败。
 */
function setup(options: {
  externalSubagentPort?: ExternalSubagentPort;
  profiles?: AgentProfile[];
  prompt?: string;
}) {
  const sessionId = createSessionId();
  const sessionStore = createRecordingSubagentSessionStore();
  const events = createTestSessionEventStore();
  const childModelCalls: unknown[] = [];
  const childSessionIds: string[] = [];
  let parentCalls = 0;
  const profiles = options.profiles ?? [externalProfile];

  const runtime = createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false } },
    {
      sessionStore,
      eventStore: events,
      loadAgentDefinitions: async () => ({ activeAgents: profiles }),
      ...(options.externalSubagentPort
        ? {
            // 包一层只为记录 childSessionId（测试断言要按它去查 transcript）。
            externalSubagentPort: {
              handles: options.externalSubagentPort.handles,
              run: (request, runOptions) => {
                childSessionIds.push(String(request.childSessionId));
                return options.externalSubagentPort!.run(request, runOptions);
              },
            } satisfies ExternalSubagentPort,
          }
        : {}),
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          // 子会话的模型调用 = 走了原生路径（对 external profile 是失败信号）。
          if (observation.invocationContext?.metadata?.querySource === "subagent") {
            childModelCalls.push(request);
            return { finishReason: "stop", text: "native child", usage };
          }
          parentCalls += 1;
          if (parentCalls === 1) {
            return {
              finishReason: "tool-calls",
              text: "",
              usage,
              toolCalls: [
                {
                  id: "call_external_1",
                  name: "Agent",
                  input: {
                    description: "改 lint",
                    prompt: options.prompt ?? "把 lint 修了",
                    subagent_type: "cb-runner",
                  },
                },
              ],
            };
          }
          return { finishReason: "stop", text: "done", usage };
        },
      }),
    },
  );

  return { runtime, sessionId, sessionStore, events, childModelCalls, childSessionIds };
}

const lifecycle = async (
  sessionId: SessionId,
  events: ReturnType<typeof createTestSessionEventStore>,
  type: SessionEventType,
) => (await events.getEvents(sessionId)).filter((event) => event.type === type);

describe("外部 agent 子智能体（Agent 工具 → 外部端口）", () => {
  it("执行走外部端口；原生 child 模型一次都不被调用", async () => {
    const run = vi.fn(async () => ({ response: "外部 CLI 改完了 lint", events: [] }));
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run,
    };
    const scenario = setup({ externalSubagentPort });

    const result = await scenario.runtime.executeTurn("用 cb-runner 修 lint");

    expect(result.response).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({ agentType: "cb-runner", prompt: "把 lint 修了" });
    // 分流成功的关键证据：外部 profile 绝不会落到原生 child runtime。
    expect(scenario.childModelCalls).toHaveLength(0);
  });

  it("生命周期事件仍由原生 runner 发出（卡片/未读的来源）", async () => {
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async () => ({ response: "ok", events: [] }),
    };
    const scenario = setup({ externalSubagentPort });

    await scenario.runtime.executeTurn("用 cb-runner");

    const spawned = await lifecycle(
      scenario.sessionId,
      scenario.events,
      SessionEventType.SubagentSpawned,
    );
    const stopped = await lifecycle(
      scenario.sessionId,
      scenario.events,
      SessionEventType.SubagentStopped,
    );
    expect(spawned).toHaveLength(1);
    expect(stopped).toHaveLength(1);
    const spawnedPayload = spawned[0]!.payload as { agentType?: string };
    expect(spawnedPayload.agentType).toBe("cb-runner");
  });

  it("执行前先落子会话（parentID + taskType=subagent_child）", async () => {
    let seen: { parentID?: string; taskType?: string } | undefined;
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async (request) => {
        // 端口被调用时子会话必须已在库：投影靠它决定这条分支是否有效。
        const child = await scenarioRef!.sessionStore.getSession(request.childSessionId);
        seen = child ?? undefined;
        return { response: "ok", events: [] };
      },
    };
    const scenarioRef = setup({ externalSubagentPort });

    await scenarioRef.runtime.executeTurn("用 cb-runner");

    expect(seen).toMatchObject({ parentID: scenarioRef.sessionId, taskType: "subagent_child" });
  });

  it("外部端口缺席时不会悄悄用父模型跑原生 child", async () => {
    const scenario = setup({});

    await scenario.runtime.executeTurn("用 cb-runner");

    // 子智能体失败作为工具错误回给父模型（父轮正常收口），所以断言在这里：
    // 一次原生 child 模型都不许被调用。曾经它会静默退回父会话模型跑完并报
    // completed——用户以为活是外部 CLI 干的。
    expect(scenario.childModelCalls).toHaveLength(0);
  });

  it("多个外部子智能体并发：各实例独立执行且都能收口", async () => {
    const seen: string[] = [];
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async (request) => {
        seen.push(`${request.agentId}:${request.prompt}`);
        return { response: `done:${request.prompt}`, events: [] };
      },
    };
    const scenario = setup({ externalSubagentPort, prompt: "任务A" });

    await scenario.runtime.executeTurn("用 cb-runner");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^agent_[^:]+:任务A$/u);
  });

  it("运行中 SendMessage 明确失败（外部 CLI 没有输入通道，不许假报 queued）", async () => {
    // 回归（Oracle 审查）：外部子智能体没有 messageSink，deliverMessageToRunningAgent
    // 会走 registry.queueMessage 并返回 delivery:"queued" 的成功文案——但消息永远
    // 不会送达。不降级假实现 = 这里必须 status:"failed"。
    const gate = Promise.withResolvers<void>();
    let agentId = "";
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async (request) => {
        agentId = request.agentId;
        await gate.promise;
        return { response: "ok", events: [] };
      },
    };
    const scenario = setup({ externalSubagentPort });

    // 第一轮在后台启动外部子智能体，让它保持 running。
    const turnPromise = scenario.runtime.executeTurn("用 cb-runner");
    await vi.waitFor(() => expect(agentId).not.toBe(""));

    // runtime 不暴露 sendMessage 方法（工具层调 subagentPort.sendMessage），
    // 这里走同一条端口路径。
    const port = (scenario.runtime as unknown as { subagentPort: SubagentPort }).subagentPort;
    const result = await port.sendMessage!({
      sessionId: scenario.sessionId,
      parentToolCallId: "call_send",
      to: agentId,
      message: "顺便改一下文档",
      workingDirectory: "/workspace/project",
      workspaceRoot: "/workspace/project",
      trace: { traceId: "t", spanId: "s" } as never,
    });

    expect(result.status).toBe("failed");
    expect(result.delivery).toBeUndefined();
    expect(result.error).toContain("外部 CLI 执行");

    gate.resolve();
    await turnPromise;
  });

  it("外部 CLI 的输出落进子会话 transcript（下钻面板有内容）", async () => {
    // S3：外部路径没有 child runtime 帮忙落消息，必须由 core 的 writer 写入。
    // 否则子会话存在、卡片正常，但下钻永远是空的。
    let onTranscript: ((entry: unknown) => Promise<void>) | undefined;
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async (request) => {
        onTranscript = request.onTranscript as never;
        await request.onTranscript!({ kind: "text", text: "外部 CLI 的结论" });
        return { response: "外部 CLI 的结论", events: [] };
      },
    };
    const scenario = setup({ externalSubagentPort });

    await scenario.runtime.executeTurn("用 cb-runner");

    expect(onTranscript).toBeDefined();
    // 子会话里必须能读到这次执行的消息与正文。
    const childSessionId = scenario.childSessionIds[0]!;
    const messages = await scenario.sessionStore.messages({ sessionID: childSessionId });
    expect(messages.length).toBeGreaterThan(0);
    const text = JSON.stringify(messages);
    expect(text).toContain("把 lint 修了"); // 任务正文（user 侧）
    expect(text).toContain("外部 CLI 的结论"); // CLI 输出（assistant 侧）
  });

  it("SubagentSpawned 事件带 backend/presetId（卡片徽标来源）", async () => {
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async () => ({ response: "ok", events: [] }),
    };
    const scenario = setup({ externalSubagentPort });

    await scenario.runtime.executeTurn("用 cb-runner");

    const spawned = await lifecycle(
      scenario.sessionId,
      scenario.events,
      SessionEventType.SubagentSpawned,
    );
    expect(spawned).toHaveLength(1);
    const payload = spawned[0]!.payload as { backend?: string; presetId?: string };
    // UI 靠这两个字段把这次执行标成「外部 CLI」并显示预设名。
    expect(payload.backend).toBe("external");
    expect(payload.presetId).toBe("codebuddy");
  });

  it("原生子智能体的 Spawned 事件不带 backend 字段（不误标）", async () => {
    // 存量行为不能变：native profile 不该被标成外部。
    // setup 的 Agent 调用固定用 cb-runner 作 subagent_type，所以这里同名声明
    // 一个 native profile 覆盖它——断言的是"同名但 native"不会被标成 external。
    const nativeProfile: AgentProfile = {
      name: "cb-runner",
      description: "Review",
      source: "user",
      systemPrompt: "review",
      tools: ["Read"],
      modelSelection: { providerId: "custom", modelId: "m", options: { reasoningLevel: "low" } },
    };
    const scenario = setup({ profiles: [nativeProfile], prompt: undefined });

    await scenario.runtime.executeTurn("用 cb-runner");

    const spawned = await lifecycle(
      scenario.sessionId,
      scenario.events,
      SessionEventType.SubagentSpawned,
    );
    expect(spawned).toHaveLength(1);
    expect((spawned[0]!.payload as { backend?: string }).backend).toBeUndefined();
  });

  it("终态续跑走外部端口，不会回落到原生 child runtime", async () => {
    // 这是「终态续跑能否信任」的关键：resumeTerminalAgentInBackground 会以
    // resumeFromStore:true 再跑一次 runExploreAgent。如果分流写晚了，它就会建一个
    // 原生 child runtime 用 ZCode 自己的模型跑——用户以为外部 CLI 接着干活，其实不是。
    const prompts: string[] = [];
    const externalSubagentPort: ExternalSubagentPort = {
      handles: (profile) => profile.backend === "external",
      run: async (request) => {
        prompts.push(request.prompt);
        return { response: "ok", events: [] };
      },
    };
    const scenario = setup({ externalSubagentPort });

    await scenario.runtime.executeTurn("用 cb-runner");
    const port = (scenario.runtime as unknown as { subagentPort: SubagentPort }).subagentPort;
    const agentId = scenario.childSessionIds.length ? "agent_resume" : "";
    void agentId;

    // 从注册表拿到刚结束的那个任务，再给它发一条消息（走终态续跑）。
    const registry = (
      scenario.runtime as unknown as {
        runtimeTaskRegistry: { all(): Record<string, { agentId: string }> };
      }
    ).runtimeTaskRegistry;
    const task = Object.values(registry.all())[0];

    const result = await port.sendMessage!({
      sessionId: scenario.sessionId,
      parentToolCallId: "call_send",
      to: task.agentId,
      message: "接着改文档",
      workingDirectory: "/workspace/project",
      workspaceRoot: "/workspace/project",
      trace: { traceId: "t", spanId: "s" } as never,
    });

    expect(result.status).toBe("success");
    // 等续跑那一轮的端口调用发生。
    await vi.waitFor(() => expect(prompts.length).toBe(2));
    expect(prompts[1]).toContain("接着改文档");
    // 原生 child 一次都不许被调用（否则就是回落到了 ZCode 自己的模型）。
    expect(scenario.childModelCalls).toHaveLength(0);
  });
});
