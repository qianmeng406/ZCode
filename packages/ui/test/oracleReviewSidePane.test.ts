// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";
import { OracleReviewSidePane } from "@/app-shell/OracleReviewSidePane.js";
import { createOracleReviewSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  clearOracleReviewStoreForTests,
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

const SESSION_ID = "s1";
const tab = createOracleReviewSidePaneTab({
  workspaceKey: "/repo",
  workspacePath: "/repo",
  sessionId: SESSION_ID,
});

const TRACE: OracleReviewTraceEntry[] = [
  { kind: "stage", stage: "collecting", at: 1 },
  { kind: "stage", stage: "analyzing", at: 2 },
  { kind: "text", stage: "analyzing", round: 1, text: "上下文：改动集中在设置页" },
  { kind: "stage", stage: "reviewing", at: 3 },
  { kind: "tool", round: 1, toolName: "Read", target: "src/a.ts", at: 4 },
  { kind: "text", stage: "reviewing", round: 1, text: "VERDICT: WARN\nFINDINGS: 需要注意" },
];

afterEach(() => {
  cleanup();
  clearOracleReviewStoreForTests();
});

describe("OracleReviewSidePane", () => {
  it("结果态：按轨迹顺序渲染阶段、工具与逐轮正文，并展示完整结论", () => {
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
    expect(container.textContent).toContain("上下文：改动集中在设置页");

    const stages = screen.getAllByTestId("v4-oracle-review-panel-stage");
    expect(stages.map((node) => node.textContent)).toEqual(["取材料", "上下文分析", "审查中"]);
    const tools = screen.getAllByTestId("v4-oracle-review-panel-tool");
    expect(tools[0]?.textContent).toContain("Read");
    expect(tools[0]?.textContent).toContain("src/a.ts");
    const texts = screen.getAllByTestId("v4-oracle-review-panel-text");
    expect(texts.map((node) => node.textContent)).toEqual([
      "上下文：改动集中在设置页",
      "VERDICT: WARN\nFINDINGS: 需要注意",
    ]);
  });

  it("运行中：显示阶段徽标，轨迹实时追加（正文不合并为一条）", () => {
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
    // 运行中没有结论段
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

  it("idle：面板没有内容时自动关闭 tab", () => {
    const onClose = vi.fn();
    render(createElement(OracleReviewSidePane, { tab, onClose }));
    expect(onClose).toHaveBeenCalled();
  });
});
