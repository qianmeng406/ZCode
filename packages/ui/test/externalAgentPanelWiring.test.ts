import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 外部 agent 过程面板的跨层接线护栏。
 *
 * 与 Oracle 审查面板同一条链路，且每一层的回调都是可选的——漏传不会报错，
 * 表现只有「状态卡上没有查看过程按钮」，运行时静默降级（2026-10-28 在 Oracle
 * 那边实测踩过一次）。这里用源码扫描把每一环钉住。
 */
const LINKS: Array<{ file: string; pattern: RegExp; why: string }> = [
  {
    file: "src/App.tsx",
    pattern: /handleOpenExternalAgentPanel=\{handleOpenExternalAgentPanel\}/,
    why: "App 把 useAppPanels 的 handler 传给 WorkspaceShellLayout",
  },
  {
    file: "src/app-shell/WorkspaceShellLayout.tsx",
    pattern: /onOpenExternalAgentPanel=\{handleOpenExternalAgentPanel\}/,
    why: "Layout 把 handler 继续下发给对话区（V4ChatPane 与 V4WorkspaceChatArea 两条宿主路径）",
  },
  {
    file: "src/v4/V4WorkspaceChatArea.tsx",
    pattern: /onOpenExternalAgentPanel,/,
    why: "工作区对话区把回调放进 WorkbenchShellBinding",
  },
  {
    file: "src/v4/V4ChatPane.tsx",
    pattern: /onOpenExternalAgentPanel=\{onOpenExternalAgentPanel\}/,
    why: "V4ChatPane 这条宿主路径也要继续下发，否则该入口静默消失",
  },
  {
    file: "src/v4/WorkbenchPane.tsx",
    pattern: /onOpenExternalAgentPanel\?:/,
    why: "WorkbenchShellBinding 类型声明该回调",
  },
  {
    file: "src/v4/WorkbenchPane.tsx",
    pattern: /onOpenExternalAgentPanel=\{shell\.onOpenExternalAgentPanel\}/,
    why: "WorkbenchLeafPane 把它传给真正的 SessionPane",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /publishExternalAgentActivity\(sessionId, externalAgentActivity\)/,
    why: "SessionPane 把投影里的活动写进模块级 store（面板的数据源）",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /onOpenPanel:\s*\(\)\s*=>/,
    why: "SessionPane 把「查看过程」回调注入状态卡宿位",
  },
  {
    file: "src/app-shell/AnimatedSidePanePanel.tsx",
    pattern: /tab\.type === "external-agent-activity"/,
    why: "侧栏渲染这个 tab 类型",
  },
  {
    file: "src/v4/composer/ExternalAgentActivityCard.tsx",
    pattern: /data-testid="external-agent-activity-open"/,
    why: "状态卡渲染「查看过程」入口",
  },
];

function readSurface(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

describe("external agent activity panel wiring", () => {
  it.each(LINKS)("$file：$why", ({ file, pattern }) => {
    expect(readSurface(file)).toMatch(pattern);
  });
});
