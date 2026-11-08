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
  deleteExternalAgentSession,
  listExternalAgentSessions,
  parseExternalAgentSessionsProbe,
  parseModelListLines,
  parseOpencodeModelCatalog,
  parseOpencodeSessionListProbe,
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

// ── opencode 驱动分派（2026-11-08）──
// opencode 的会话不在落盘 JSONL 里，只能问 CLI。这里钉住两件事：
// 1. driver 分派真的换了命令（opencode 走 CLI，claude 仍走 node -e 脚本）；
// 2. driver 缺省时行为与改动前逐字一致（旧客户端不发 driver 字段）。

function okResult(stdout: string, exitCode = 0) {
  return { streams: { stdout: { text: stdout }, stderr: { text: "" } }, exitCode };
}

function stubPort(handler: (request: { command: { file: string; args: string[] } }) => unknown) {
  return { run: vi.fn(async (request: never) => handler(request)) } as never;
}

function listEntry(id: string, title: string, updated: number) {
  return { id, title, updated, created: updated - 1_000, projectId: "p", directory: WORKSPACE };
}

describe("parseOpencodeSessionListProbe", () => {
  it("取 id/title/updated，按 updated 降序，缺标题退 id", () => {
    const stdout = JSON.stringify([
      listEntry("ses_old", "旧会话", 1_000),
      { id: "ses_new", updated: 3_000 },
      listEntry("ses_mid", "中间", 2_000),
    ]);
    expect(parseOpencodeSessionListProbe(stdout)).toEqual([
      { sessionId: "ses_new", title: "ses_new", updatedAt: 3_000 },
      { sessionId: "ses_mid", title: "中间", updatedAt: 2_000 },
      { sessionId: "ses_old", title: "旧会话", updatedAt: 1_000 },
    ]);
  });

  it("最多 30 条；畸形输入返回空数组", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      listEntry(`ses_${index}`, `t${index}`, index),
    );
    const result = parseOpencodeSessionListProbe(JSON.stringify(many));
    expect(result).toHaveLength(30);
    expect(result[0]?.sessionId).toBe("ses_39");
    expect(parseOpencodeSessionListProbe("not json")).toEqual([]);
    expect(parseOpencodeSessionListProbe("{}")).toEqual([]);
  });
});

