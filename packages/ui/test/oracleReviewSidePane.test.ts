// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import { OracleReviewSidePane } from "@/app-shell/OracleReviewSidePane.js";
import { createOracleReviewSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  clearOracleReviewStoreForTests,
  seedOracleReviewHistory,
  setOracleReviewState,
} from "@/v4/oracleReview/oracleReviewStore.js";
import type { OracleReviewTraceEntry } from "@/v4/oracleReview/oracleReviewSupport.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, number | string> = {}) =>
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          zhCN[id] ?? id,
        ),
    },
  }),
}));

// 面板只需要 provider 目录做模型名解析；这里固定返回空目录，避免依赖整个服务上下文。
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({ state: { status: "unavailable", reason: "missing-target" } }),
}));

// jsdom 不实现 matchMedia；MessageResponse 在 theme 缺省时用它选代码块配色。
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const SESSION_ID = "s1";
const tab = createOracleReviewSidePaneTab({
  workspaceKey: "/repo",
  workspacePath: "/repo",
  sessionId: SESSION_ID,
});

const TRACE: OracleReviewTraceEntry[] = [
  { kind: "stage", stage: "collecting", at: 1 },
  { kind: "stage", stage: "analyzing", at: 2 },
  // 分析器原始 JSON：不应当上屏。
  { kind: "text", stage: "analyzing", round: 1, text: '{"priorContext":[{"rowId":1}]}' },
  {
    kind: "note",
    note: "context-candidates",
    priorCount: 2,
    turnCount: 1,
    constraintCount: 1,
  },
  { kind: "stage", stage: "reviewing", at: 3 },
  { kind: "tool", round: 1, toolName: "Read", target: "src/a.ts", at: 4 },
  { kind: "text", stage: "reviewing", round: 1, text: "第一轮取证：查看了 a.ts 的实现" },
  { kind: "tool", round: 2, toolName: "Grep", target: "TODO", at: 5 },
  { kind: "text", stage: "reviewing", round: 2, text: "VERDICT: WARN\nFINDINGS: 需要注意" },
];

afterEach(() => {
  cleanup();
  clearOracleReviewStoreForTests();
});

