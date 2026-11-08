// 外部 agent 绑定：调用形状、JSON 解析、端口委派。
// 这三个函数决定了「主会话交出一个计划后，外部 agent 究竟被怎么调用、
// 输出又被怎么读回」，是整条委派链路上最容易出错、也最该被钉死的部分。
import { describe, expect, it, vi } from "vitest";
import {
  buildExternalAgentInvocation,
  externalAgentBindingSchema,
  parseExternalAgentResult,
  type ExternalAgentBinding,
} from "@zcode/shared";

const claudeFamily: ExternalAgentBinding = {
  label: "codebuddy",
  driver: "claude-family",
  command: "codebuddy",
  args: [],
  promptDelivery: "argv-append",
};

describe("buildExternalAgentInvocation", () => {
  it("claude-family 默认用 -p + --output-format stream-json，prompt 走 stdin", () => {
    expect(buildExternalAgentInvocation(claudeFamily, "修一下 lint")).toEqual({
      command: "codebuddy",
      args: ["-p", "--output-format", "stream-json"],
      stdin: "修一下 lint",
    });
  });

  it("claude-family 带 permissionMode 时补上 --permission-mode，prompt 仍在 stdin", () => {
    const invocation = buildExternalAgentInvocation(
      { ...claudeFamily, permissionMode: "plan" },
      "分析一下",
    );
    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "plan",
    ]);
    expect(invocation.stdin).toBe("分析一下");
  });

  it("claude-family 多行 prompt 完整进 stdin（cmd shim 截断防线）", () => {
    const prompt = "第一行\n第二行\n\n第四行";
    const invocation = buildExternalAgentInvocation(claudeFamily, prompt);
    expect(invocation.stdin).toBe(prompt);
    expect(invocation.args.join(" ")).not.toContain("第二行");
  });

  it("claude-family 自定义 args 时不再补默认参数", () => {
    const invocation = buildExternalAgentInvocation(
      { ...claudeFamily, args: ["-p", "--output-format", "stream-json"] },
      "hi",
    );
    expect(invocation.args).toEqual(["-p", "--output-format", "stream-json"]);
    expect(invocation.stdin).toBe("hi");
  });

  it("generic-template 用 {prompt} 占位替换", () => {
    const invocation = buildExternalAgentInvocation(
      {
        label: "custom",
        driver: "generic-template",
        command: "my-agent",
        args: ["run", "--task={prompt}", "--yes"],
        promptDelivery: "template",
      },
      "做这件事",
    );
    expect(invocation).toEqual({
      command: "my-agent",
      args: ["run", "--task=做这件事", "--yes"],
    });
  });

  it("generic-template 没有占位符时把 prompt 追加到末尾", () => {
    const invocation = buildExternalAgentInvocation(
      {
        label: "custom",
        driver: "generic-template",
        command: "my-agent",
        args: ["run"],
        promptDelivery: "argv-append",
      },
      "做这件事",
    );
    expect(invocation.args).toEqual(["run", "做这件事"]);
  });
});

describe("parseExternalAgentResult", () => {
  // 实测 codebuddy 2.179.2 的结构：数组，取 type:"result" 的 .result。
  const realOutput = JSON.stringify([
    { type: "message", role: "user", content: [] },
    { type: "file-history-snapshot" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "2" }] },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "2",
      session_id: "abc",
      duration_ms: 3027,
    },
  ]);

  it("从 claude-family 的 JSON 数组里取 result 字段", () => {
    expect(parseExternalAgentResult(claudeFamily, realOutput)).toEqual({
      text: "2",
      isError: false,
      // session_id 供下一轮 `-r` 续接。
      sessionId: "abc",
    });
  });

  it("is_error 透传为失败标记", () => {
    const failing = JSON.stringify([{ type: "result", is_error: true, result: "权限不足" }]);
    expect(parseExternalAgentResult(claudeFamily, failing)).toEqual({
      text: "权限不足",
      isError: true,
    });
  });

  it("非 JSON 输出退回原文（CLI 崩溃时不能丢证据）", () => {
    expect(parseExternalAgentResult(claudeFamily, "Error: command not found")).toEqual({
      text: "Error: command not found",
      isError: false,
    });
  });

  it("JSON 里没有 result 条目时退回原文", () => {
    const noResult = JSON.stringify([{ type: "message", role: "user" }]);
    expect(parseExternalAgentResult(claudeFamily, noResult).text).toBe(noResult);
  });

  it("generic-template 永远返回原文（不假设结构）", () => {
    const binding: ExternalAgentBinding = {
      label: "custom",
      driver: "generic-template",
      command: "x",
      args: [],
      promptDelivery: "argv-append",
    };
    expect(parseExternalAgentResult(binding, realOutput).text).toBe(realOutput);
  });
});

