// @vitest-environment jsdom
// 过程面板的「多次执行累积」：外部 CLI 的会话是续接的，面板要像子智能体一样
// 先看到主 agent 发了什么、再看到这一轮的过程，而不是每跑一次就换一屏。
// 这里把重渲染器全部替身掉，只验证版面结构与数据分组。
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import type { ExternalAgentActivitySidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, unknown>): string => {
        if (descriptor.id === "chat.externalAgent.activity.runMeta") {
          return `第 ${values?.index} 次执行`;
        }
        if (descriptor.id === "chat.externalAgent.activity.hiddenLines") {
          return `已折叠 ${values?.count} 条`;
        }
        if (descriptor.id === "chat.externalAgent.activity.completed") return "已完成";
        if (descriptor.id === "chat.externalAgent.activity.running") return "运行中";
        return descriptor.id;
      },
    },
  }),
}));
vi.mock("@/gen-ui/index.js", () => ({
  GenUiMessageResponse: (props: { children?: unknown }) =>
    createElement("div", { "data-testid": "fake-genui" }, props.children as never),
}));
vi.mock("@/components/ai-elements/reasoning.js", () => ({
  Reasoning: (props: { children?: unknown }) => createElement("div", null, props.children as never),
  ReasoningTrigger: () => null,
  ReasoningContent: () => null,
}));
vi.mock("@/v4/externalAgent/ExternalAgentToolRow.js", () => ({
  ExternalAgentToolRow: (props: { text: string }) =>
    createElement("div", { "data-testid": "fake-tool-row" }, props.text),
}));
vi.mock("@/v4/ConversationUserInputBubble.js", () => ({
  ConversationUserInputBubble: (props: { text: string }) =>
    createElement("div", { "data-testid": "fake-prompt" }, props.text),
}));
vi.mock("@/components/ui/scroll-fade-viewport.js", async () => {
  const { forwardRef } = await import("react");
  return {
    ScrollFadeViewport: forwardRef(function ScrollFadeViewport(
      props: { children?: unknown },
      ref: unknown,
    ) {
      return createElement("div", { ref: ref as never }, props.children as never);
    }),
  };
});

const store = await import("@/v4/externalAgent/externalAgentActivityStore.js");
const { ExternalAgentActivitySidePane } =
  await import("@/app-shell/ExternalAgentActivitySidePane.js");

const TAB = {
  id: "external-agent-activity:sess-1",
  type: "external-agent-activity",
  workspaceKey: "/w",
  workspacePath: "/w",
  rootSessionId: "sess-1",
  sessionId: "sess-1",
} as ExternalAgentActivitySidePaneTab;

function activity(overrides: Partial<ExternalAgentActivity>): ExternalAgentActivity {
  return {
    taskId: "run-1",
    agentLabel: "CodeBuddy",
    status: "running",
    startedAt: 1_000,
    elapsedMs: 2_000,
    ...overrides,
  };
}

function renderPane() {
  return render(createElement(ExternalAgentActivitySidePane, { tab: TAB, onClose: () => {} }));
}

afterEach(() => {
  cleanup();
  store.clearExternalAgentActivity("sess-1");
});

describe("ExternalAgentActivitySidePane 多次执行", () => {
  it("每次执行先显示主 agent 发的任务，再用分隔线标出上一次的结果", () => {
    store.publishExternalAgentActivity(
      "sess-1",
      activity({
        taskId: "run-1",
        status: "completed",
        prompt: "修 lint",
        entries: [
          { kind: "tool", text: "Bash: npm test" },
          { kind: "text", text: "改完了" },
        ],
      }),
    );
    store.publishExternalAgentActivity(
      "sess-1",
      activity({
        taskId: "run-2",
        prompt: "再跑一次测试",
        entries: [{ kind: "tool", text: "Bash: npm run test" }],
      }),
    );

    renderPane();

    const prompts = screen.getAllByTestId("fake-prompt");
    expect(prompts.map((node) => node.textContent)).toEqual(["修 lint", "再跑一次测试"]);
    // 三次工具/正文条目全部保留（第一次的执行没有被第二次顶掉）。
    expect(screen.getAllByTestId("fake-tool-row")).toHaveLength(2);
    expect(screen.getByTestId("external-agent-activity-panel-run-meta").textContent).toContain(
      "第 1 次执行",
    );
  });

  it("单次执行不显示分隔线（没有「上一次」要标）", () => {
    store.publishExternalAgentActivity(
      "sess-1",
      activity({ taskId: "run-1", prompt: "修 lint", status: "completed" }),
    );
    renderPane();
    expect(screen.getAllByTestId("fake-prompt")).toHaveLength(1);
    expect(screen.queryByTestId("external-agent-activity-panel-run-meta")).toBeNull();
  });
});
