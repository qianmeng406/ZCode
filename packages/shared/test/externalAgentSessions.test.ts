import assert from "node:assert/strict";
import test from "node:test";
import {
  cwdToCommandCodeProjectDirName,
  cwdToProjectDirName,
  cwdToQoderProjectDirName,
  parseClaudeFamilyTranscript,
  parseCommandCodeTranscript,
  parseOpencodeSessionExport,
  scanClaudeFamilySessionFile,
  scanClaudeFamilySessionsFromLines,
  scanCommandCodeSessionFile,
} from "../src/externalAgentSessions.js";

test("cwdToQoderProjectDirName: 盘符保留大小写、冒号也折叠（C:\\x → C--x）", () => {
  // 2026-11-10 实测 ~/.qoder/projects 与 ~/.qoder-cn/projects 的真实目录名。
  assert.equal(cwdToQoderProjectDirName("C:\\Users\\qianmengyys"), "C--Users-qianmengyys");
  assert.equal(
    cwdToQoderProjectDirName("C:\\Users\\q\\Desktop\\agent"),
    "C--Users-q-Desktop-agent",
  );
  // 与默认规则必须产生不同结果（否则两个 qoder 预设会扫到 codebuddy 的目录）。
  assert.notEqual(
    cwdToQoderProjectDirName("C:\\Users\\q\\Desktop\\agent"),
    cwdToProjectDirName("C:\\Users\\q\\Desktop\\agent"),
  );
});

test("cwdToProjectDirName: 盘符冒号丢弃、分隔符换成 - 且去掉首尾", () => {
  assert.equal(cwdToProjectDirName("c:\\Users\\q\\Desktop\\agent"), "c-Users-q-Desktop-agent");
  assert.equal(cwdToProjectDirName("/home/u/work"), "home-u-work");
  assert.equal(cwdToProjectDirName("c:\\trailing\\"), "c-trailing");
});

test("cwdToProjectDirName: 盘符大小写归一（CLI 落盘用小写盘符）", () => {
  assert.equal(cwdToProjectDirName("C:\\Users\\q\\Desktop\\agent"), "c-Users-q-Desktop-agent");
});

test("cwdToCommandCodeProjectDirName: 与 @sindresorhus/slugify 一致", () => {
  // 2026-11-09 实测 Command Code 的目录名规则（@sindresorhus/slugify）：
  // 小写、非拉丁字符丢弃、非字母数字连续段折叠为 -、空结果回 root。
  assert.equal(cwdToCommandCodeProjectDirName("/tmp/slugtest/Sub_Dir"), "tmp-slugtest-sub-dir");
  assert.equal(
    cwdToCommandCodeProjectDirName("/tmp/slug test/Sub_Dir_2"),
    "tmp-slug-test-sub-dir-2",
  );
  assert.equal(cwdToCommandCodeProjectDirName("C:\\Users\\Foo\\Bar"), "c-users-foo-bar");
  assert.equal(cwdToCommandCodeProjectDirName("/tmp/foo.bar/baz@qux"), "tmp-foo-bar-baz-qux");
  assert.equal(cwdToCommandCodeProjectDirName("/home/Café"), "home-cafe");
  assert.equal(cwdToCommandCodeProjectDirName("/Users/张三/项目/测试"), "users");
  assert.equal(cwdToCommandCodeProjectDirName("/"), "root");
});

test("扫描：summary 优先于 ai-title，sessionId 取 meta 里的（可能与文件名不同）", () => {
  const summary = scanClaudeFamilySessionFile(
    [
      JSON.stringify({ type: "session-meta", sessionId: "real-id", timestamp: 100 }),
      JSON.stringify({ type: "summary", summary: "了解工作区", timestamp: 200 }),
      JSON.stringify({ type: "ai-title", aiTitle: "Explore workspace", timestamp: 300 }),
    ].join("\n"),
    "file-name-id",
    999,
  );
  assert.ok(summary);
  assert.equal(summary.sessionId, "real-id");
  assert.equal(summary.title, "了解工作区");
  assert.equal(summary.updatedAt, 300);
});

test("扫描：无 summary/ai-title 时退回首条用户输入（跳过 system-reminder）", () => {
  const summary = scanClaudeFamilySessionFile(
    [
      JSON.stringify({
        type: "message",
        role: "user",
        timestamp: 10,
        content: [{ type: "input_text", text: "<system-reminder>internal</system-reminder>" }],
      }),
      JSON.stringify({
        type: "message",
        role: "user",
        timestamp: 20,
        content: [{ type: "input_text", text: "帮我看看目录结构" }],
      }),
    ].join("\n"),
    "sid",
    0,
  );
  assert.ok(summary);
  assert.equal(summary.title, "帮我看看目录结构");
  assert.equal(summary.preview, "帮我看看目录结构");
});

