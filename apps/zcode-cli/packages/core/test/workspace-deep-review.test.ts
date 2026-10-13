import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelStreamEvent, ModelUsage } from "../src/deps.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../src/tool/types.js";
import {
  describeDeepReviewToolTarget,
  evaluateDeepReviewToolPolicy,
  runDeepReviewAgentLoop,
} from "../src/runtime/methods/workspace-deep-review.js";
import { streamModelTextResult } from "../src/runtime/methods/workspace-generate-text.js";
import { runToolAgentLoop } from "../src/memory/memory-agent-loop.js";

/** evaluateDeepReviewToolPolicy 只需要 workingDirectory/workspaceRoot 两个字段。 */
const fakeRuntime = {
  workingDirectory: "/repo",
  workspaceRoot: "/repo",
} as unknown as Parameters<typeof evaluateDeepReviewToolPolicy>[1];

function toolCall(name: string, input: unknown) {
  return { id: `call-${name}`, name, input };
}

test("深度审查策略：读类工具放行，写工具与非只读 Bash 一律拒绝", () => {
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Read", {}), fakeRuntime), {
    allowed: true,
  });
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Grep", {}), fakeRuntime), {
    allowed: true,
  });
  assert.deepEqual(evaluateDeepReviewToolPolicy(toolCall("Glob", {}), fakeRuntime), {
    allowed: true,
  });

  const bashRead = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "ls -la src" }),
    fakeRuntime,
  );
  assert.equal(bashRead.allowed, true);

  const bashWrite = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "rm -rf /tmp/x" }),
    fakeRuntime,
  );
  assert.equal(bashWrite.allowed, false);
  if (!bashWrite.allowed) assert.match(bashWrite.reason, /read-only/i);

  const write = evaluateDeepReviewToolPolicy(
    toolCall("Write", { file_path: "/repo/a.ts" }),
    fakeRuntime,
  );
  assert.equal(write.allowed, false);

  const agent = evaluateDeepReviewToolPolicy(toolCall("Agent", {}), fakeRuntime);
  assert.equal(agent.allowed, false);
});

test("深度审查路径边界：工作区内放行，穿越与工作区外绝对路径拒绝", () => {
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(toolCall("Read", { file_path: "/repo/src/a.ts" }), fakeRuntime),
    { allowed: true },
  );
  // 相对路径相对工作目录解析后仍在工作区内
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(toolCall("Read", { file_path: "src/a.ts" }), fakeRuntime),
    { allowed: true },
  );
  // .. 穿越逃逸
  const escape = evaluateDeepReviewToolPolicy(
    toolCall("Read", { file_path: "../outside/a.ts" }),
    fakeRuntime,
  );
  assert.equal(escape.allowed, false);
  // 绝对路径在工作区外
  const outside = evaluateDeepReviewToolPolicy(
    toolCall("Read", { file_path: "/etc/passwd" }),
    fakeRuntime,
  );
  assert.equal(outside.allowed, false);
  if (!outside.allowed) assert.match(outside.reason, /workspace/i);
  // Grep 的目录参数同样受限；Glob 的相对 pattern 放行
  const grepOutside = evaluateDeepReviewToolPolicy(
    toolCall("Grep", { pattern: "x", path: "/var/log" }),
    fakeRuntime,
  );
  assert.equal(grepOutside.allowed, false);
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(toolCall("Glob", { pattern: "src/**/*.ts" }), fakeRuntime),
    { allowed: true },
  );
});

test("深度审查 Bash 路径扫描：只读命令引用工作区外路径被拒，选项与相对路径放行", () => {
  // 只读命令但目标在工作区外：拒绝并提示改用 Read/Grep/Glob
  const outside = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "cat /etc/passwd" }),
    fakeRuntime,
  );
  assert.equal(outside.allowed, false);
  if (!outside.allowed) assert.match(outside.reason, /workspace/i);
  // 相对路径、选项、工作区内绝对路径都放行
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(toolCall("Bash", { command: "ls src/a.ts" }), fakeRuntime),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(toolCall("Bash", { command: "ls -la /repo/src" }), fakeRuntime),
    { allowed: true },
  );
  // URL 不按路径检查（交给工具语义）；分类器放行 cat 时不再被路径扫描误拒
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(
      toolCall("Bash", { command: "cat /repo/src/a.ts | grep https://example.com" }),
      fakeRuntime,
    ),
    { allowed: true },
  );
});