describe("externalAgentBindingSchema", () => {
  it("接受最小合法绑定并补默认 args", () => {
    const parsed = externalAgentBindingSchema.parse({
      label: "codebuddy",
      driver: "claude-family",
      command: "codebuddy",
      promptDelivery: "argv-append",
    });
    expect(parsed.args).toEqual([]);
  });

  it("拒绝空 label / 未知 driver", () => {
    expect(
      externalAgentBindingSchema.safeParse({
        label: "",
        driver: "claude-family",
        command: "x",
        promptDelivery: "argv-append",
      }).success,
    ).toBe(false);
    expect(
      externalAgentBindingSchema.safeParse({
        label: "x",
        driver: "nope",
        command: "x",
        promptDelivery: "argv-append",
      }).success,
    ).toBe(false);
  });

  it("保留 previousPlanEnabled 供解绑恢复", () => {
    const parsed = externalAgentBindingSchema.parse({
      label: "cb",
      driver: "claude-family",
      command: "codebuddy",
      promptDelivery: "argv-append",
      previousPlanEnabled: true,
    });
    expect(parsed.previousPlanEnabled).toBe(true);
  });
});

describe("delegation prompt composition", () => {
  it("带 context 时拼成独立小节，不带时原样返回", async () => {
    const { composeDelegationPrompt } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    expect(composeDelegationPrompt({ task: "计划正文" })).toBe("计划正文");
    const withContext = composeDelegationPrompt({ task: "计划正文", context: "验收标准" });
    expect(withContext).toContain("计划正文");
    expect(withContext).toContain("补充材料");
    expect(withContext).toContain("验收标准");
  });
});

describe("createExternalAgentPort", () => {
  it("未绑定时返回 unbound，不 spawn 任何进程", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn();
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => undefined,
    });
    await expect(
      port.delegate({ sessionId: "s" as never, task: "t", cwd: "/tmp" }),
    ).resolves.toEqual({ kind: "unbound" });
    expect(run).not.toHaveBeenCalled();
  });

  it("已绑定时按绑定调用并回传解析后的文本", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const stdout = JSON.stringify([{ type: "result", is_error: false, result: "已完成修复" }]);
    const run = vi.fn(async () => ({
      streams: { stdout: { text: stdout }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => claudeFamily,
    });
    const outcome = await port.delegate({
      sessionId: "s" as never,
      task: "修 lint",
      cwd: "/tmp",
    });
    expect(outcome).toMatchObject({
      kind: "delegated",
      label: "codebuddy",
      text: "已完成修复",
      exitCode: 0,
      isError: false,
    });
    // 调用形状：argv 模式 + prompt 走 stdin（Windows cmd shim 会截断多行 argv）。
    // 端口还会跑 git 汇总变更（cwd 非 git 仓库时也各跑一次），因此按命令过滤。
    const codebuddyCalls = run.mock.calls.filter(
      (call) => (call[0] as { command?: { file?: string } }).command?.file === "codebuddy",
    );
    expect(codebuddyCalls).toHaveLength(1);
    const request = (codebuddyCalls[0] as unknown as [Record<string, unknown>])[0];
    expect(request.command).toMatchObject({
      mode: "argv",
      file: "codebuddy",
      args: ["-p", "--output-format", "stream-json"],
    });
    expect(request.stdin).toBe("修 lint");
    expect(request.cwd).toBe("/tmp");
    // PWD 必须钉到本次 cwd：opencode 这类客户端 CLI 读 PWD 决定 project，
    // 继承启动链的陈旧 PWD 会让 agent 落到 app 启动目录的 project（实测事故）。
    expect(request.env).toMatchObject({ set: { PWD: "/tmp" } });
  });

  it("委派 spawn 的 env.PWD 始终对齐 cwd（即使 binding.env 缺席）", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn(async () => ({
      streams: { stdout: { text: "OK" }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => opencodeBinding,
    });
    await port.delegate({ sessionId: "s" as never, task: "t", cwd: "C:\\ws\\demo" });
    const request = (run.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request.env).toEqual({ set: { PWD: "C:\\ws\\demo" } });
  });
});