test("扫描：完全空文件的会话仍返回（id 兜底文件名），不参与但也不崩溃", () => {
  const summary = scanClaudeFamilySessionFile("", "fallback-id", 12345);
  assert.ok(summary);
  assert.equal(summary.sessionId, "fallback-id");
  assert.equal(summary.title, "fallback-id");
  assert.equal(summary.updatedAt, 12345);
});

test("扫描：畸形行（半个 JSON / 非 JSON）被跳过，不抛错", () => {
  // 首行是能解析出 sessionId 的合法事件；后三行畸形但不应让扫描崩溃。
  const summary = scanClaudeFamilySessionsFromLines(
    [
      '{"type":"session-meta","sessionId":"ok"}',
      '{"type":"session-meta","sessionId":"ok"',
      "not json at all",
      "[]",
    ],
    "sid",
    0,
  );
  assert.ok(summary);
  assert.equal(summary.sessionId, "ok");
});

test("扫描：超长标题截断到 120 字符并带省略号", () => {
  const long = "字".repeat(200);
  const summary = scanClaudeFamilySessionFile(
    JSON.stringify({ type: "summary", summary: long, timestamp: 1 }),
    "sid",
    0,
  );
  assert.ok(summary);
  assert.equal(summary.title.length, 121);
  assert.ok(summary.title.endsWith("…"));
});

// ── 外部会话的完整上下文（transcript） ──

function messageLine(role: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    timestamp: 1_700_000_000_000,
    ...extra,
  });
}

test("transcript: 解析用户/助手/工具调用/工具结果，按文件顺序", () => {
  const content = [
    messageLine("user", "修一下 lint"),
    messageLine("assistant", "先看报错"),
    JSON.stringify({
      type: "function_call",
      name: "Bash",
      arguments: JSON.stringify({ command: "pnpm lint" }),
      timestamp: 1_700_000_001_000,
    }),
    JSON.stringify({
      type: "function_call_result",
      name: "Bash",
      output: { type: "text", text: "3 errors" },
      timestamp: 1_700_000_002_000,
    }),
    messageLine("assistant", "改完了"),
  ].join("\n");

  const page = parseClaudeFamilyTranscript(content, { sessionId: "sess-1", limit: 10 });
  assert.deepEqual(
    page.entries.map((entry) => [entry.kind, entry.text]),
    [
      ["user", "修一下 lint"],
      ["assistant", "先看报错"],
      ["tool", "Bash: pnpm lint"],
      ["tool_result", "3 errors"],
      ["assistant", "改完了"],
    ],
  );
  assert.equal(page.total, 5);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncated, false);
  assert.equal(page.sessionId, "sess-1");
});

test("transcript: 跳过 CLI 注入的提示与本地命令回显", () => {
  const content = [
    messageLine("user", '<system-reminder data-role="command-caveat">caveat</system-reminder>'),
    messageLine("user", "<command-name>/model</command-name>"),
    messageLine("user", "真正的任务", { providerData: { skipRun: true } }),
    messageLine("user", "真正的任务"),
  ].join("\n");
  const page = parseClaudeFamilyTranscript(content, { sessionId: "s" });
  assert.deepEqual(
    page.entries.map((entry) => entry.text),
    ["真正的任务"],
  );
});

test("transcript: REPL 从 code 里取出真实命令", () => {
  const content = JSON.stringify({
    type: "function_call",
    name: "REPL",
    arguments: JSON.stringify({ code: 'const r = await Bash({ command: "ls -la" });' }),
  });
  const page = parseClaudeFamilyTranscript(content, { sessionId: "s" });
  assert.equal(page.entries[0]?.text, "REPL: ls -la");
});