test("深度审查路径边界：HOME 相对与裸父目录一律拒绝（Bash 展开后在工作区外）", () => {
  // `~` / `~/x`：win32 下 isAbsolute=false 会被当相对路径解析回工作区内，
  // 但 Bash 会真实展开到 HOME —— 必须显式拒绝。
  for (const path of ["~", "~/secrets.txt", "~\\secrets.txt"]) {
    const read = evaluateDeepReviewToolPolicy(toolCall("Read", { file_path: path }), fakeRuntime);
    assert.equal(read.allowed, false);
  }
  const bashHome = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "cat ~/AppData/Local/Temp/probe.txt" }),
    fakeRuntime,
  );
  assert.equal(bashHome.allowed, false);
  // 裸 `..` 无分隔符，会被 looksLikePath 跳过；`..` 展开后在父目录。
  for (const command of ["ls ..", "ls ../wf-trial", "cat ..\\outside.txt"]) {
    const result = evaluateDeepReviewToolPolicy(toolCall("Bash", { command }), fakeRuntime);
    assert.equal(result.allowed, false);
  }
});

test("深度审查路径边界：git-bash 盘符路径（/c/...）归一后按工作区包含判定", () => {
  const winRuntime = {
    workingDirectory: "C:\\repo",
    workspaceRoot: "C:\\repo",
  } as unknown as Parameters<typeof evaluateDeepReviewToolPolicy>[1];
  // MSYS 盘符路径指向工作区内：不应误拒（模型会复用 Bash 输出的路径形式）。
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(
      toolCall("Bash", { command: "ls /c/repo/src" }),
      winRuntime,
    ),
    { allowed: true },
  );
  assert.deepEqual(
    evaluateDeepReviewToolPolicy(
      toolCall("Read", { file_path: "/c/repo/src/a.ts" }),
      winRuntime,
    ),
    { allowed: true },
  );
  // 其它盘符仍是工作区外。
  const other = evaluateDeepReviewToolPolicy(
    toolCall("Bash", { command: "cat /d/other/secret.txt" }),
    winRuntime,
  );
  assert.equal(other.allowed, false);
});

/** 每轮返回固定事件流的假模型（streamText 路径）。 */
function fakeModel(script: ModelStreamEvent[][]): Model {
  let index = 0;
  return {
    // media 投影策略读取 inputFormat；辅助档请求选项读取 optionSpecs。纯文本假模型。
    properties: { inputFormat: "text" },
    optionSpecs: {
      reasoningLevel: { values: ["low"] },
      maxOutputTokens: { min: 1, max: 8192 },
    },
    streamText: async function* () {
      const events = script[Math.min(index, script.length - 1)]!;
      index += 1;
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as Model;
}

const usage: ModelUsage = {
  inputTokens: 5,
  outputTokens: 3,
  totalTokens: 8,
} as unknown as ModelUsage;

const finish = { type: "finish" as const, finishReason: "stop", usage };

test("runToolAgentLoop（深度审查共用骨架）：策略拒绝回填错误消息，工具结果进入下一轮", async () => {
  const executed: string[] = [];
  const executeTool = async (call: ExecutableToolCall): Promise<ToolExecutionResult> => {
    executed.push(call.name);
    return { toolCallId: call.id, toolName: call.name, success: true, output: "ok" };
  };
  const events: Array<{ turn: number; phase: string; toolName?: string }> = [];

  const result = await runToolAgentLoop({
    maxTurns: 5,
    messages: [{ role: "user", content: "review" }],
    generate: async (model, request) => {
      const r = await streamModelTextResult(model, request);
      return { text: r.text, toolCalls: r.toolCalls };
    },
    model: fakeModel([
      [{ type: "tool_call", toolCall: { id: "call-Write", name: "Write", input: {} } }, finish],
      [{ type: "text_delta", text: "VERDICT: PASS" }, finish],
    ]),
    rootDir: "/repo",
    tools: [
      { name: "Write", inputSchema: {} },
      { name: "Read", inputSchema: {} },
    ] as never,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    onTurn: (event) => events.push(event),
    // 全禁策略：任何工具都拒绝（覆盖「拒绝理由回填下一轮」路径）。
    evaluateToolPolicy: () => ({ allowed: false, reason: "denied-by-test" }),
    executeTool,
  });

  assert.deepEqual(executed, []); // 被策略拒绝的工具不落执行面
  // 第二轮请求的消息里应带第一条 assistant(toolCalls) + 拒绝错误 + 收尾正文
  assert.equal(result.turns, 2);
  const eventsByPhase = events.map((event) => event.phase);
  assert.deepEqual(eventsByPhase, ["generate", "tool", "generate"]);
  assert.equal(events[1]?.toolName, "Write");
});

test("runToolAgentLoop：maxTurns 到顶即收，不再发起下一轮生成", async () => {
  const alwaysTool: ModelStreamEvent[] = [
    { type: "tool_call", toolCall: { id: "c1", name: "Read", input: {} } },
    finish,
  ];
  const result = await runToolAgentLoop({
    maxTurns: 3,
    messages: [{ role: "user", content: "review" }],
    generate: async (model, request) => {
      const r = await streamModelTextResult(model, request);
      return { text: r.text, toolCalls: r.toolCalls };
    },
    model: fakeModel([alwaysTool]),
    rootDir: "/repo",
    tools: [{ name: "Read", inputSchema: {} }] as never,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    evaluateToolPolicy: () => ({ allowed: true }),
    executeTool: async (call) => ({
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      output: "ok",
    }),
  });
  // maxTurns=3 → 恰好 3 轮（每轮都要求工具），第 4 轮不发生
  assert.equal(result.turns, 3);
});

test("runDeepReviewAgentLoop：端到端聚合 usage/正文，进度携带轮次与工具名", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      // executor 会经 registry.get 取 entry 执行；给最小 handler 假实现。
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({
          toolCallId: "",
          toolName: name,
          success: true,
          output: "ok",
        }),
      }),
      has: () => true,
      list: () => ["Read", "Write"],
      toContracts: () => [
        { name: "Read", description: "read", inputSchema: {} },
        { name: "Write", description: "write", inputSchema: {} },
      ],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const progress: Array<{ round?: number; toolName?: string; outputChars: number }> = [];
  const result = await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      [{ type: "tool_call", toolCall: { id: "r1", name: "Read", input: {} } }, finish],
      [{ type: "text_delta", text: "VERDICT: FAIL" }, finish],
    ]),
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.text, "VERDICT: FAIL");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.outputTokens, 6); // 两轮各 3，累计
  assert.equal(result.turns, 2);
  // 进度事件：轮 1 工具执行带 round+toolName；轮 2 生成带 round 与产出字符
  assert.ok(progress.some((p) => p.round === 1 && p.toolName === "Read"));
  assert.ok(progress.some((p) => p.round === 2 && p.outputChars > 0));
});

