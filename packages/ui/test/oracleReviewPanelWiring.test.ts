import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Oracle 审查面板的跨层接线护栏。
 *
 * 这条链路经过 7 个文件：App → WorkspaceShellLayout → V4WorkspaceChatArea（shell binding）
 * → WorkbenchPane（binding 类型 + 叶子 SessionPane）→ SessionPane（注入 controller）
 * → ConversationComposer → OracleReviewBanner。漏掉任何一环都**不会**被类型检查发现：
 * 回调在每一层都是可选的，漏传的表现是「卡片上没有展开按钮」，运行时静默降级。
 * 2026-10-28 实测就漏了 WorkbenchShellBinding 与叶子渲染两处，这里用源码扫描钉住。
 */
const LINKS: Array<{ file: string; pattern: RegExp; why: string }> = [
  {
    file: "src/App.tsx",
    pattern: /handleOpenOracleReviewPanel=\{handleOpenOracleReviewPanel\}/,
    why: "App 把 useAppPanels 的 handler 传给 WorkspaceShellLayout",
  },
  {
    file: "src/app-shell/WorkspaceShellLayout.tsx",
    pattern: /onOpenOracleReviewPanel=\{handleOpenOracleReviewPanel\}/,
    why: "Layout 把 handler 继续下发给对话区",
  },
  {
    file: "src/v4/V4WorkspaceChatArea.tsx",
    pattern: /onOpenOracleReviewPanel,/,
    why: "对话区把回调放进 WorkbenchShellBinding",
  },
  {
    file: "src/v4/WorkbenchPane.tsx",
    pattern: /onOpenOracleReviewPanel\?:/,
    why: "WorkbenchShellBinding 类型声明该回调",
  },
  {
    file: "src/v4/WorkbenchPane.tsx",
    pattern: /onOpenOracleReviewPanel=\{shell\.onOpenOracleReviewPanel\}/,
    why: "WorkbenchLeafPane 把它传给真正的 SessionPane",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /onOpenPanel:\s*\(\)\s*=>/,
    why: "SessionPane 把回调注入 composer 的 controller",
  },
  {
    file: "src/v4/ConversationComposer.tsx",
    pattern: /onOpenPanel=\{oracleReview\.onOpenPanel\}/,
    why: "Composer 把 controller 回调交给审查卡片",
  },
  {
    file: "src/app-shell/WorkspaceShellLayout.tsx",
    pattern: /onOpenOracleReviewTab=\{activeTaskId \? handleOpenOracleReviewHistory : undefined\}/,
    why: "侧栏「新标签页」的审查记录入口：有活动会话时才下发回调（历史按会话键控）",
  },
  {
    file: "src/app-shell/AnimatedSidePanePanel.tsx",
    pattern: /canOpenOracleReview: onOpenOracleReviewTab !== undefined/,
    why: "启动器把回调是否存在翻译成是否列出「审查记录」项",
  },
  {
    file: "src/v4/oracleReview/OracleReviewBanner.tsx",
    pattern: /data-testid="v4-oracle-review-expand"/,
    why: "卡片渲染「展开」入口",
  },
];

function readSurface(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

describe("oracle review panel wiring", () => {
  it.each(LINKS)("$file：$why", ({ file, pattern }) => {
    expect(readSurface(file)).toMatch(pattern);
  });
});