describe("外部 agent 续接与后台任务", () => {
  const stdoutWithSession = (sessionId: string) =>
    JSON.stringify([{ type: "result", is_error: false, result: "ok", session_id: sessionId }]);

  it("续接：带 -r 执行并写回新的 session id", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn(async () => ({
      streams: { stdout: { text: stdoutWithSession("sess-new") }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const updates: Array<{ sessionId: string; externalSessionId?: string }> = [];
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => ({ ...claudeFamily, externalSessionId: "sess-old" }),
      updateBinding: async (sessionId, binding) => {
        updates.push({ sessionId, externalSessionId: binding.externalSessionId });
      },
    });
    const outcome = await port.delegate({
      sessionId: "s" as never,
      task: "继续改",
      cwd: "/tmp",
    });
    expect(outcome).toMatchObject({ kind: "delegated", continued: true });
    const codebuddyCall = run.mock.calls.find(
      (call) => (call[0] as { command?: { file?: string } }).command?.file === "codebuddy",
    )!;
    expect((codebuddyCall[0] as { command: { args: string[] } }).command.args).toContain("-r");
    expect(updates).toEqual([{ sessionId: "s", externalSessionId: "sess-new" }]);
  });

  it("不续接（绑定无 externalSessionId）：每次新会话且绝不写回", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn(async () => ({
      streams: { stdout: { text: stdoutWithSession("sess-brand-new") }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const updates: Array<{ sessionId: string; externalSessionId?: string }> = [];
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => ({ ...claudeFamily }),
      updateBinding: async (sessionId, binding) => {
        updates.push({ sessionId, externalSessionId: binding.externalSessionId });
      },
    });
    await port.delegate({ sessionId: "s" as never, task: "独立任务", cwd: "/tmp" });
    const codebuddyCall = run.mock.calls.find(
      (call) => (call[0] as { command?: { file?: string } }).command?.file === "codebuddy",
    )!;
    // 菜单里选了「不续接（每次新会话）」就是字面语义：连续委派各自新开，
    // 新 session id 不能写回绑定——否则第一次之后标签就撒谎了。
    expect((codebuddyCall[0] as { command: { args: string[] } }).command.args).not.toContain("-r");
    expect(updates).toEqual([]);
  });

  it("后台任务：start → poll 完成 → 结果可取", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn(async () => ({
      streams: { stdout: { text: stdoutWithSession("sess-1") }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => claudeFamily,
    });
    const { taskId } = (await port.start!({
      sessionId: "s" as never,
      task: "长任务",
      cwd: "/tmp",
    }))!;
    // start 立即返回；等任务收口后再查（轮询语义：running → completed）。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot = await port.poll!(taskId);
    expect(snapshot).toMatchObject({ taskId, sessionId: "s", status: "completed" });
    expect(snapshot?.outcome).toMatchObject({ kind: "delegated", text: "ok" });
    const list = await port.list!("s");
    expect(list.map((task) => task.taskId)).toContain(taskId);
  });

  it("收口后落一份执行摘要（标签/模型/状态/耗时/结论尾部）", async () => {
    // 摘要是"重启后过程面板还能回忆起上次跑了什么"的唯一来源。
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const answer = "改完了：3 个文件，测试通过。";
    const run = async () => ({
      streams: {
        stdout: { text: JSON.stringify([{ type: "result", is_error: false, result: answer }]) },
        stderr: { text: "" },
      },
      exitCode: 0,
    });
    const saved: Array<{ sessionId: string; summary: Record<string, unknown> }> = [];
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => ({ ...claudeFamily, model: "glm-4.6" }),
      saveRunSummary: async (sessionId, summary) => {
        saved.push({ sessionId, summary });
      },
    });
    await port.delegate({ sessionId: "s" as never, task: "改 lint", cwd: "/tmp" });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      sessionId: "s",
      summary: {
        agentLabel: "codebuddy",
        model: "glm-4.6",
        status: "completed",
        tail: answer,
      },
    });
    expect(typeof saved[0]?.summary.finishedAt).toBe("number");
    expect(typeof saved[0]?.summary.durationMs).toBe("number");
  });

  it("执行摘要可读写；写空即清除（解绑/换绑不留旧结果）", async () => {
    const { persistSessionExternalAgentRun, readSessionExternalAgentRun } =
      await import("../src/zcode-protocol/session-external-agent.js");
    const entries: Array<{ data: unknown }> = [];
    const sessionStore = {
      saveSessionEntry: async (entry: { data: unknown }) => {
        entries.push(entry);
      },
      sessionEntries: async () => entries.slice(-1),
    };
    const summary = {
      agentLabel: "codebuddy",
      status: "completed" as const,
      finishedAt: 1_700_000_000_000,
      durationMs: 61_000,
      tail: "结论",
    };
    await persistSessionExternalAgentRun({
      sessionId: "s",
      sessionStore: sessionStore as never,
      summary,
    });
    expect(
      await readSessionExternalAgentRun({ sessionId: "s", sessionStore: sessionStore as never }),
    ).toMatchObject({ status: "completed", durationMs: 61_000, tail: "结论" });

    await persistSessionExternalAgentRun({
      sessionId: "s",
      sessionStore: sessionStore as never,
      summary: undefined,
    });
    expect(
      await readSessionExternalAgentRun({ sessionId: "s", sessionStore: sessionStore as never }),
    ).toBeUndefined();
  });

  it("后台任务：wait 在任务收口当刻返回，不等满超时", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    // 30ms 结束的任务：如果 wait 是按超时 sleep，这里会等满 5s。
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                streams: { stdout: { text: stdoutWithSession("sess-1") }, stderr: { text: "" } },
                exitCode: 0,
              }),
            30,
          );
        }),
    );
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => claudeFamily,
    });
    const { taskId } = await port.start!({ sessionId: "s" as never, task: "短任务", cwd: "/tmp" });
    const startedAt = Date.now();
    const snapshot = await port.wait!(taskId, { timeoutMs: 5_000 });
    const elapsed = Date.now() - startedAt;
    expect(snapshot).toMatchObject({ taskId, status: "completed" });
    expect(elapsed).toBeLessThan(2_000);
  });

  it("后台任务：wait 超时返回 running 快照（不丢任务）", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                streams: { stdout: { text: stdoutWithSession("sess-1") }, stderr: { text: "" } },
                exitCode: 0,
              }),
            200,
          );
        }),
    );
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => claudeFamily,
    });
    const { taskId } = await port.start!({ sessionId: "s" as never, task: "长任务", cwd: "/tmp" });
    const snapshot = await port.wait!(taskId, { timeoutMs: 10 });
    expect(snapshot).toMatchObject({ taskId, status: "running" });
    // 超时只结束这一次等待：任务本身没被取消，随后还能等到它收口。
    expect(await port.wait!(taskId, { timeoutMs: 5_000 })).toMatchObject({ status: "completed" });
  });

  it("后台任务：wait 未知 taskId 返回 undefined", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    const port = createExternalAgentPort({
      executionPort: { run: vi.fn() } as never,
      readBinding: async () => claudeFamily,
    });
    expect(await port.wait!("nope")).toBeUndefined();
  });

  it("后台任务：取消后状态为 cancelled", async () => {
    const { createExternalAgentPort } =
      await import("../src/zcode-protocol/external-agent-port-impl.js");
    // 永不结束的 run，模拟长任务；abort 后 resolve。
    const run = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                streams: { stdout: { text: stdoutWithSession("sess-1") }, stderr: { text: "" } },
                exitCode: 0,
              }),
            50,
          );
        }),
    );
    const port = createExternalAgentPort({
      executionPort: { run } as never,
      readBinding: async () => claudeFamily,
    });
    const { taskId } = await port.start!({ sessionId: "s" as never, task: "长任务", cwd: "/tmp" });
    const snapshot = await port.cancel!(taskId);
    expect(snapshot).toMatchObject({ taskId, status: "cancelled" });
    expect(await port.cancel!(taskId)).toBeUndefined();
  });
});