describe("OracleReviewSidePane", () => {
  it("结果态：按轨迹顺序渲染阶段、工具、历史轮次与可读摘要，隐藏 JSON 与最终重复正文", () => {
    setOracleReviewState(SESSION_ID, {
      status: "result",
      mode: "manual",
      reviewId: "r1",
      turnRowId: 1,
      entityId: "e1",
      verdict: "warn",
      summary: "总结全文",
      findings: "问题一\n问题二",
      modelLabel: "p/m",
      depth: "deep",
      completedAt: 10,
      trace: TRACE,
    });
    const { container } = render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));

    expect(screen.getByTestId("v4-oracle-review-panel")).toBeTruthy();
    expect(container.textContent).toContain("总结全文");
    expect(container.textContent).toContain("问题一");

    const stages = screen.getAllByTestId("v4-oracle-review-panel-stage");
    expect(stages.map((node) => node.textContent)).toEqual(["取材料", "上下文分析", "审查中"]);
    const tools = screen.getAllByTestId("v4-oracle-review-panel-tool");
    expect(tools).toHaveLength(2);
    // 会话同款工具行：动作标签 + 文件 chip（文件名），完整路径在次行；
    // 不再是 `#1 Read src/a.ts` 的等宽清单。
    expect(tools[0]?.textContent).toContain("读取");
    expect(tools[0]?.textContent).toContain("a.ts");
    expect(tools[0]?.textContent).toContain("src/a.ts");
    expect(tools[0]?.textContent).not.toContain("#1");
    expect(tools[1]?.textContent).toContain("搜索");
    expect(tools[1]?.textContent).toContain("TODO");

    // 内部分析 JSON 不上屏；最终一轮正文已解析成上方各分节，不再重复。
    expect(container.textContent).not.toContain("priorContext");
    expect(container.textContent).not.toContain("VERDICT: WARN");
    const texts = screen.getAllByTestId("v4-oracle-review-panel-text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.textContent).toContain("第一轮取证");

    expect(screen.getByTestId("v4-oracle-review-panel-note").textContent).toBe(
      "已关联 2 条历史上下文 · 1 个相关轮次 · 1 条现行约束",
    );
  });

  it("工具行按会话工具卡渲染：Bash 指令走次行，未知工具保留原名", () => {
    setOracleReviewState(SESSION_ID, {
      status: "pending",
      mode: "manual",
      reviewId: "r-tools",
      startedAt: Date.now(),
      stage: "reviewing",
      modelLabel: "p/m",
      depth: "deep",
      request: {
        reviewId: "r-tools",
        depth: "deep",
        mode: "manual",
        sessionId: SESSION_ID,
        workspacePath: "/repo",
        target: { rowId: 1, entityId: "e1" },
        createdAt: Date.now(),
      },
      trace: [
        { kind: "stage", stage: "reviewing", at: 1 },
        { kind: "tool", round: 1, toolName: "Bash", target: "git log --oneline -6", at: 2 },
        { kind: "tool", round: 1, toolName: "Lookup", target: "acme", at: 3 },
      ],
    });
    render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));

    const [bashRow, unknownRow] = screen.getAllByTestId("v4-oracle-review-panel-tool");
    expect(bashRow?.textContent).toContain("终端");
    expect(bashRow?.textContent).toContain("git log --oneline -6");
    expect(unknownRow?.textContent).toContain("Lookup");
    expect(unknownRow?.textContent).toContain("acme");
  });

  it("思考：用会话原生思考块渲染，默认收起、点开可见全文", () => {
    setOracleReviewState(SESSION_ID, {
      status: "pending",
      mode: "manual",
      reviewId: "r-reasoning",
      startedAt: Date.now(),
      stage: "reviewing",
      modelLabel: "p/m",
      depth: "deep",
      request: {
        reviewId: "r-reasoning",
        depth: "deep",
        mode: "manual",
        sessionId: SESSION_ID,
        workspacePath: "/repo",
        target: { rowId: 1, entityId: "e1" },
        createdAt: Date.now(),
      },
      trace: [
        { kind: "stage", stage: "reviewing", at: 1 },
        {
          kind: "reasoning",
          stage: "reviewing",
          round: 1,
          text: "先确认调用方是否传了 stage",
          at: 1000,
          updatedAt: 6000,
        },
        { kind: "text", stage: "reviewing", round: 1, text: "结论" },
      ],
    });
    render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));

    expect(screen.getByTestId("v4-oracle-review-panel-reasoning")).toBeTruthy();
    // 时长按轨迹时间戳还原（1000→6000 即 5 秒），与会话原生块同款。
    expect(screen.getByTestId("chat-reasoning-trigger").textContent).toContain("持续了 5 秒");
    // 收起态只保留折叠容器（Radix 的 hidden），思考正文不渲染（与会话一致）。
    const collapsed = screen.getByTestId("chat-reasoning-content");
    expect(collapsed.hasAttribute("hidden")).toBe(true);
    expect(collapsed.textContent).toBe("");

    fireEvent.click(screen.getByTestId("chat-reasoning-trigger"));
    expect(screen.getByTestId("chat-reasoning-content").textContent).toContain(
      "先确认调用方是否传了 stage",
    );
  });

  it("运行中：显示阶段徽标并实时追加正文，不渲染结论分节", () => {
    setOracleReviewState(SESSION_ID, {
      status: "pending",
      mode: "manual",
      reviewId: "r2",
      startedAt: Date.now(),
      stage: "reviewing",
      modelLabel: "p/m",
      depth: "standard",
      request: {
        reviewId: "r2",
        depth: "standard",
        mode: "manual",
        sessionId: SESSION_ID,
        workspacePath: "/repo",
        target: { rowId: 1, entityId: "e1" },
        createdAt: Date.now(),
      },
      trace: [
        { kind: "stage", stage: "collecting", at: 1 },
        { kind: "text", stage: "collecting", round: 1, text: "正在生成…" },
      ],
    });
    const { container } = render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));

    expect(container.textContent).toContain("审查中");
    expect(container.textContent).toContain("正在生成…");
    expect(container.textContent).not.toContain("审查总结");

    act(() => {
      setOracleReviewState(SESSION_ID, {
        status: "pending",
        mode: "manual",
        reviewId: "r2",
        startedAt: Date.now() - 1000,
        stage: "reviewing",
        modelLabel: "p/m",
        depth: "standard",
        request: {
          reviewId: "r2",
          depth: "standard",
          mode: "manual",
          sessionId: SESSION_ID,
          workspacePath: "/repo",
          target: { rowId: 1, entityId: "e1" },
          createdAt: Date.now() - 1000,
        },
        trace: [
          { kind: "stage", stage: "collecting", at: 1 },
          { kind: "text", stage: "reviewing", round: 1, text: "追加一段" },
        ],
      });
    });
    expect(screen.getByTestId("v4-oracle-review-panel").textContent).toContain("追加一段");
  });

  it("错误态：展示失败原因与已产生的轨迹", () => {
    setOracleReviewState(SESSION_ID, {
      status: "error",
      mode: "manual",
      reviewId: "r3",
      failure: { kind: "timeout", message: "deadline exceeded" },
      modelLabel: "p/m",
      depth: "deep",
      trace: [{ kind: "stage", stage: "reviewing", at: 1 }],
    });
    const { container } = render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));
    expect(container.textContent).toContain("失败原因");
    expect(container.textContent).toContain("deadline exceeded");
    expect(screen.getAllByTestId("v4-oracle-review-panel-stage")[0]?.textContent).toBe("审查中");
  });

  it("上下文为空时给出「未关联历史」而不是空行", () => {
    setOracleReviewState(SESSION_ID, {
      status: "pending",
      mode: "manual",
      reviewId: "r4",
      startedAt: Date.now(),
      stage: "reviewing",
      modelLabel: "p/m",
      depth: "standard",
      request: {
        reviewId: "r4",
        depth: "standard",
        mode: "manual",
        sessionId: SESSION_ID,
        workspacePath: "/repo",
        target: { rowId: 1, entityId: "e1" },
        createdAt: Date.now(),
      },
      trace: [
        { kind: "stage", stage: "analyzing", at: 1 },
        {
          kind: "note",
          note: "context-candidates",
          priorCount: 0,
          turnCount: 0,
          constraintCount: 0,
        },
      ],
    });
    render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));
    expect(screen.getByTestId("v4-oracle-review-panel-note").textContent).toBe(
      "未关联历史上下文，直接审查目标回合",
    );
  });

  it("idle：面板没有内容时自动关闭 tab", () => {
    const onClose = vi.fn();
    render(createElement(OracleReviewSidePane, { tab, onClose }));
    expect(onClose).toHaveBeenCalled();
  });

  it("idle 但有持久历史：面板保留，渲染历史结论与完整原文", () => {
    seedOracleReviewHistory(SESSION_ID, [
      {
        reviewId: "rv-hist",
        sessionId: SESSION_ID,
        depth: "standard",
        mode: "manual",
        target: { rowId: 933, entityId: "e-hist" },
        verdict: "warn",
        summary: "分段判据存在合理疑点",
        findings: "[中] 读取态判据依赖 segment 内部构成",
        rawOutput: "VERDICT: WARN\n\n原始结论全文",
        modelLabel: "p/m",
        createdAt: 1_700_000_000_000,
        completedAt: 1_700_000_060_000,
        acknowledgedAt: 1_700_000_070_000,
      },
    ]);
    const onClose = vi.fn();
    render(createElement(OracleReviewSidePane, { tab, onClose }));

    expect(screen.getByTestId("v4-oracle-review-panel-history")).toBeTruthy();
    const items = screen.getAllByTestId("v4-oracle-review-history-item");
    expect(items).toHaveLength(1);
    const historyText = (): string =>
      screen.getAllByTestId("v4-oracle-review-history-item")[0]?.textContent ?? "";
    expect(historyText()).toContain("分段判据存在合理疑点");
    expect(historyText()).toContain("已关闭");

    // 条目默认折叠：先展开卡片，再展开分节（分节正文与会话正文同源渲染）。
    const item = () => screen.getAllByTestId("v4-oracle-review-history-item")[0]!;
    expect(item().getAttribute("data-open")).toBe("false");
    fireEvent.click(within(item()).getAllByRole("button")[0]!);
    expect(item().getAttribute("data-open")).toBe("true");

    const sectionButton = (title: string): HTMLElement => {
      const node = screen
        .getAllByRole("button")
        .find((candidate) => candidate.textContent === title);
      expect(node, `找不到分节：${title}`).toBeTruthy();
      return node!;
    };
    fireEvent.click(sectionButton("问题清单"));
    expect(historyText()).toContain("读取态判据依赖 segment 内部构成");
    // 格式解析失败时唯一保留的整段原文也必须可回看。
    fireEvent.click(sectionButton("完整结论"));
    expect(historyText()).toContain("原始结论全文");
    // 关掉卡片不等于丢结论：有历史时绝不能自动收起。
    expect(onClose).not.toHaveBeenCalled();
  });

  it("历史与当前结果同时存在：当前结果不重复出现在历史区", () => {
    setOracleReviewState(SESSION_ID, {
      status: "result",
      mode: "manual",
      reviewId: "rv-current",
      turnRowId: 1,
      entityId: "e1",
      verdict: "pass",
      summary: "当前结论",
      findings: "无",
      modelLabel: "p/m",
      depth: "standard",
      completedAt: 20,
    });
    seedOracleReviewHistory(SESSION_ID, [
      {
        reviewId: "rv-current",
        sessionId: SESSION_ID,
        depth: "standard",
        mode: "manual",
        target: { rowId: 1, entityId: "e1" },
        verdict: "pass",
        summary: "当前结论",
        findings: "无",
        modelLabel: "p/m",
        createdAt: 10,
        completedAt: 20,
      },
      {
        reviewId: "rv-older",
        sessionId: SESSION_ID,
        depth: "standard",
        mode: "manual",
        target: { rowId: 2, entityId: "e2" },
        verdict: "fail",
        summary: "更早的结论",
        findings: "旧问题",
        modelLabel: "p/m",
        createdAt: 1,
        completedAt: 2,
      },
    ]);
    const { container } = render(createElement(OracleReviewSidePane, { tab, onClose: () => {} }));

    const items = screen.getAllByTestId("v4-oracle-review-history-item");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("更早的结论");
    expect(container.textContent?.split("当前结论").length).toBe(2);
  });
});