test("transcript: 分页按条目序号向前翻，hasMore 正确", () => {
  const lines = Array.from({ length: 12 }, (_, index) => messageLine("user", `第 ${index + 1} 句`));
  const content = lines.join("\n");
  const latest = parseClaudeFamilyTranscript(content, { sessionId: "s", limit: 5 });
  assert.deepEqual(
    latest.entries.map((entry) => entry.text),
    ["第 8 句", "第 9 句", "第 10 句", "第 11 句", "第 12 句"],
  );
  assert.equal(latest.hasMore, true);

  const earlier = parseClaudeFamilyTranscript(content, {
    sessionId: "s",
    limit: 5,
    // latest 的窗口从第 8 条开始（0 基 7）。
    before: latest.total - latest.entries.length,
  });
  assert.deepEqual(
    earlier.entries.map((entry) => entry.text),
    ["第 3 句", "第 4 句", "第 5 句", "第 6 句", "第 7 句"],
  );
  assert.equal(earlier.hasMore, true);
});

test("transcript: 单条超长被截断并标记 clipped", () => {
  const content = messageLine("assistant", "x".repeat(20_000));
  const page = parseClaudeFamilyTranscript(content, { sessionId: "s" });
  assert.equal(page.entries[0]?.clipped, true);
  assert.equal(page.entries[0]?.text.length, 12_001);
});

test("transcript: 单页正文预算超限时从最老开始丢", () => {
  const lines = Array.from({ length: 30 }, () => messageLine("assistant", "y".repeat(12_000)));
  const page = parseClaudeFamilyTranscript(lines.join("\n"), { sessionId: "s", limit: 30 });
  const chars = page.entries.reduce((sum, entry) => sum + entry.text.length, 0);
  assert.ok(chars <= 240_000, `page chars ${chars}`);
  assert.ok(page.entries.length < 30);
  // 丢的是最老的：最后一条必须还在。
  assert.equal(page.entries.at(-1)?.text.startsWith("y"), true);
});

// ── opencode：`opencode session export <id>` 的 JSON 还原 ──
// 形状与 claude-family 的 JSONL 完全不同（单个 JSON + messages[].content[]），
// 所以单独一组用例；面板侧只关心产出与 claude-family 同形的 transcript page。

function opencodeMessage(
  type: string,
  content: unknown[],
  created = 1_700_000_000_000,
): Record<string, unknown> {
  // 只有 user/assistant 带 content；system 等状态消息在真实 export 里没有 content。
  return { type, time: { created }, ...(content.length > 0 ? { content } : {}) };
}

function opencodeExport(messages: unknown[]): string {
  return JSON.stringify({ info: { id: "ses_1" }, messages });
}

test("opencode export: 用户/助手/工具调用/工具结果四类条目，按消息顺序", () => {
  const content = opencodeExport([
    opencodeMessage("user", [{ type: "text", text: "修一下 lint" }]),
    opencodeMessage("assistant", [
      { type: "step-start" },
      { type: "text", text: "先看报错" },
      {
        type: "tool",
        tool: "bash",
        state: { input: { command: "pnpm lint" }, output: "3 errors" },
      },
      { type: "step-finish" },
    ]),
    opencodeMessage("assistant", [{ type: "text", text: "改完了" }]),
  ]);
  const page = parseOpencodeSessionExport(content, { sessionId: "ses_1", limit: 10 });
  assert.deepEqual(
    page.entries.map((entry) => [entry.kind, entry.name ?? "", entry.text]),
    [
      ["user", "", "修一下 lint"],
      ["assistant", "", "先看报错"],
      ["tool", "bash", "bash: pnpm lint"],
      ["tool_result", "bash", "3 errors"],
      ["assistant", "", "改完了"],
    ],
  );
  assert.equal(page.total, 5);
  assert.equal(page.hasMore, false);
  assert.equal(page.truncated, false);
  assert.equal(page.sessionId, "ses_1");
});

test("opencode export: system/idle/model-switched/compaction 消息跳过", () => {
  const content = opencodeExport([
    opencodeMessage("system", [], 1),
    opencodeMessage("user", [{ type: "text", text: "真正的任务" }]),
    opencodeMessage("idle", [], 2),
    opencodeMessage("model-switched", [], 3),
    opencodeMessage("compaction", [{ type: "text", text: "压缩摘要" }]),
  ]);
  const page = parseOpencodeSessionExport(content, { sessionId: "s" });
  assert.deepEqual(
    page.entries.map((entry) => entry.text),
    ["真正的任务"],
  );
  assert.equal(page.total, 1);
});

test("opencode export: 多段 text 用空行拼接，thinking 不入转录", () => {
  const content = opencodeExport([
    opencodeMessage("assistant", [
      { type: "reasoning", text: "先想一下" },
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]),
  ]);
  const page = parseOpencodeSessionExport(content, { sessionId: "s" });
  assert.deepEqual(
    page.entries.map((entry) => entry.text),
    ["第一段\n\n第二段"],
  );
});

