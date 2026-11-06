// 外部会话列表的探测脚本：线格式 + 一次真实 spawn。
//
// 这些用例存在的直接原因：脚本曾经把分隔符写成字面量 `\u0000`，而 argv 不允许
// NUL，spawn 直接抛 ERR_INVALID_ARG_VALUE，探测被 catch 成"未安装"——UI 上
// 的表现是"这台机器上还没有外部会话"，排查成本极高。第一条断言就是为它设的。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildDeleteExternalAgentSessionScript,
  buildExternalAgentSessionsScript,
  buildExternalAgentTranscriptScript,
  parseExternalAgentSessionsProbe,
  readExternalAgentSessionTranscript,
} from "../src/zcode-protocol/external-agent-probe.js";
import { cwdToProjectDirName } from "@zcode/shared";

const WORKSPACE = "C:\\Users\\someone\\Desktop\\repo";
const SLUG = "c-Users-someone-Desktop-repo";

function sessionLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "fix the lint errors" }],
    sessionId: "session-1",
    timestamp: 1_700_000_000_000,
    ...overrides,
  });
}

function wireBlock(file: string, mtime: number, content: string): string {
  return `\u0000FILE\u0000${file}\u0000${mtime}\u0000${content}\u0000END\u0000`;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("buildExternalAgentSessionsScript", () => {
  it("脚本里没有字面量 NUL（argv 不允许，否则 spawn 直接抛错）", () => {
    const script = buildExternalAgentSessionsScript(WORKSPACE);
    expect(script).not.toContain("\u0000");
    expect(script).toContain("String.fromCharCode(0)");
  });

  it("按 cwd 推出 projects 目录名", () => {
    const script = buildExternalAgentSessionsScript(WORKSPACE);
    expect(script).toContain(JSON.stringify(SLUG));
    expect(SLUG).toBe(cwdToProjectDirName(WORKSPACE));
  });
});

describe("parseExternalAgentSessionsProbe", () => {
  it("解析 NUL 分隔的块并按 updatedAt 降序", () => {
    const older = sessionLine({ sessionId: "old", timestamp: 1_000 });
    const newer = sessionLine({ sessionId: "new", timestamp: 2_000 });
    const output = wireBlock("old.jsonl", 10, older) + wireBlock("new.jsonl", 20, newer);
    const result = parseExternalAgentSessionsProbe(output);
    expect(result.map((item) => item.sessionId)).toEqual(["new", "old"]);
  });

  it("跳过残缺块，不因一个坏文件丢掉整个列表", () => {
    const good = sessionLine();
    const output = "\u0000FILE\u0000\u0000END\u0000" + wireBlock("good.jsonl", 5, good);
    const result = parseExternalAgentSessionsProbe(output);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("fix the lint errors");
  });
});

describe("探测脚本端到端", () => {
  it("在隔离的 home 下真的能列出会话（覆盖 spawn 路径）", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "zcode-probe-"));
    tempDirs.push(home);
    const projectDir = path.join(home, ".codebuddy", "projects", SLUG);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "a.jsonl"), `${sessionLine()}\n`, "utf8");
    writeFileSync(
      path.join(projectDir, "b.jsonl"),
      `${sessionLine({ sessionId: "session-2", timestamp: 1_700_000_100_000 })}\n`,
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      ["-e", buildExternalAgentSessionsScript(WORKSPACE)],
      {
        encoding: "utf8",
        // os.homedir() 在 Windows 读 USERPROFILE，其他平台读 HOME。
        env: { ...process.env, USERPROFILE: home, HOME: home },
        cwd: home,
        maxBuffer: 8_000_000,
      },
    );

    const result = parseExternalAgentSessionsProbe(stdout);
    expect(result.map((item) => item.sessionId).sort()).toEqual(["session-1", "session-2"]);
    expect(result.every((item) => item.title.length > 0)).toBe(true);
  });
});

// ── 删除外部会话 / 读取完整上下文 ──

function makeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "zcode-ext-session-home-"));
  tempDirs.push(home);
  mkdirSync(path.join(home, ".codebuddy", "projects", SLUG), { recursive: true });
  return home;
}

function runScript(home: string, script: string): string {
  return execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
}

describe("buildDeleteExternalAgentSessionScript", () => {
  it("脚本里没有字面量 NUL，且 id 只进文件名", () => {
    const script = buildDeleteExternalAgentSessionScript(WORKSPACE, "abc-123");
    expect(script).not.toContain("\u0000");
    expect(script).toContain(JSON.stringify(SLUG));
    expect(script).toContain('"abc-123"');
  });

  it("真实删除 .jsonl 与同名目录；第二次返回 0（幂等）", () => {
    const home = makeHome();
    const dir = path.join(home, ".codebuddy", "projects", SLUG);
    const sessionId = "01a1a08d-2a63-7c10-bc1f-a03630f2df11";
    writeFileSync(path.join(dir, `${sessionId}.jsonl`), sessionLine());
    mkdirSync(path.join(dir, sessionId));
    writeFileSync(path.join(dir, sessionId, "artifact.bin"), "x");

    const first = runScript(home, buildDeleteExternalAgentSessionScript(WORKSPACE, sessionId));
    expect(first).toBe("1");
    expect(existsSync(path.join(dir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(path.join(dir, sessionId))).toBe(false);

    const second = runScript(home, buildDeleteExternalAgentSessionScript(WORKSPACE, sessionId));
    expect(second).toBe("0");
  });
});

describe("buildExternalAgentTranscriptScript", () => {
  it("整份文件倒回，首行是截断标记", () => {
    const home = makeHome();
    const dir = path.join(home, ".codebuddy", "projects", SLUG);
    const sessionId = "sess-transcript";
    const content = [sessionLine(), sessionLine({ text: "第二句" })].join("\n");
    writeFileSync(path.join(dir, `${sessionId}.jsonl`), content);

    const stdout = runScript(home, buildExternalAgentTranscriptScript(WORKSPACE, sessionId));
    expect(stdout.startsWith("0\n")).toBe(true);
    expect(stdout.slice(2)).toBe(content);
  });

  it("文件不存在：空输出（宿主侧按空页处理）", () => {
    const home = makeHome();
    const stdout = runScript(home, buildExternalAgentTranscriptScript(WORKSPACE, "missing"));
    expect(stdout).toBe("");
  });
});

describe("readExternalAgentSessionTranscript", () => {
  it("非法 id 直接拒绝，不跑脚本", async () => {
    const run = vi.fn();
    const page = await readExternalAgentSessionTranscript({
      executionPort: { run } as never,
      cwd: WORKSPACE,
      externalSessionId: "../../evil",
    });
    expect(run).not.toHaveBeenCalled();
    expect(page).toMatchObject({ entries: [], total: 0, hasMore: false });
  });

  it("解析宿主返回的「截断标记 + JSONL」并按页返回", async () => {
    const content = [
      JSON.stringify({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "第一句" }],
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "第二句" }],
      }),
    ].join("\n");
    const run = vi.fn(async () => ({
      streams: { stdout: { text: `1\n${content}` }, stderr: { text: "" } },
      exitCode: 0,
    }));
    const page = await readExternalAgentSessionTranscript({
      executionPort: { run } as never,
      cwd: WORKSPACE,
      externalSessionId: "sess-1",
      limit: 10,
    });
    expect(page.truncated).toBe(true);
    expect(page.sessionId).toBe("sess-1");
    expect(page.entries.map((entry) => entry.text)).toEqual(["第一句", "第二句"]);
  });
});
