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
    pattern: /publishExternalAgentActivity\(\s*sessionId,/,
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
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /activity\?\.model/,
    why: "面板头部展示本次委派使用的模型（started 帧透传）",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /entry\.kind === "reasoning" && running/,
    why: "完成态丢掉空思考标记，避免把「正在思考」留到结束后",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /chat\.externalAgent\.activity\.noTrace/,
    why: "过程全被过滤时给一句说明，不留空白面板",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /data-testid="external-agent-activity-panel-unseen"/,
    why: "上滚期间用「N 条新过程」胶囊提示，点击回到底部（不抢滚动位置）",
  },
  // ── 注意力 / 数据完整性（2026-11-05，借 herdr 的 seen + 可解释状态）──
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /markExternalAgentActivitySeen\(sessionId, activity\.taskId\)/,
    why: "面板打开即视为已看：清掉侧栏 tab / 卡片上的未读点",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /data-testid="external-agent-activity-panel-idle"/,
    why: "运行中长时间无新输出要提示「已 N 分钟无新输出」，不让用户去猜是否卡住",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /data-testid="external-agent-activity-panel-source-truncated"/,
    why: "源输出被截断（artifact 超上限）必须显式提示，不能静默当作完整记录",
  },
  {
    file: "src/v4/composer/ExternalAgentActivityCard.tsx",
    pattern: /data-testid="external-agent-activity-idle"/,
    why: "状态卡同样提示无输出分钟数（用户不进面板也能看到）",
  },
  {
    file: "src/v4/composer/ExternalAgentActivityCardSlot.tsx",
    pattern: /state\.unreadTaskId !== activity\.taskId \|\| !state\.unreadLive/,
    why: "只有实时看着跑完才自动销未读；切走期间完成（replayed）要留给用户显式查看",
  },
  {
    file: "src/v4/composer/ExternalAgentActivityCardSlot.tsx",
    pattern: /markExternalAgentActivitySeen\(sessionId, taskId\)/,
    why: "关掉卡片是显式「我看到了」，同样销未读",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /replayed,\s*cleared: externalAgentActivitySnapshot === null/,
    why: "第一帧活动标记 replayed/cleared——区分「看着跑完」「回来才发现跑完」「服务端明确清空」",
  },
  {
    file: "src/v4/SessionPane.tsx",
    pattern: /visible=\{presentationVisible !== false\}/,
    why: "隐藏的 forceMount 宿主不能销未读，否则切回来提示已被悄悄清掉",
  },
  {
    file: "src/app-shell/SidePaneTabTrigger.tsx",
    pattern: /data-testid="external-agent-activity-tab-unread"/,
    why: "人不在那个会话时，靠侧栏 tab 上的未读点知道任务完成了",
  },
  // ── 冷恢复的「上次执行」摘要（2026-11-05）──
  {
    file: "src/v4/composer/ExternalAgentActivityCardSlot.tsx",
    pattern: /activity\.historical \|\| activity\.taskId === dismissedTaskId/,
    why: "历史摘要不弹卡片（每次开会话顶一张旧卡太吵），只在过程面板回显",
  },
  {
    file: "src/app-shell/ExternalAgentActivitySidePane.tsx",
    pattern: /data-testid="external-agent-activity-panel-historical"/,
    why: "面板必须标出「上次执行」，否则用户以为刚跑过",
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
