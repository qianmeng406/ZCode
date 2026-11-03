import assert from "node:assert/strict";
import test from "node:test";
import {
  cwdToProjectDirName,
  scanClaudeFamilySessionFile,
  scanClaudeFamilySessionsFromLines,
} from "../src/externalAgentSessions.js";

test("cwdToProjectDirName: 盘符冒号丢弃、分隔符换成 - 且去掉首尾", () => {
  assert.equal(cwdToProjectDirName("c:\\Users\\q\\Desktop\\agent"), "c-Users-q-Desktop-agent");
  assert.equal(cwdToProjectDirName("/home/u/work"), "home-u-work");
  assert.equal(cwdToProjectDirName("c:\\trailing\\"), "c-trailing");
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