test("深度审查进度字符跨轮累计：第二轮进度从第一轮末尾继续，不回跳", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({ toolCallId: "", toolName: name, success: true, output: "ok" }),
      }),
      has: () => true,
      list: () => ["Read"],
      toContracts: () => [{ name: "Read", description: "read", inputSchema: {} }],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const progress: number[] = [];
  await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      // 第一轮：先吐 4 字符正文，再要一个工具
      [
        { type: "text_delta", text: "看代码" },
        { type: "tool_call", toolCall: { id: "r1", name: "Read", input: {} } },
        finish,
      ],
      // 第二轮：再吐正文收尾
      [{ type: "text_delta", text: "VERDICT: PASS" }, finish],
    ]),
    onProgress: (p) => progress.push(p.outputChars),
  });

  // 第一轮进度：3（"看代码"）；第二轮从 3 起继续累计，全程单调不减
  assert.ok(progress.includes("看代码".length));
  const max = Math.max(...progress);
  assert.equal(max, "看代码".length + "VERDICT: PASS".length);
  assert.deepEqual(
    [...progress].sort((a, b) => a - b),
    progress,
  );
});

test("深度审查进度字符跨轮累计：思考增量主导时也不回跳（原按正文长度设偏移会回跳）", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({ toolCallId: "", toolName: name, success: true, output: "ok" }),
      }),
      has: () => true,
      list: () => ["Read"],
      toContracts: () => [{ name: "Read", description: "read", inputSchema: {} }],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const progress: number[] = [];
  await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      // 第一轮：大量思考增量 + 极短正文 + 一个工具调用
      [
        { type: "reasoning_delta", text: "深".repeat(100) },
        { type: "text_delta", text: "略" },
        { type: "tool_call", toolCall: { id: "r1", name: "Read", input: {} } },
        finish,
      ],
      [{ type: "text_delta", text: "VERDICT: PASS" }, finish],
    ]),
    onProgress: (p) => progress.push(p.outputChars),
  });

  // 第二轮从第一轮最后上报的值（101）继续，而不是从正文长度（1）重算
  assert.ok(progress.some((value) => value >= 101));
  assert.deepEqual(
    [...progress].sort((a, b) => a - b),
    progress,
    `进度应单调不减，实际 ${progress.join(",")}`,
  );
});

