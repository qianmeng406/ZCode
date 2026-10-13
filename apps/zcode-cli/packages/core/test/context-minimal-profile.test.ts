import assert from "node:assert/strict";
import test from "node:test";
import type { EnvInfo } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/builder.js";
import { filterMinimalProfileRuntimeVisibleTools } from "../src/runtime/methods/config.js";

/**
 * 极简档位（promptProfile=minimal）的契约测试。
 *
 * 这是极简模式唯一能被自动化证明的部分：system 段与 meta_user 附件到底发了什么。
 * 只靠门禁（typecheck/lint）无法证明「提示词真的变短」，所以这里对渲染结果做断言。
 * 工具表不在这里——它由 model request 的 tools 字段承载，MCP 收窄见 runtime/methods/mcp.ts
 * 与 runtime/helpers/runtime-tools.ts 的分支。
 */

const ENV_INFO: EnvInfo = {
  cwd: "C:/tmp/ws",
  platform: "win32",
  shell: "bash",
  osVersion: "10.0.26100",
  nodeVersion: "24.11.0",
  isGitRepository: true,
  gitBranch: "main",
  gitStatus: "dirty",
  recentCommits: ["abc1234 demo"],
};

function build(promptProfile: "default" | "minimal") {
  return createContextBuilder({
    workingDirectory: "C:/tmp/ws",
    envInfo: ENV_INFO,
    currentDate: "2026-09-29",
    userInstructions: { content: "PROJECT_INSTRUCTIONS_MARKER" },
    skills: { skills: [{ name: "demo-skill", description: "DEMO_SKILL_MARKER", path: "/x" }] },
    guidanceToolNames: ["Read", "Skill"],
    promptProfile,
  }).build();
}

function renderedText(result: ReturnType<typeof build>): string {
  return [
    ...result.systemMessages.map((message) => message.content),
    ...result.metaUserAttachments.map((attachment) => attachment.content),
  ].join("\n");
}

test("minimal profile keeps the identity line and the working directory", () => {
  const text = renderedText(build("minimal"));
  assert.ok(text.includes("You are ZCode"), "身份行必须保留");
  assert.ok(text.includes("C:/tmp/ws"), "工作目录必须保留（否则文件类工具无法定位）");
  assert.ok(text.includes("win32"), "平台必须保留");
  assert.ok(text.includes("# Environment"), "环境段必须保留");
});

test("minimal profile drops skills, project instructions, date and git context", () => {
  const text = renderedText(build("minimal"));
  assert.ok(!text.includes("DEMO_SKILL_MARKER"), "技能清单不该下发");
  assert.ok(!text.includes("PROJECT_INSTRUCTIONS_MARKER"), "workspace instructions 不该下发");
  assert.ok(!text.includes("2026-09-29"), "当前日期不该下发");
  assert.ok(!text.includes("gitStatus"), "git 段不该下发");
  assert.ok(!text.includes("abc1234 demo"), "近期提交不该下发");
});

test("minimal profile emits exactly three sections and no meta_user attachments", () => {
  const result = build("minimal");
  assert.deepEqual(
    result.sections.map((section) => section.source),
    ["cli_prefix", "env_info", "minimal_guardrails"],
  );
  assert.equal(result.metaUserAttachments.length, 0);
});

test("minimal profile carries the guardrails its full-access permissions require", () => {
  // 极简模式是自动执行权限且没有任何其它指引：护栏段是它唯一的防线，必须在场。
  const minimalText = renderedText(build("minimal"));
  assert.ok(minimalText.includes("# Guardrails"));
  assert.ok(minimalText.includes("automatic permissions"));
  assert.ok(minimalText.includes("Destructive or hard-to-reverse"), "破坏性操作须先确认");
  assert.ok(minimalText.includes("explicit confirmation"));
  assert.ok(minimalText.includes("Never claim success you have not verified"));
  // 默认档位有自己的完整行为段，不携带这段——它是极简档位专属的最低保障。
  const standardText = renderedText(build("default"));
  assert.ok(!standardText.includes("# Guardrails"));
});

test("minimal profile is materially smaller than the default profile", () => {
  const minimal = build("minimal");
  const standard = build("default");
  // 不断言具体字符数（环境段随 cwd/提交长度浮动），只断言量级差：
  // 默认档位带着全部动态段与附件，至少是极简档位的数倍。
  assert.ok(
    minimal.totalChars * 3 < standard.totalChars,
    `极简档位应显著更小：minimal=${minimal.totalChars} default=${standard.totalChars}`,
  );
  assert.ok(standard.sections.length > minimal.sections.length);
});

test("minimal profile rejects a simultaneous custom system prompt", () => {
  assert.throws(
    () =>
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        customSystemPrompt: "CUSTOM",
        promptProfile: "minimal",
      }).build(),
    /promptProfile=minimal and customSystemPrompt are mutually exclusive/,
  );
});

test("minimal profile rejects a simultaneous workflow actor identity", () => {
  assert.throws(
    () =>
      createContextBuilder({
        workingDirectory: "C:/tmp/ws",
        envInfo: ENV_INFO,
        workflowActor: { name: "worker" },
        promptProfile: "minimal",
      }).build(),
    /promptProfile=minimal and workflowActor are mutually exclusive/,
  );
});

/**
 * 工具表收窄：极简模式要求「只有系统工具」，MCP 工具与 Skill 工具都必须摘掉。
 * 这里只喂 name —— 过滤逻辑按名判定，与工具其余字段无关（真实契约由 tsc 保证）。
 */
function filterTools(mode: string, names: readonly string[]): string[] {
  const tools = names.map((name) => ({ name })) as unknown as Parameters<
    typeof filterMinimalProfileRuntimeVisibleTools
  >[1];
  const result = filterMinimalProfileRuntimeVisibleTools({ config: { mode } } as never, tools);
  return result.map((tool) => tool.name);
}

const SAMPLE_TOOLS = [
  "Read",
  "Write",
  "Bash",
  "TodoWrite",
  "Skill",
  "mcp__github__search",
  "mcp__playwright__click",
];

test("minimal mode drops every MCP tool and the Skill tool", () => {
  assert.deepEqual(filterTools("minimal", SAMPLE_TOOLS), ["Read", "Write", "Bash", "TodoWrite"]);
});

test("other modes keep MCP and Skill tools untouched", () => {
  // 收窄只属于极简模式：build 等档位的工具表必须与改动前完全一致。
  assert.deepEqual(filterTools("build", SAMPLE_TOOLS), [...SAMPLE_TOOLS]);
  assert.deepEqual(filterTools("workflow", SAMPLE_TOOLS), [...SAMPLE_TOOLS]);
  assert.deepEqual(filterTools("zcodeUpdate", SAMPLE_TOOLS), [...SAMPLE_TOOLS]);
});
