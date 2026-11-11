// 外部 agent 子智能体：profile → binding → driver 的执行链路。
//
// 这层要钉住的是"声明了什么就一定怎么执行"，因为外部 CLI 的失败模式普遍是
// 静默的（参数不被识别就忽略、档位不生效不报错）。这里用 fake driver 把所有
// 参数形状、续接语义与取消传导固定下来，不需要真的装 CLI。
import { describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "@zcode/shared";
import { findExternalAgentPreset } from "@zcode/shared";

const baseProfile: AgentProfile = {
  name: "cb-runner",
  description: "把实现任务交给 CodeBuddy",
  source: "user",
  systemPrompt: "你是一个执行型子智能体。",
  backend: "external",
  preset: "codebuddy",
};

const runRequest = (overrides: Partial<Record<string, unknown>> = {}) => ({
  agentId: "agent_abc",
  childSessionId: "subagent_agent_abc" as never,
  agentType: "cb-runner",
  description: "改 lint",
  prompt: "把 lint 修了",
  profile: baseProfile,
  workingDirectory: "/tmp/ws",
  workspaceRoot: "/tmp/ws",
  traceContext: { traceId: "t", spanId: "s" } as never,
  ...overrides,
});

/** 造一个只回固定 stdout 的执行端口，用来观察 driver 发给端口的 argv。 */
function fakeExecutionPort(stdout: string, capture?: { args?: string[]; signal?: AbortSignal }) {
  return {
    run: vi.fn(
      async (request: { command?: { args?: string[] } }, options?: { signal?: AbortSignal }) => {
        if (capture) {
          capture.args = request.command?.args;
          capture.signal = options?.signal;
        }
        return { streams: { stdout: { text: stdout }, stderr: { text: "" } }, exitCode: 0 };
      },
    ),
  };
}

const resultJson = (text: string, sessionId?: string) =>
  JSON.stringify([
    {
      type: "result",
      is_error: false,
      result: text,
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  ]);

describe("buildBindingFromProfile", () => {
  it("预设的 driver/command/promptDelivery 全部来自预设目录", async () => {
    const { buildBindingFromProfile } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const preset = findExternalAgentPreset("codebuddy")!;
    const binding = buildBindingFromProfile(baseProfile);

    expect(binding).toMatchObject({
      driver: preset.driver,
      command: preset.command,
      promptDelivery: preset.promptDelivery,
      presetId: "codebuddy",
      label: preset.label,
    });
    // 子智能体实例不落库，绝不带会话绑定的 previous* 快照字段。
    expect(binding.previousMode).toBeUndefined();
    expect(binding.previousPlanEnabled).toBeUndefined();
    expect(binding.externalSessionId).toBeUndefined();
  });

  it("model/effort/contextWindow 按模型键挂到 binding 映射上", async () => {
    const { buildBindingFromProfile } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const binding = buildBindingFromProfile({
      ...baseProfile,
      model: "glm-4.6",
      effort: "high",
      contextWindow: 200000,
    });

    expect(binding.model).toBe("glm-4.6");
    expect(binding.effortsByModel).toEqual({ "glm-4.6": "high" });
    expect(binding.contextWindowByModel).toEqual({ "glm-4.6": 200000 });
  });

  it("未知预设直接抛错（不静默回退到某个默认 CLI）", async () => {
    const { buildBindingFromProfile } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    expect(() => buildBindingFromProfile({ ...baseProfile, preset: "no-such" })).toThrow(
      /预设不存在/u,
    );
  });

  it("半适配预设拒绝执行（解析期之外的第二道闸）", async () => {
    const { buildBindingFromProfile } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    // claude-code 在目录里是 partial：档案可能来自旧缓存/插件模板，绕过 parser 校验。
    expect(() => buildBindingFromProfile({ ...baseProfile, preset: "claude-code" })).toThrow(
      /部分适配/u,
    );
  });
});

describe("composeExternalSubagentPrompt", () => {
  it("profile 正文在前、任务在后，中间空一行", async () => {
    const { composeExternalSubagentPrompt } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    expect(composeExternalSubagentPrompt("角色设定", "做这件事")).toBe("角色设定\n\n做这件事");
  });

  it("任一侧为空时不留下多余分隔", async () => {
    const { composeExternalSubagentPrompt } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    expect(composeExternalSubagentPrompt("", "任务")).toBe("任务");
    expect(composeExternalSubagentPrompt("角色", "")).toBe("角色");
  });
});

describe("createExternalSubagentPort", () => {
  it("只接管 backend=external 的 profile", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort("") as never,
    });

    expect(port.handles({ ...baseProfile, backend: "external" })).toBe(true);
    expect(port.handles({ ...baseProfile, backend: "native" })).toBe(false);
    expect(port.handles({ ...baseProfile, backend: undefined })).toBe(false);
  });

  it("执行前先回调 onSessionReady（persist-before-spawn 顺序）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const order: string[] = [];
    const executionPort = {
      run: vi.fn(async () => {
        order.push("spawn");
        return {
          streams: { stdout: { text: resultJson("完成") }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    await port.run(runRequest({ onSessionReady: async () => void order.push("ready") }));

    expect(order).toEqual(["ready", "spawn"]);
  });

  it("返回外部 CLI 的正文，且 events 为空（不伪造原生统计）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("修好了")) as never,
    });

    const result = await port.run(runRequest());

    expect(result.response).toBe("修好了");
    // 外部 CLI 没有 ZCode 原生事件：宁可显示"暂无统计"，也不编造 token/工具数。
    expect(result.events).toEqual([]);
  });

  it("有实例级会话 id 时续接（argv 带 -r），没有就开新会话", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");

    const withoutSession: { args?: string[] } = {};
    const portA = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("ok"), withoutSession) as never,
    });
    await portA.run(runRequest());
    expect(withoutSession.args ?? []).not.toContain("-r");

    const withSession: { args?: string[] } = {};
    const portB = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("ok"), withSession) as never,
      readExternalSessionId: async () => "sess-1",
    });
    await portB.run(runRequest());
    const args = withSession.args ?? [];
    expect(args).toContain("-r");
    expect(args).toContain("sess-1");
  });

  it("执行结束把新会话 id 存回实例（键是 agentId，不碰会话绑定）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const saved: Array<{ agentId: string; sessionId: string }> = [];
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("ok", "sess-new")) as never,
      saveExternalSessionId: async (agentId, sessionId) => {
        saved.push({ agentId, sessionId });
      },
    });

    await port.run(runRequest());

    expect(saved).toEqual([{ agentId: "agent_abc", sessionId: "sess-new" }]);
  });

  it("外层取消信号传导到进程（driver 收到的 signal 已中止）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const captured: { signal?: AbortSignal } = {};
    const executionPort = {
      run: vi.fn(async (_request: unknown, options?: { signal?: AbortSignal }) => {
        captured.signal = options?.signal;
        // 模拟真实端口：等到被中止才返回。
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { streams: { stdout: { text: "" }, stderr: { text: "" } }, exitCode: null };
      }),
    };
    const port = createExternalSubagentPort({
      executionPort: executionPort as never,
    });

    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);
    await port.run(runRequest(), { signal: controller.signal });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(captured.signal?.aborted).toBe(true);
  });

  it("close 之后拒绝新执行（准入闸），并中止在跑的实例", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const captured: { signal?: AbortSignal } = {};
    const executionPort = {
      run: vi.fn(async (_request: unknown, options?: { signal?: AbortSignal }) => {
        captured.signal = options?.signal;
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { streams: { stdout: { text: "" }, stderr: { text: "" } }, exitCode: null };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    const runningRun = port.run(runRequest());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await port.close!();

    expect(captured.signal?.aborted).toBe(true);
    await runningRun;
    await expect(port.run(runRequest())).rejects.toThrow(/已关闭/u);
  });

  it("并发多实例互不影响：各自的 argv 与结果不串台", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    // 按命令里的 model 区分结果，验证两次执行没有共享状态。
    const executionPort = {
      run: vi.fn(async (request: { command?: { args?: string[] } }) => {
        const args = request.command?.args ?? [];
        const modelIndex = args.indexOf("--model");
        const model = modelIndex >= 0 ? args[modelIndex + 1] : "default";
        return {
          streams: { stdout: { text: resultJson(`done:${model}`) }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    const [a, b] = await Promise.all([
      port.run(runRequest({ agentId: "agent_a", profile: { ...baseProfile, model: "model-a" } })),
      port.run(runRequest({ agentId: "agent_b", profile: { ...baseProfile, model: "model-b" } })),
    ]);

    expect(a.response).toBe("done:model-a");
    expect(b.response).toBe("done:model-b");
  });
});
