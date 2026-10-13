import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "../src/deps.js";
import { runToolAgentLoop } from "../src/memory/memory-agent-loop.js";

/** 最小模型桩：每轮返回一个 Read 工具调用（永不给出正文），用于验证软停止。 */
function loopingModelStub(): Model {
  return {
    properties: { inputFormat: {} },
    optionSpecs: {
      reasoningLevel: { values: [] },
      maxOutputTokens: { max: 8192 },
    },
    async generateText(request: unknown) {
      void request;
      return {
        text: "",
        finishReason: "tool-calls",
        toolCalls: [{ id: "call-1", name: "Read", input: { file_path: "a.ts" } }],
      };
    },
  } as unknown as Model;
}

const baseInput = {
  executeTool: () =>
    Promise.resolve({
      toolCallId: "call-1",
      toolName: "Read",
      success: true,
      output: "ok",
      durationMs: 1,
      startedAt: new Date(0),
      completedAt: new Date(0),
    }),
  evaluateToolPolicy: () => ({ allowed: true }) as const,
  maxTurns: 10,
  messages: [{ role: "user", content: "review" }] as never[],
  model: loopingModelStub(),
  rootDir: "/repo",
  tools: [],
  workingDirectory: "/repo",
  workspaceRoot: "/repo",
};

test("shouldStop：软停止在下一轮边界结束循环（区别于 abort 抛错）", async () => {
  let calls = 0;
  const result = await runToolAgentLoop({
    ...baseInput,
    shouldStop: () => {
      calls += 1;
      return calls >= 3;
    },
  });
  // 第 3 轮边界触发软停止：只完成 2 轮生成 + 2 轮工具执行。
  assert.equal(result.turns, 2);
  assert.equal(result.messages.filter((m) => m.role === "assistant").length, 2);
});

test("shouldStop 恒 false：循环由 maxTurns 收口（原语义不变）", async () => {
  const result = await runToolAgentLoop({
    ...baseInput,
    shouldStop: () => false,
  });
  assert.equal(result.turns, 10);
});

test("无 shouldStop：maxTurns 收口（memory 原行为不回归）", async () => {
  const result = await runToolAgentLoop({ ...baseInput });
  assert.equal(result.turns, 10);
});