test("opencode export: 工具没有 output 时只出调用条目", () => {
  const content = opencodeExport([
    opencodeMessage("assistant", [{ type: "tool", tool: "read", state: { input: {} } }]),
  ]);
  const page = parseOpencodeSessionExport(content, { sessionId: "s" });
  assert.deepEqual(
    page.entries.map((entry) => [entry.kind, entry.text]),
    [["tool", "read"]],
  );
});

test("opencode export: 分页按条目序号向前翻，before/limit 与 claude-family 同语义", () => {
  const messages = Array.from({ length: 12 }, (_, index) =>
    opencodeMessage("user", [{ type: "text", text: `第 ${index + 1} 句` }]),
  );
  const content = opencodeExport(messages);
  const latest = parseOpencodeSessionExport(content, { sessionId: "s", limit: 5 });
  assert.deepEqual(
    latest.entries.map((entry) => entry.text),
    ["第 8 句", "第 9 句", "第 10 句", "第 11 句", "第 12 句"],
  );
  assert.equal(latest.hasMore, true);
  const earlier = parseOpencodeSessionExport(content, {
    sessionId: "s",
    limit: 5,
    before: latest.total - latest.entries.length,
  });
  assert.deepEqual(
    earlier.entries.map((entry) => entry.text),
    ["第 3 句", "第 4 句", "第 5 句", "第 6 句", "第 7 句"],
  );
  assert.equal(earlier.hasMore, true);
});

test("opencode export: 超长正文按 kind 各自上限截断并标 clipped", () => {
  const content = opencodeExport([
    opencodeMessage("assistant", [{ type: "text", text: "x".repeat(20_000) }]),
    opencodeMessage("assistant", [
      {
        type: "tool",
        tool: "bash",
        state: { input: { command: "ls" }, output: "o".repeat(10_000) },
      },
    ]),
  ]);
  const page = parseOpencodeSessionExport(content, { sessionId: "s" });
  const [assistant, tool, toolResult] = page.entries;
  assert.equal(assistant?.clipped, true);
  assert.equal(assistant?.text.length, 12_001);
  assert.equal(tool?.clipped, undefined);
  assert.equal(toolResult?.clipped, true);
  assert.equal(toolResult?.text.length, 4_001);
});

test("opencode export: sourceTruncated 透传为 truncated", () => {
  const page = parseOpencodeSessionExport(opencodeExport([]), {
    sessionId: "s",
    sourceTruncated: true,
  });
  assert.equal(page.truncated, true);
  assert.deepEqual(page.entries, []);
});