describe("外部 agent 实时输出", () => {
  it("argv 路径的 stdoutTail 快照差分成本次新增输出", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const chunks: string[] = [];
    const run = async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
      // 模拟执行端的累积尾部快照。
      options?.onEvent?.({ type: "progress", stdoutTail: "line1\n" });
      options?.onEvent?.({ type: "progress", stdoutTail: "line1\nline2\n" });
      options?.onEvent?.({ type: "progress", stdoutTail: "line1\nline2\nline3\n" });
      return {
        streams: { stdout: { text: "line1\nline2\nline3\n" }, stderr: { text: "" } },
        exitCode: 0,
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
    });
    await driver.run({
      binding: claudeFamily,
      prompt: "x",
      cwd: "/tmp",
      onOutput: (chunk) => {
        if (chunk.text) chunks.push(chunk.text);
      },
    });
    expect(chunks.join("")).toBe("line1\nline2\nline3\n");
  });

  it("artifact 超过重解析上限：只读尾部并标记 truncated", async () => {
    // 静默截断是最坏的一种"内容不全"：面板看起来完整，其实前面全丢了。
    // 这里钉住读取层的返回值，让 driver 能把标记透传成活动快照的 sourceTruncated。
    const { readFullStdout } = await import("../src/zcode-protocol/external-agent-driver.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ext-agent-truncate-"));
    try {
      const artifactPath = join(dir, "stdout.log");
      writeFileSync(artifactPath, "0123456789", "utf8");

      expect(readFullStdout({ text: "", artifactPath }, 4)).toEqual({
        text: "6789",
        truncated: true,
      });
      // 未超限：全文，不标记。
      expect(readFullStdout({ text: "", artifactPath }, 100)).toEqual({
        text: "0123456789",
        truncated: false,
      });
      // artifact 不可读：退回内存视图，不抛错。
      expect(readFullStdout({ text: "memory", artifactPath: join(dir, "missing.log") }, 4)).toEqual(
        {
          text: "memory",
          truncated: false,
        },
      );
      // 执行端自己报告的截断：没有 artifact 可回落时就是源数据不全。
      expect(readFullStdout({ text: "prefix", truncated: true })).toEqual({
        text: "prefix",
        truncated: true,
      });
      // 有完整 artifact 时 inline 截断不影响（全量读得到）。
      expect(readFullStdout({ text: "prefix", artifactPath, truncated: true }, 100)).toEqual({
        text: "0123456789",
        truncated: false,
      });
      // artifact 自己也被持久化上限截过：更早的字节真的没了。
      expect(
        readFullStdout({ text: "prefix", artifactPath, artifactTruncated: true }, 100),
      ).toEqual({
        text: "0123456789",
        truncated: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("流式正文之后不再补发 result 全文（过程面板不出现两遍）", async () => {
    // 回归：codebuddy 的 result 事件就是 assistant 正文的全文。正文已经以
    // 正文以完整 assistant 消息进过活动卡时，末尾再补一遍 result 会让同一段
    // 话出现两次（2026-11-04 的正文重复回归）。
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const answer = "上一个任务是连通性测试：回复 OK 加当前工作目录，且不修改任何文件。";
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
    });
    const resultLine = JSON.stringify({
      type: "result",
      result: answer,
      is_error: false,
    });
    const stdout = `${assistantLine}\n${resultLine}\n`;
    // 模拟 reporter 的语义：replace 整体替换，否则追加。
    let current: Array<{ kind: string; text: string }> = [];
    const run = async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
      options?.onEvent?.({ type: "progress", stdoutTail: `${assistantLine}\n` });
      options?.onEvent?.({ type: "progress", stdoutTail: stdout });
      return {
        streams: { stdout: { text: stdout }, stderr: { text: "" } },
        exitCode: 0,
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
    });
    await driver.run({
      binding: claudeFamily,
      prompt: "x",
      cwd: "/tmp",
      onOutput: (chunk) => {
        if (!chunk.entries?.length) return;
        current = chunk.replace ? [...chunk.entries] : [...current, ...chunk.entries];
      },
    });
    expect(
      current
        .filter((entry) => entry.kind === "text")
        .map((entry) => entry.text)
        .join(""),
    ).toBe(answer);
  });

  it("收口时用 stdout artifact 全量重解析并整体替换条目（replace）", async () => {
    // 执行中的条目来自滚动尾窗差分，行会被窗口切断、内容会重复/丢段；
    // 进程结束后 artifact 里有全量字节，收口必须以它为准。
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ext-agent-driver-"));
    try {
      const full = [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "第一段" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Bash", input: { command: "ls src" } }],
          },
        }),
        JSON.stringify({ type: "result", result: "第一段", is_error: false }),
        "",
      ].join("\n");
      const artifactPath = join(dir, "stdout.log");
      writeFileSync(artifactPath, full, "utf8");

      const chunks: Array<{
        entries?: Array<{ kind: string; text: string }>;
        replace?: boolean;
      }> = [];
      const run = async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
        // 模拟尾窗：第一段只到半行（被窗口切断），执行中解析不出来。
        options?.onEvent?.({ type: "progress", stdoutTail: `${full.slice(0, 40)}` });
        return {
          streams: {
            stdout: { text: "", artifactPath },
            stderr: { text: "" },
          },
          exitCode: 0,
        };
      };
      const driver = createOneShotExternalAgentDriver({
        executionPort: { run } as never,
      });
      const result = await driver.run({
        binding: claudeFamily,
        prompt: "x",
        cwd: "/tmp",
        onOutput: (chunk) => {
          if (chunk.entries?.length)
            chunks.push({ entries: chunk.entries, replace: chunk.replace });
        },
      });

      const replace = chunks.find((chunk) => chunk.replace);
      expect(replace).toBeDefined();
      expect(replace?.entries).toEqual([
        { kind: "text", text: "第一段" },
        { kind: "tool", text: "Bash: ls src" },
      ]);
      // 结果也要从全量 artifact 解析：inline 视图为空时不能再退回原始流。
      expect(result.text).toBe("第一段");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inline 视图只截到前 1MB 时，结果从 artifact 全量解析（不把 JSONL 回传给主 agent）", async () => {
    // 真实事故（2026-11-05）：6.5MB 输出的委派，inline 只保留前 1MB，
    // result 事件在末尾 → 解析失败 → outcome.text 变成 1MB 原始 JSONL，
    // 再被工具预算二次截断，主 agent 只能去翻 codebuddy 会话文件。
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ext-agent-driver-"));
    try {
      const report = "完整报告：" + "结论".repeat(2_000);
      const noise = Array.from({ length: 50 }, (_, index) =>
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `过程 ${index}` }],
          },
        }),
      );
      const full = [
        ...noise,
        JSON.stringify({ type: "result", result: report, is_error: false }),
        "",
      ].join("\n");
      const artifactPath = join(dir, "stdout.log");
      writeFileSync(artifactPath, full, "utf8");

      const run = async () => ({
        streams: {
          // inline 视图只给前 200 字节（模拟被 maxInlineBytes 截断），没有 result 行。
          stdout: { text: full.slice(0, 200), artifactPath },
          stderr: { text: "" },
        },
        exitCode: 0,
      });
      const driver = createOneShotExternalAgentDriver({
        executionPort: { run } as never,
      });
      const result = await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });

      expect(result.text).toBe(report);
      expect(result.text.startsWith('{"type"')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("解析不到 result 且 stdout 是 JSONL 时，返回可操作说明而不是原始流", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
      "",
    ].join("\n");
    const run = async () => ({
      streams: { stdout: { text: stdout, bytes: stdout.length }, stderr: { text: "" } },
      exitCode: 0,
    });
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
    });
    const result = await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });

    expect(result.text.startsWith("（外部 agent 执行结束")).toBe(true);
    expect(result.text).not.toContain('"type":"system"');
  });
});

