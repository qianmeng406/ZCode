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
  parentSessionId: "s_parent" as never,
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
    // 取消现在按取消语义抛错（不是返回"成功但空正文"）：runner 据此走 cancelled
    // 路径而不是 completed。这里同时验证"取消真的到了进程"。
    await expect(port.run(runRequest(), { signal: controller.signal })).rejects.toBeTruthy();

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

  it("外部 CLI 非零退出 → 抛错（不能报成 completed）", async () => {
    // 回归（Oracle 审查）：端口以前只返回 { response: result.text }，把
    // isError/exitCode 全丢掉；而 runner 无条件写 completed。结果非零退出的
    // 委派在卡片与通知里都显示"已完成"，错误文本还被当成回答正文。
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort(
        JSON.stringify([
          { type: "result", is_error: true, result: "命令执行失败：permission denied" },
        ]),
      ) as never,
    });

    await expect(port.run(runRequest())).rejects.toThrow(/执行失败.*exitCode|permission denied/u);
  });

  it("停滞看门狗中止（isError + exitCode 1）同样抛错", async () => {
    // driver 对停滞的收口是 { isError: true, exitCode: 1 }，不是异常；
    // 端口必须把它转成失败，否则"卡死被终止"会显示成"已完成"。
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    // 不回任何 result 事件 → driver 解析不到正文，模拟异常收口。
    const port = createExternalSubagentPort({
      executionPort: {
        run: vi.fn(async () => ({
          streams: { stdout: { text: "" }, stderr: { text: "" } },
          exitCode: 1,
        })),
      } as never,
    });

    await expect(port.run(runRequest())).rejects.toThrow(/执行失败/u);
  });

  it("外层取消按取消语义抛错，不被当成执行失败", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const executionPort = {
      run: vi.fn(async (_request: unknown, options?: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // 被中止时 driver 通常也拿不到 result：这里给个"成功"形状，
        // 验证端口优先按取消语义抛，而不是被 exitCode 判定误导。
        return {
          streams: { stdout: { text: resultJson("半截") }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(port.run(runRequest(), { signal: controller.signal })).rejects.toBeTruthy();
  });

  it("同会话并发达到上限时明确拒绝（不排队、不静默丢任务）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const gate = Promise.withResolvers<void>();
    const executionPort = {
      run: vi.fn(async () => {
        await gate.promise;
        return {
          streams: { stdout: { text: resultJson("ok") }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({
      executionPort: executionPort as never,
      maxConcurrentPerSession: 2,
    });

    const running = [
      port.run(runRequest({ agentId: "agent_1" })),
      port.run(runRequest({ agentId: "agent_2" })),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(port.run(runRequest({ agentId: "agent_3" }))).rejects.toThrow(/已达上限/u);

    gate.resolve();
    await Promise.all(running);
  });

  it("不同会话的配额互不影响（按父会话分组）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const gate = Promise.withResolvers<void>();
    const executionPort = {
      run: vi.fn(async () => {
        await gate.promise;
        return {
          streams: { stdout: { text: resultJson("ok") }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({
      executionPort: executionPort as never,
      maxConcurrentPerSession: 1,
    });

    const a = port.run(runRequest({ agentId: "agent_a", parentSessionId: "s_1" as never }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 另一个会话不该被第一个会话的用量连坐。
    const b = port.run(runRequest({ agentId: "agent_b", parentSessionId: "s_2" as never }));
    gate.resolve();

    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it("同一实例的 run 串行执行（不并发写同一个 CLI 会话）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const executionPort = {
      run: vi.fn(async (request: { stdin?: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(String(request.stdin));
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return {
          streams: { stdout: { text: resultJson("ok") }, stderr: { text: "" } },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    await Promise.all([
      port.run(runRequest({ prompt: "第一次" })),
      port.run(runRequest({ prompt: "第二次" })),
    ]);

    // 同 agentId 的两次 run 不允许重叠。
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(2);
  });

  it("非本地执行目标明确拒绝（首版锁本地）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("ok")) as never,
      assertLocalExecution: () => {
        throw new Error("外部 agent 子智能体暂只支持本地执行（当前会话目标是 wsl）");
      },
    });

    await expect(port.run(runRequest())).rejects.toThrow(/只支持本地执行/u);
  });
});

describe("transcript 投影（下钻面板数据源）", () => {
  it("流式条目按顺序写进 transcript", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const written: Array<{ kind: string; text: string; mode?: string }> = [];
    const executionPort = {
      run: vi.fn(async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
        options?.onEvent?.({
          type: "progress",
          outputPreview: { fullText: "line" },
        });
        return {
          streams: {
            stdout: {
              text: JSON.stringify([
                { type: "assistant", message: { content: [{ type: "text", text: "改好了" }] } },
                { type: "result", is_error: false, result: "改好了" },
              ]),
            },
            stderr: { text: "" },
          },
          exitCode: 0,
        };
      }),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    await port.run(
      runRequest({
        onTranscript: async (entry: { kind: string; text: string; mode?: string }) => {
          written.push(entry);
        },
      }),
    );

    // 无论走条目还是全文兜底，结论必须出现在 transcript 里。
    expect(written.some((entry) => entry.text.includes("改好了"))).toBe(true);
  });

  it("流式推送过正文就不再补全文（避免同一段出现两遍）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const written: Array<{ kind: string; text: string }> = [];
    // 构造一个"解析器能产出 text 条目"的输出，模拟 claude-family 流式。
    const entry = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "流式正文" }] },
    });
    const result = JSON.stringify([{ type: "result", is_error: false, result: "流式正文" }]);
    const executionPort = {
      run: vi.fn(async () => ({
        streams: {
          stdout: {
            text: `${entry}
${result}`,
          },
          stderr: { text: "" },
        },
        exitCode: 0,
      })),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    await port.run(
      runRequest({
        onTranscript: async (e: { kind: string; text: string }) => {
          written.push(e);
        },
      }),
    );

    const textEntries = written.filter((e) => e.kind === "text");
    const joined = textEntries.map((e) => e.text).join("");
    // 只出现一次，不是两遍。
    expect(joined.split("流式正文").length - 1).toBe(1);
  });

  it("权威重建用 replace 模式透传", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const modes: Array<string | undefined> = [];
    const entry = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "重建正文" }] },
    });
    const executionPort = {
      run: vi.fn(async () => ({
        streams: {
          stdout: {
            text: `${entry}
${JSON.stringify([{ type: "result", is_error: false, result: "重建正文" }])}`,
          },
          stderr: { text: "" },
        },
        exitCode: 0,
      })),
    };
    const port = createExternalSubagentPort({ executionPort: executionPort as never });

    await port.run(
      runRequest({
        onTranscript: async (e: { kind: string; text: string; mode?: string }) => {
          modes.push(e.mode);
        },
      }),
    );

    // 收口时的权威重建必须标 replace，否则面板留着执行中的重复/丢段。
    expect(modes).toContain("replace");
  });

  it("没给 onTranscript 时执行照常成功（观察层可选）", async () => {
    const { createExternalSubagentPort } =
      await import("../src/zcode-protocol/external-subagent-port-impl.js");
    const port = createExternalSubagentPort({
      executionPort: fakeExecutionPort(resultJson("ok")) as never,
    });

    await expect(port.run(runRequest())).resolves.toMatchObject({ response: "ok" });
  });
});