test("opencode export: 损坏的 JSON 返回空页而不是抛错", () => {
  const page = parseOpencodeSessionExport('{"messages":[{"type":"user"', { sessionId: "s" });
  assert.deepEqual(page.entries, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
});

// ── Command Code 会话 ──
// 落盘形状与 claude-family 完全不同：首行 session 头，条目是 {role, content} 的
// V2 消息（工具结果还是独立的 role:"tool" 消息），所以单独一组用例。

const commandCodeHeader = {
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2026-11-09T10:00:00.000Z",
  cwd: "/workspace",
};

test("Command Code 扫描：头部 id、ISO 时间与首条用户正文", () => {
  const content = [
    commandCodeHeader,
    {
      id: "e1",
      timestamp: "2026-11-09T10:00:01.000Z",
      sessionId: "sess-1",
      role: "user",
      content: [{ type: "text", text: "帮我改 bug" }],
    },
    {
      id: "e2",
      timestamp: "2026-11-09T10:00:02.000Z",
      role: "assistant",
      content: [{ type: "text", text: "好" }],
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const summary = scanCommandCodeSessionFile(content, "file-id", 123);
  assert.ok(summary);
  assert.equal(summary.sessionId, "sess-1");
  assert.equal(summary.title, "帮我改 bug");
  assert.equal(summary.preview, "帮我改 bug");
  assert.equal(summary.updatedAt, Date.parse("2026-11-09T10:00:02.000Z"));
});

test("Command Code 扫描：跳过 metadata.isMeta 条目与注入提示", () => {
  const content = [
    commandCodeHeader,
    {
      role: "user",
      metadata: { isMeta: true },
      content: [{ type: "text", text: "内部注入" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "<system-reminder>ignore</system-reminder>" }],
    },
    { role: "user", content: [{ type: "text", text: "真实首句" }] },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const summary = scanCommandCodeSessionFile(content, "file-id", 999);
  assert.equal(summary?.title, "真实首句");
  // 条目没有时间戳时用头部创建时间；完全没有时间才回落文件 mtime。
  assert.equal(summary?.updatedAt, Date.parse(commandCodeHeader.timestamp));
});

test("Command Code transcript：用户/助手/工具调用/工具结果按落盘顺序还原", () => {
  const content = [
    commandCodeHeader,
    {
      role: "user",
      timestamp: "2026-11-09T10:00:01.000Z",
      content: [{ type: "text", text: "修一下" }],
    },
    {
      role: "assistant",
      timestamp: "2026-11-09T10:00:02.000Z",
      content: [
        { type: "reasoning", text: "思考过程不展示" },
        { type: "text", text: "我先看文件" },
        { type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "tool",
      timestamp: "2026-11-09T10:00:03.000Z",
      content: [
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "",
          output: { type: "text", value: "a.txt" },
        },
      ],
    },
    {
      role: "assistant",
      timestamp: "2026-11-09T10:00:04.000Z",
      content: [{ type: "text", text: "改好了" }],
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const page = parseCommandCodeTranscript(content, { sessionId: "sess-1" });
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.entries.map((entry) => entry.kind),
    ["user", "assistant", "tool", "tool_result", "assistant"],
  );
  assert.equal(page.entries[0]?.text, "修一下");
  assert.equal(page.entries[1]?.text, "我先看文件");
  // tool-result 的 toolName 为空：用 toolCallId 回查到 bash。
  assert.equal(page.entries[2]?.name, "bash");
  assert.equal(page.entries[2]?.text, "bash: ls");
  assert.equal(page.entries[3]?.name, "bash");
  assert.equal(page.entries[3]?.text, "a.txt");
  assert.equal(page.entries[4]?.text, "改好了");
});

test("Command Code V3 真实形状：message 包装 + Anthropic content", () => {
  // 2026-11-09 用免费模型 reflection/beam:free 实跑落盘：
  // 条目是 {type:"message",message:{role,content,meta}}，content 是 Anthropic 形状
  // （thinking / tool_use / tool_result），不是旧版扁平的 role/content。
  const content = [
    {
      type: "session",
      version: 3,
      id: "sess-v3",
      timestamp: "2026-11-09T15:42:53.145Z",
      cwd: "/workspace",
    },
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-11-09T15:42:57.294Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "用 bash 执行 echo hello" }],
        meta: { source: "user" },
      },
    },
    {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-11-09T15:42:57.295Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想想", signature: "" },
          {
            type: "tool_use",
            id: "call-1",
            name: "shell_command",
            input: { command: "echo hello" },
          },
        ],
        meta: { source: "model" },
      },
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-11-09T15:42:58.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [{ type: "text", text: "hello\n" }],
          },
        ],
        meta: { source: "tool" },
      },
    },
    {
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: "2026-11-09T15:42:59.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        meta: { source: "model" },
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  const summary = scanCommandCodeSessionFile(content, "file-id", 0);
  assert.equal(summary?.sessionId, "sess-v3");
  assert.equal(summary?.title, "用 bash 执行 echo hello");

  const page = parseCommandCodeTranscript(content, { sessionId: "sess-v3" });
  assert.deepEqual(
    page.entries.map((entry) => [entry.kind, entry.name, entry.text]),
    [
      ["user", undefined, "用 bash 执行 echo hello"],
      ["tool", "shell_command", "shell_command: echo hello"],
      ["tool_result", "shell_command", "hello"],
      ["assistant", undefined, "hello"],
    ],
  );
});

test("Command Code transcript：分页与其他驱动同语义，meta 条目不进上下文", () => {
  const lines: Array<Record<string, unknown>> = [
    commandCodeHeader,
    { role: "user", metadata: { isMeta: true }, content: [{ type: "text", text: "隐藏" }] },
  ];
  for (let index = 0; index < 5; index += 1) {
    lines.push({ role: "user", content: [{ type: "text", text: `第 ${index} 条` }] });
  }
  const content = lines.map((entry) => JSON.stringify(entry)).join("\n");
  const page = parseCommandCodeTranscript(content, { sessionId: "sess-1", limit: 2 });
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.entries.map((entry) => entry.text),
    ["第 3 条", "第 4 条"],
  );
  assert.equal(page.hasMore, true);
  assert.equal(
    parseCommandCodeTranscript(content, { sessionId: "sess-1", before: 2, limit: 2 }).entries[0]
      ?.text,
    "第 0 条",
  );
});
