import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 主控模式的跨层接线护栏。
 *
 * 主控不是新协议模式，而是"绑定 + plan 只读"在模式菜单里的呈现别名；每一层都是
 * 可选的、漏了不会报错（菜单里少一项 / 切走时不自动解绑 / 绑定清不掉），
 * 所以用源码扫描把关键链路钉住。
 */
const LINKS: Array<{ file: string; pattern: RegExp; why: string }> = [
  {
    file: "src/v4/composer/V4ComposerModeControls.tsx",
    pattern: /const ORCHESTRATOR_MODE_ID = "orchestrator"/,
    why: "主控项只在本菜单合成，不进 shared 模式目录",
  },
  {
    file: "src/v4/composer/V4ComposerModeControls.tsx",
    pattern:
      /onValueChange=\{\(value\) => \{[\s\S]*?value === ORCHESTRATOR_MODE_ID[\s\S]*?onSelectOrchestrator\?\.\(\)/,
    why: "选中主控走绑定入口，而不是草稿切换",
  },
  {
    file: "src/v4/composer/V4ComposerModeControls.tsx",
    pattern: /\{!orchestratorActive && \(/,
    why: "主控态隐藏 Plan 勾选项（只读不能单独关掉）",
  },
  {
    file: "src/v4/ConversationComposer.tsx",
    pattern: /orchestratorActive=\{Boolean\(snapshot\?\.externalAgent\)\}/,
    why: "已绑定时模式菜单呈现为主控",
  },
  {
    file: "src/v4/ConversationComposer.tsx",
    pattern: /onSelectOrchestrator=\{handleSelectOrchestrator\}/,
    why: "主控选择接到绑定弹窗入口",
  },
  {
    file: "src/v4/ConversationComposer.tsx",
    pattern: /if \(snapshot\?\.externalAgent\) return;[\s\S]*?setBindDialogOpen\(true\)/,
    why: "已绑定不重弹绑定窗；未绑定才弹",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /dispatchCommand\(\s*"switchCollaborationMode"/,
    why: "已绑定时切走主控 → 单条命令完成自动解绑与切模式",
  },
  {
    file: "../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts",
    pattern: /await clearExternalAgentBinding\(host, record\)/,
    why: "switchCollaborationMode 在命令内清绑定（原子，无 CAS 竞态）",
  },
  {
    file: "../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/external-agent.ts",
    pattern: /export async function clearExternalAgentBinding/,
    why: "解绑/切走共用同一段清绑定逻辑",
  },
];

function readSurface(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

describe("orchestrator mode wiring", () => {
  it.each(LINKS)("$file：$why", ({ file, pattern }) => {
    expect(readSurface(file)).toMatch(pattern);
  });

  it("shared 模式目录不被主控污染（automation/off-peak 共用它）", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../../shared/src/zcode-agent-model-state.ts", import.meta.url)),
      "utf8",
    );
    expect(catalog).not.toContain("orchestrator");
  });
});
