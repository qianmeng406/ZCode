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
  it("claude-family 默认用 -p + --output-format json，prompt 追加在末尾", () => {
    expect(buildExternalAgentInvocation(claudeFamily, "修一下 lint")).toEqual({
      command: "codebuddy",
      args: ["-p", "--output-format", "json", "修一下 lint"],
    });
  });

  it("claude-family 带 permissionMode 时补上 --permission-mode", () => {
    const invocation = buildExternalAgentInvocation(
      { ...claudeFamily, permissionMode: "plan" },
      "分析一下",
    );
    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "分析一下",
    ]);
  });

  it("claude-family + stdin 交付：prompt 不进 argv", () => {
    const invocation = buildExternalAgentInvocation(
      { ...claudeFamily, promptDelivery: "stdin" },
      "长计划正文",
    );
    expect(invocation.args).toEqual(["-p", "--output-format", "json"]);
    expect(invocation.stdin).toBe("长计划正文");
  });

  it("claude-family 自定义 args 时不再补默认参数", () => {
    const invocation = buildExternalAgentInvocation(
      { ...claudeFamily, args: ["-p", "--output-format", "stream-json"] },
      "hi",
    );
    expect(invocation.args).toEqual(["-p", "--output-format", "stream-json", "hi"]);
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
    // 调用形状：argv 模式 + 末尾追加 prompt。
    expect(run).toHaveBeenCalledTimes(1);
    const request = (run.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request.command).toMatchObject({
      mode: "argv",
      file: "codebuddy",
      args: ["-p", "--output-format", "json", "修 lint"],
    });
    expect(request.cwd).toBe("/tmp");
  });
});
