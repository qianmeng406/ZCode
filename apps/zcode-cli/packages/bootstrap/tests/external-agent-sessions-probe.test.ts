// 外部会话列表的探测脚本：线格式 + 一次真实 spawn。
//
// 这些用例存在的直接原因：脚本曾经把分隔符写成字面量 `\u0000`，而 argv 不允许
// NUL，spawn 直接抛 ERR_INVALID_ARG_VALUE，探测被 catch 成"未安装"——UI 上
// 的表现是"这台机器上还没有外部会话"，排查成本极高。第一条断言就是为它设的。
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildExternalAgentSessionsScript,
  parseExternalAgentSessionsProbe,
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
    const output =
      wireBlock("old.jsonl", 10, older) + wireBlock("new.jsonl", 20, newer);
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