describe("stream-json 活动文本", () => {
  it("assistant 的 tool_use / text 被压成人类可读行", async () => {
    const { formatClaudeFamilyStreamLine } = await import("@zcode/shared");
    const toolLine = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls src" } }],
      },
    });
    const textLine = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "正在检查目录结构" }] },
    });
    expect(formatClaudeFamilyStreamLine(toolLine)).toEqual(["→ Bash: ls src"]);
    expect(formatClaudeFamilyStreamLine(textLine)).toEqual(["正在检查目录结构"]);
    // system / user / 半行 JSON 都不产出内容
    expect(formatClaudeFamilyStreamLine(JSON.stringify({ type: "system" }))).toEqual([]);
    expect(formatClaudeFamilyStreamLine('{"type": "assis')).toEqual([]);
  });
});

// ── opencode 驱动分派（2026-11-08）──
// `opencode run --format json` 与 claude-family 一样是逐行 JSON 事件，但字段形状
// 不同（part.text / part.tool / part.state.input）。把"能不能流式解析"收成能力表
// 以后，这里要钉住的是：驱动表认出了 opencode，且走的是同一条读取/重建流程。

const opencodeBinding: ExternalAgentBinding = {
  label: "OpenCode",
  driver: "opencode-exec",
  command: "opencode",
  args: ["run", "--format", "json"],
  promptDelivery: "stdin",
  permissionMode: "auto",
};

function opencodeLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

describe("opencode 实时输出与收口", () => {
  it("stdout 的 JSONL 被解析成 text/reasoning/tool 条目，而不是原样倾倒", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const jsonl = [
      opencodeLine({ type: "step_start", sessionID: "ses_1" }),
      opencodeLine({ type: "text", sessionID: "ses_1", part: { text: "好的，我看看" } }),
      opencodeLine({
        type: "tool_use",
        sessionID: "ses_1",
        part: { tool: "bash", state: { input: { command: "ls src" } } },
      }),
      opencodeLine({ type: "reasoning", sessionID: "ses_1", part: { text: "先看目录" } }),
      opencodeLine({ type: "step_finish", sessionID: "ses_1" }),
    ].join("");
    const entries: Array<{ kind: string; text: string }> = [];
    const replaceFrames: Array<Array<{ kind: string; text: string }>> = [];
    const rawText: string[] = [];
    const run = async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
      // 尾窗快照逐段增长：只解析出完整行，半行留缓冲。
      options?.onEvent?.({ type: "progress", stdoutTail: jsonl.slice(0, 60) });
      options?.onEvent?.({ type: "progress", stdoutTail: jsonl });
      return { streams: { stdout: { text: jsonl }, stderr: { text: "" } }, exitCode: 0 };
    };
    const driver = createOneShotExternalAgentDriver({ executionPort: { run } as never });
    const result = await driver.run({
      binding: opencodeBinding,
      prompt: "看看 src",
      cwd: "/tmp",
      onOutput: (chunk) => {
        if (chunk.entries?.length) {
          entries.push(...chunk.entries);
          if (chunk.replace) replaceFrames.push(chunk.entries);
        }
        if (chunk.text) rawText.push(chunk.text);
      },
    });
    // 收口权威重建把条目定格成三类，顺序与事件顺序一致；实时条目会被整体替换，
    // 所以只断言最后一帧 replace 的内容（面板最终看到的就是它）。
    expect(replaceFrames.at(-1)).toEqual([
      { kind: "text", text: "好的，我看看" },
      { kind: "tool", text: "bash: ls src" },
      { kind: "reasoning", text: "先看目录" },
    ]);
    // 原始 JSONL 绝不能当成进度正文再推一遍（面板里会出现一堆 JSON）。
    expect(rawText).toEqual([]);
    expect(result.text).toBe("好的，我看看");
    expect(result.externalSessionId).toBe("ses_1");
  });

  it("收口时读 artifact 全量重解析并整体替换条目（replace）", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ext-agent-opencode-"));
    try {
      const full = [
        opencodeLine({ type: "text", sessionID: "ses_2", part: { text: "第一段" } }),
        opencodeLine({
          type: "tool_use",
          sessionID: "ses_2",
          part: { tool: "read", state: { input: { path: "src/a.ts" } } },
        }),
        opencodeLine({ type: "text", sessionID: "ses_2", part: { text: "第二段" } }),
      ].join("");
      const artifactPath = join(dir, "stdout.log");
      writeFileSync(artifactPath, full, "utf8");

      const chunks: Array<{
        entries?: Array<{ kind: string; text: string }>;
        replace?: boolean;
      }> = [];
      const run = async (_request: unknown, options?: { onEvent?: (event: unknown) => void }) => {
        // 执行中的尾窗只到半行（被窗口切断）→ 实时解析不出条目。
        options?.onEvent?.({ type: "progress", stdoutTail: full.slice(0, 50) });
        return {
          streams: { stdout: { text: "", artifactPath }, stderr: { text: "" } },
          exitCode: 0,
        };
      };
      const driver = createOneShotExternalAgentDriver({ executionPort: { run } as never });
      const result = await driver.run({
        binding: opencodeBinding,
        prompt: "x",
        cwd: "/tmp",
        onOutput: (chunk) => {
          if (chunk.entries?.length)
            chunks.push({ entries: chunk.entries, replace: chunk.replace });
        },
      });

      const replace = chunks.find((chunk) => chunk.replace);
      expect(replace).toBeDefined();
      expect(replace?.entries).toEqual([
        { kind: "text", text: "第一段" },
        { kind: "tool", text: "read: src/a.ts" },
        { kind: "text", text: "第二段" },
      ]);
      expect(result.text).toBe("第一段\n\n第二段");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("解析不出正文时不把原始 JSONL 当结果回传", async () => {
    // 与 claude-family 同一条防线：JSONL 是证据，不是回答。
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const jsonl = opencodeLine({ type: "step_start", sessionID: "ses_3" });
    const run = async () => ({
      streams: { stdout: { text: jsonl, bytes: jsonl.length }, stderr: { text: "" } },
      exitCode: 0,
    });
    const driver = createOneShotExternalAgentDriver({ executionPort: { run } as never });
    const result = await driver.run({ binding: opencodeBinding, prompt: "x", cwd: "/tmp" });
    expect(result.text).not.toContain('"type"');
    expect(result.text).toContain("没有读到可解析的输出");
  });

  it("parseExternalAgentResult: opencode 走 JSONL 解析（多段 text + 错误行）", () => {
    expect(
      parseExternalAgentResult(
        opencodeBinding,
        [
          opencodeLine({ type: "text", sessionID: "ses_4", part: { text: "第一段" } }),
          opencodeLine({ type: "text", sessionID: "ses_4", part: { text: "第二段" } }),
        ].join(""),
      ),
    ).toEqual({ text: "第一段\n\n第二段", isError: false, sessionId: "ses_4" });

    expect(
      parseExternalAgentResult(
        opencodeBinding,
        opencodeLine({ type: "error", error: { message: "provider unauthorized" } }),
      ),
    ).toMatchObject({ text: "provider unauthorized", isError: true });
  });
});