test("工具展示目标：Read 取路径、Grep/Glob 取 pattern、Bash 取命令、超长截断", () => {
  assert.equal(
    describeDeepReviewToolTarget({ id: "1", name: "Read", input: { file_path: "src/a.ts" } }),
    "src/a.ts",
  );
  assert.equal(
    describeDeepReviewToolTarget({
      id: "2",
      name: "Grep",
      input: { pattern: "TODO", path: "src" },
    }),
    "TODO (src)",
  );
  assert.equal(
    describeDeepReviewToolTarget({ id: "3", name: "Glob", input: { pattern: "**/*.ts" } }),
    "**/*.ts",
  );
  assert.equal(
    describeDeepReviewToolTarget({
      id: "4",
      name: "Bash",
      input: { command: "git log --oneline" },
    }),
    "git log --oneline",
  );
  assert.equal(describeDeepReviewToolTarget({ id: "5", name: "Read", input: {} }), undefined);
  const long = describeDeepReviewToolTarget({
    id: "6",
    name: "Bash",
    input: { command: "x".repeat(300) },
  });
  assert.equal(long?.length, 121); // 120 + 省略号
  assert.ok(long?.endsWith("…"));
});

test("深度审查进度携带工具目标", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({ toolCallId: "", toolName: name, success: true, output: "ok" }),
      }),
      has: () => true,
      list: () => ["Read"],
      toContracts: () => [{ name: "Read", description: "read", inputSchema: {} }],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const events: Array<{ toolName?: string; toolTarget?: string }> = [];
  await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      [
        {
          type: "tool_call",
          toolCall: { id: "r1", name: "Read", input: { file_path: "src/x.ts" } },
        },
        finish,
      ],
      [{ type: "text_delta", text: "VERDICT: PASS" }, finish],
    ]),
    onProgress: (p) => events.push({ toolName: p.toolName, toolTarget: p.toolTarget }),
  });

  assert.ok(events.some((e) => e.toolName === "Read" && e.toolTarget === "src/x.ts"));
});

test("深度审查收尾：轮次用尽且末轮只有工具调用时，追加禁工具收尾轮强制给出结论", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      get: (name: string) => ({
        metadata: { name },
        name,
        description: "test tool",
        inputSchema: {},
        handler: async () => ({ toolCallId: "", toolName: name, success: true, output: "ok" }),
      }),
      has: () => true,
      list: () => ["Read"],
      toContracts: () => [{ name: "Read", description: "read", inputSchema: {} }],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  // 动态假模型：前 toolRounds 次调用只调工具、无正文；之后才给结论。
  // 取 24（= DEEP_REVIEW_MAX_TURNS）以耗尽轮次，触发收尾轮（第 25 次调用）。
  function toolOnlyUntil(toolRounds: number): Model {
    let call = 0;
    return {
      properties: { inputFormat: "text" },
      optionSpecs: {
        reasoningLevel: { values: ["low"] },
        maxOutputTokens: { min: 1, max: 8192 },
      },
      streamText: async function* () {
        call += 1;
        if (call <= toolRounds) {
          yield { type: "tool_call", toolCall: { id: `r${call}`, name: "Read", input: {} } };
        } else {
          yield { type: "text_delta", text: "VERDICT: PASS" };
        }
        yield finish;
      },
    } as unknown as Model;
  }

  const result = await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: toolOnlyUntil(24),
  });

  assert.equal(result.text, "VERDICT: PASS");
  assert.equal(result.finishReason, "stop");
  // 收尾轮也计入 usage（25 轮 × 3 output tokens）
  assert.equal(result.usage.outputTokens, 75);
});

test("深度审查收尾：已有结论时不再追加收尾轮（省一次请求）", async () => {
  const runtime = {
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId: "s",
    config: {},
    registry: {
      get: () => undefined,
      has: () => false,
      list: () => [],
      toContracts: () => [],
    },
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    sessionStore: {},
    skillPort: undefined,
  } as unknown as Parameters<typeof runDeepReviewAgentLoop>[0];

  const result = await runDeepReviewAgentLoop(runtime, {
    messages: [{ role: "user", content: "review" }],
    model: fakeModel([
      [{ type: "text_delta", text: "VERDICT: WARN" }, { type: "text_delta", text: " ok" }, finish],
    ]),
  });
  assert.equal(result.text, "VERDICT: WARN ok");
  // 只有一轮：usage 为 3（若追加收尾轮会是 6）
  assert.equal(result.usage.outputTokens, 3);
});