describe("会话探测的 driver 分派", () => {
  it("opencode: list 走 `opencode session list --format json`", async () => {
    const port = stubPort(() => okResult(JSON.stringify([listEntry("ses_1", "一次任务", 5)])));
    const sessions = await listExternalAgentSessions({
      executionPort: port,
      cwd: WORKSPACE,
      driver: "opencode-exec",
    });
    expect(sessions).toEqual([{ sessionId: "ses_1", title: "一次任务", updatedAt: 5 }]);
    const request = (port as { run: { mock: { calls: Array<[unknown]> } } }).run.mock
      .calls[0]![0] as {
      command: { file: string; args: string[] };
    };
    expect(request.command.file).toBe("opencode");
    expect(request.command.args).toEqual(["session", "list", "--format", "json", "-n", "100"]);
  });

  it("claude-family（含 driver 缺省）: 仍走 node -e 脚本，不碰 opencode", async () => {
    const port = stubPort(() => okResult(""));
    await listExternalAgentSessions({ executionPort: port, cwd: WORKSPACE });
    await listExternalAgentSessions({
      executionPort: port,
      cwd: WORKSPACE,
      driver: "claude-family",
    });
    const calls = (port as { run: { mock: { calls: Array<[unknown]> } } }).run.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [request] of calls) {
      const command = (request as { command: { file: string; args: string[] } }).command;
      expect(command.file).toBe("node");
      expect(command.args[0]).toBe("-e");
      expect(command.args[1]).toContain(".codebuddy");
    }
  });

  it("opencode: transcript 走 `session export`，内容交给 parseOpencodeSessionExport", async () => {
    const exported = JSON.stringify({
      info: { id: "ses_9" },
      messages: [
        { type: "user", time: { created: 1 }, content: [{ type: "text", text: "修一下 lint" }] },
        {
          type: "assistant",
          time: { created: 2 },
          content: [
            { type: "text", text: "先看报错" },
            {
              type: "tool",
              tool: "bash",
              state: { input: { command: "pnpm lint" }, output: "3 errors" },
            },
          ],
        },
      ],
    });
    const port = stubPort(() => okResult(exported));
    const page = await readExternalAgentSessionTranscript({
      executionPort: port,
      cwd: WORKSPACE,
      externalSessionId: "ses_9",
      driver: "opencode-exec",
      limit: 10,
    });
    expect(page.sessionId).toBe("ses_9");
    expect(page.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user", "修一下 lint"],
      ["assistant", "先看报错"],
      ["tool", "bash: pnpm lint"],
      ["tool_result", "3 errors"],
    ]);
    const request = (port as { run: { mock: { calls: Array<[unknown]> } } }).run.mock
      .calls[0]![0] as {
      command: { file: string; args: string[] };
      outputLimit: { maxInlineBytes: number; maxBufferBytes: number };
    };
    expect(request.command.file).toBe("opencode");
    expect(request.command.args).toEqual(["session", "export", "ses_9"]);
    expect(request.outputLimit.maxBufferBytes).toBe(8_000_000);
  });

  it("opencode: 非法 id 直接拒绝（不跑命令），返回空页", async () => {
    const run = vi.fn();
    const page = await readExternalAgentSessionTranscript({
      executionPort: { run } as never,
      cwd: WORKSPACE,
      externalSessionId: "../../evil",
      driver: "opencode-exec",
    });
    expect(run).not.toHaveBeenCalled();
    expect(page).toMatchObject({ entries: [], total: 0 });
  });

  it("opencode: delete 走 `session delete`，退出码 0 = 删除成功", async () => {
    const port = stubPort(() => okResult(""));
    expect(
      await deleteExternalAgentSession({
        executionPort: port,
        cwd: WORKSPACE,
        externalSessionId: "ses_abc-1",
        driver: "opencode-exec",
      }),
    ).toBe(true);
    const request = (port as { run: { mock: { calls: Array<[unknown]> } } }).run.mock
      .calls[0]![0] as {
      command: { file: string; args: string[] };
    };
    expect(request.command.file).toBe("opencode");
    expect(request.command.args).toEqual(["session", "delete", "ses_abc-1"]);
  });

  it("opencode: delete 非零退出 = 失败；非法 id 不跑命令", async () => {
    const port = stubPort(() => okResult("", 1));
    expect(
      await deleteExternalAgentSession({
        executionPort: port,
        cwd: WORKSPACE,
        externalSessionId: "ses_missing",
        driver: "opencode-exec",
      }),
    ).toBe(false);

    const run = vi.fn();
    expect(
      await deleteExternalAgentSession({
        executionPort: { run } as never,
        cwd: WORKSPACE,
        externalSessionId: "bad id!",
        driver: "opencode-exec",
      }),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("parseModelListLines（opencode models 的输出）", () => {
  it("每行一个 id：去空、去重、保序、单条超 120 字符丢弃", () => {
    const stdout = [
      "anthropic/claude-sonnet-4",
      "",
      "  openai/gpt-5  ",
      "anthropic/claude-sonnet-4",
      "x".repeat(121),
      "google/gemini-3",
    ].join("\n");
    expect(parseModelListLines(stdout)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
      "google/gemini-3",
    ]);
  });

  it("最多 100 条", () => {
    const stdout = Array.from({ length: 150 }, (_, index) => `p/m${index}`).join("\n");
    expect(parseModelListLines(stdout)).toHaveLength(100);
  });
});

// opencode 的档位事实来自 ~/.cache/opencode/models.json 的 reasoning_options。
// 实测（v2.2.5）：档位是模型能力，逐模型不同；传错档位报 `Variant unavailable`，
// 所以候选必须精确，不能拿 CLI 级的一张表套所有模型。
describe("parseOpencodeModelCatalog（models.json → 逐模型档位）", () => {
  const raw = {
    opencode: {
      models: {
        "beam-free": { reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] },
        "deepseek-v4.1-flash-free": {
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        },
        // 只有 toggle 语义：不是可选档位，传 #low 会被 CLI 拒绝。
        "toggle-only": { reasoning_options: [{ type: "toggle" }] },
        // 完全没有 reasoning_options：同样没有档位。
        "no-options": {},
      },
    },
  };

  it("逐模型取 type:effort 的 values，只认探测到的 id", () => {
    expect(
      parseOpencodeModelCatalog(raw, ["opencode/beam-free", "opencode/deepseek-v4.1-flash-free"]),
    ).toEqual([
      {
        id: "opencode/beam-free",
        name: "opencode/beam-free",
        supportedEfforts: ["low", "medium", "high"],
      },
      {
        id: "opencode/deepseek-v4.1-flash-free",
        name: "opencode/deepseek-v4.1-flash-free",
        supportedEfforts: ["low", "high", "max"],
      },
    ]);
  });

  it("同一个 provider 的两个模型档位不同 → 各自独立，互不串档", () => {
    const catalog = parseOpencodeModelCatalog(raw, [
      "opencode/beam-free",
      "opencode/deepseek-v4.1-flash-free",
    ]);
    // 关键：beam-free 有 medium，deepseek 没有——拿一张 CLI 级表套两者必然错一个。
    expect(catalog[0]?.supportedEfforts).toContain("medium");
    expect(catalog[1]?.supportedEfforts).not.toContain("medium");
  });

  it("没有 effort 选项（toggle-only / 空）→ 收录但候选为空（UI 不显示档位入口）", () => {
    expect(parseOpencodeModelCatalog(raw, ["opencode/toggle-only", "opencode/no-options"])).toEqual(
      [
        { id: "opencode/toggle-only", name: "opencode/toggle-only", supportedEfforts: [] },
        { id: "opencode/no-options", name: "opencode/no-options", supportedEfforts: [] },
      ],
    );
  });

  it("缓存里没有的模型 / 未知 provider / 畸形输入 → 跳过或空数组，不抛", () => {
    expect(parseOpencodeModelCatalog(raw, ["opencode/missing", "nosuchprovider/x"])).toEqual([]);
    expect(parseOpencodeModelCatalog(null, ["opencode/beam-free"])).toEqual([]);
    expect(parseOpencodeModelCatalog([], ["opencode/beam-free"])).toEqual([]);
    expect(
      parseOpencodeModelCatalog({ opencode: { models: "not-an-object" } }, ["opencode/x"]),
    ).toEqual([]);
    // 没有斜杠的 id 不是 provider/model 形状：无法定位，跳过。
    expect(parseOpencodeModelCatalog(raw, ["beam-free"])).toEqual([]);
  });

  it("values 里的非字符串与空白项被剔除", () => {
    const dirty = {
      opencode: {
        models: {
          m: { reasoning_options: [{ type: "effort", values: ["low", 3, "  ", "high"] }] },
        },
      },
    };
    expect(parseOpencodeModelCatalog(dirty, ["opencode/m"])[0]?.supportedEfforts).toEqual([
      "low",
      "high",
    ]);
  });
});
