import assert from "node:assert/strict";
import test from "node:test";
import {
  cwdToProjectDirName,
  parseClaudeFamilyTranscript,
  parseOpencodeSessionExport,
  scanClaudeFamilySessionFile,
  scanClaudeFamilySessionsFromLines,
} from "../src/externalAgentSessions.js";

test("cwdToProjectDirName: 盘符冒号丢弃、分隔符换成 - 且去掉首尾", () => {
  assert.equal(cwdToProjectDirName("c:\\Users\\q\\Desktop\\agent"), "c-Users-q-Desktop-agent");
  assert.equal(cwdToProjectDirName("/home/u/work"), "home-u-work");
  assert.equal(cwdToProjectDirName("c:\\trailing\\"), "c-trailing");
});

test("cwdToProjectDirName: 盘符大小写归一（CLI 落盘用小写盘符）", () => {
  assert.equal(cwdToProjectDirName("C:\\Users\\q\\Desktop\\agent"), "c-Users-q-Desktop-agent");
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