// ── 进度看门狗（2026-11-08）──
// 601s 现场的根因：timeoutMs 被当成硬超时，到点无条件 kill，健康 agent 只要
// 跑得久就会被杀。改成"停滞才终止"后，这里要钉住四种情况：
// 持续有进度不被杀、停滞被杀且文案明确、活动会重置计时、用户取消与停滞可区分。

/** 用真实计时器跑看门狗：阈值压到毫秒级，用例等待时间可控。 */
const STALL_TIMEOUT_MS = 60;
const STALL_CHECK_INTERVAL_MS = 10;
/** 持续有进度时"跑多久"：明显超过停滞阈值，证明时长本身不再触发终止。 */
const HEALTHY_RUN_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("进度看门狗", () => {
  it("持续有进度事件：远超停滞阈值也不中止，正常返回结果", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const captured: Array<Record<string, unknown>> = [];
    const run = async (
      request: unknown,
      options?: {
        onEvent?: (event: unknown) => void;
        abortSignal?: AbortSignal;
      },
    ) => {
      captured.push({ request, signal: options?.abortSignal });
      // 每 20ms 报一次进度，持续 200ms（≈3 倍停滞阈值）。
      for (let index = 0; index < HEALTHY_RUN_MS / 20; index += 1) {
        await sleep(20);
        options?.onEvent?.({ type: "progress", stdoutTail: `chunk ${index}\n` });
      }
      expect(options?.abortSignal?.aborted).toBe(false);
      return {
        streams: {
          stdout: {
            text: JSON.stringify({
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "干完了" }] },
            }),
            ...{},
          },
          stderr: { text: "" },
        },
        exitCode: 0,
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      stallCheckIntervalMs: STALL_CHECK_INTERVAL_MS,
    });
    const result = await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });
    expect(result.isError).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(HEALTHY_RUN_MS - 20);
  });

  it("停滞：发一次进度后沉默 → 看门狗中止，isError 且文案说明无新输出", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const run = async (
      _request: unknown,
      options?: { onEvent?: (event: unknown) => void; abortSignal?: AbortSignal },
    ) => {
      options?.onEvent?.({ type: "progress", stdoutTail: "开始\n" });
      // 一直沉默，直到被中止；模拟端口对 abortSignal 的响应。
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        streams: { stdout: { text: "" }, stderr: { text: "" } },
        exitCode: null,
        error: { kind: "cancelled" },
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      stallCheckIntervalMs: STALL_CHECK_INTERVAL_MS,
    });
    const result = await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.text).toContain("无新输出");
    expect(result.text).toContain("已自动终止");
  });

  it("进度事件会重置计时：总时长超阈值，但每次间隔都短于阈值 → 不中止", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    let aborted = false;
    const run = async (
      _request: unknown,
      options?: { onEvent?: (event: unknown) => void; abortSignal?: AbortSignal },
    ) => {
      options?.abortSignal?.addEventListener("abort", () => (aborted = true), { once: true });
      // 每次间隔 40ms < 60ms 阈值，但累计 6 次 = 240ms 远超阈值。
      for (let index = 0; index < 6; index += 1) {
        await sleep(40);
        options?.onEvent?.({ type: "progress", stderrTail: `tick ${index}\n` });
      }
      return {
        streams: {
          stdout: {
            text: JSON.stringify({
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            }),
          },
          stderr: { text: "" },
        },
        exitCode: 0,
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
      stallTimeoutMs: STALL_TIMEOUT_MS,
      stallCheckIntervalMs: STALL_CHECK_INTERVAL_MS,
    });
    const result = await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });
    expect(aborted).toBe(false);
    expect(result.isError).toBe(false);
  });

  it("用户取消：立即中止，文案不与「无新输出」混淆", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const run = async (_request: unknown, options?: { abortSignal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        streams: { stdout: { text: "" }, stderr: { text: "" } },
        exitCode: null,
        error: { kind: "cancelled" },
      };
    };
    const driver = createOneShotExternalAgentDriver({
      executionPort: { run } as never,
      // 阈值给得很大：取消必须立刻生效，不能等看门狗。
      stallTimeoutMs: 10_000,
      stallCheckIntervalMs: 10,
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 10);
    const result = await driver.run({
      binding: claudeFamily,
      prompt: "x",
      cwd: "/tmp",
      signal: controller.signal,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.text).not.toContain("无新输出");
  });

  it("传给 port 的 timeoutMs 是硬顶兜底：缺省 1 小时，绑定值优先", async () => {
    const { createOneShotExternalAgentDriver } =
      await import("../src/zcode-protocol/external-agent-driver.js");
    const timeouts: number[] = [];
    const run = async (request: { timeoutMs?: number }) => {
      timeouts.push(request.timeoutMs ?? -1);
      return { streams: { stdout: { text: "" }, stderr: { text: "" } }, exitCode: 0 };
    };
    const driver = createOneShotExternalAgentDriver({ executionPort: { run } as never });
    await driver.run({ binding: claudeFamily, prompt: "x", cwd: "/tmp" });
    await driver.run({
      binding: { ...claudeFamily, timeoutMs: 120_000 },
      prompt: "x",
      cwd: "/tmp",
    });
    expect(timeouts).toEqual([3_600_000, 120_000]);
  });
});
