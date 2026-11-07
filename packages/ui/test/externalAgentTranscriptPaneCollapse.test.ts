// @vitest-environment jsdom
// 上下文面板的折叠语义。
//
// 实测反馈（2026-11-07）：81 条历史的会话一打开，终端输出全摊开成一面日志墙；
// 长正文点「展开全文」后按钮被推到块尾，看起来像"展开了收不回去"。
// 两条约束钉在这里：
// 1. 工具结果默认收起成一行摘要，点行展开、再点收起；
// 2. 长正文的展开/收起按钮在展开态粘在块顶，正文再长也够得到。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentTranscriptSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }): string => descriptor.id,
    },
  }),
}));
vi.mock("@/gen-ui/index.js", () => ({
  GenUiMessageResponse: (props: { children?: unknown }) =>
    createElement("div", { "data-testid": "fake-genui" }, props.children as never),
}));
vi.mock("@/v4/ConversationUserInputBubble.js", () => ({
  ConversationUserInputBubble: (props: { text: string }) =>
    createElement("div", { "data-testid": "fake-prompt" }, props.text),
}));
vi.mock("@/v4/externalAgent/ExternalAgentToolRow.js", () => ({
  ExternalAgentToolRow: (props: { text: string }) =>
    createElement("div", { "data-testid": "fake-tool-row" }, props.text),
  resolveExternalAgentToolPresentation: () => ({ icon: null, kindLabel: "终端" }),
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

const store = await import("@/v4/externalAgent/externalAgentTranscriptStore.js");
const { ExternalAgentTranscriptSidePane } =
  await import("@/app-shell/ExternalAgentTranscriptSidePane.js");

const SESSION_ID = "sess-1";
const EXTERNAL_SESSION_ID = "ext-1";
const KEY = store.externalAgentTranscriptKey(SESSION_ID, EXTERNAL_SESSION_ID);

const TAB = {
  id: `external-agent-transcript:${SESSION_ID}:${EXTERNAL_SESSION_ID}`,
  type: "external-agent-transcript",
  workspaceKey: "/w",
  workspacePath: "/w",
  rootSessionId: SESSION_ID,
  sessionId: SESSION_ID,
  externalSessionId: EXTERNAL_SESSION_ID,
  title: "只读分析任务",
} as unknown as ExternalAgentTranscriptSidePaneTab;

/** 40 行终端输出：远超折叠阈值（800 字符 / 12 行）。 */
const LONG_OUTPUT = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n");
// 刻意不含 "line-"：断言工具结果收起时，正则不能被助手正文误命中。
const LONG_ASSISTANT = Array.from({ length: 40 }, () => "助手的长正文片段").join("\n");
const WRAPPED_OUTPUT = "total 1285\ndrwxr-xr-x 1 user 197121 0 Oct 31 21:47 ./";

function renderPane() {
  store.registerExternalAgentTranscriptLoader(KEY, async () => ({
    entries: [
      { kind: "tool_result", name: "Bash", text: LONG_OUTPUT },
      // CLI 把 REPL 的结果包在 {"result": "..."} 里：摘要要取出正文，而不是把 JSON 露出来。
      { kind: "tool_result", name: "REPL", text: JSON.stringify({ result: WRAPPED_OUTPUT }) },
      // 被长度上限截断过的包装（末尾是 `…` 而不是 `"}`）：JSON 解不了，按前缀剥壳。
      { kind: "tool_result", name: "REPL", text: '{"result":"截断过的输出正文…' },
      { kind: "assistant", text: LONG_ASSISTANT },
    ],
    total: 4,
    hasMore: false,
    truncated: false,
  }));
  return render(
    createElement(ExternalAgentTranscriptSidePane, { tab: TAB, onClose: () => undefined }),
  );
}

beforeEach(() => {
  store.resetExternalAgentTranscript(KEY);
});

afterEach(() => {
  cleanup();
  store.resetExternalAgentTranscript(KEY);
});

describe("ExternalAgentTranscriptSidePane 折叠", () => {
  it("工具结果默认收起为一行摘要，点行展开、再点收起", async () => {
    renderPane();

    // 摘要行用第一行输出做预览（收起的证据：后面的行不在文档里）。
    await screen.findByText(/^line-1 line-2/);
    expect(screen.queryByText(/line-40/)).toBeNull();

    fireEvent.click(screen.getAllByLabelText("chat.toolCall.expandDetails")[0]!);
    await waitFor(() => expect(screen.getByText(/line-40/)).toBeTruthy());

    fireEvent.click(screen.getAllByLabelText("chat.toolCall.collapseDetails")[0]!);
    await waitFor(() => expect(screen.queryByText(/line-40/)).toBeNull());
  });

  it("工具结果摘要取出 JSON 包装里的正文，压成一行", async () => {
    renderPane();

    // 摘要是一行可读文本；JSON 结构（result 键、转义换行）不该露给用户。
    const preview = await screen.findByText(/total 1285 drwxr-xr-x/);
    expect(preview.textContent).toBe("total 1285 drwxr-xr-x 1 user 197121 0 Oct 31 21:47 ./");
    // 被截断的包装（末尾 `…`，JSON 不合法）同样要剥出来。
    expect(screen.getByText("截断过的输出正文")).toBeTruthy();
    expect(screen.queryByText(/\{"result"/)).toBeNull();
  });

  it("长正文展开后收起按钮仍在，可以收回去", async () => {
    renderPane();

    const toggle = await screen.findByTestId("external-agent-transcript-clamp-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("chat.externalAgent.transcript.expand");

    fireEvent.click(toggle);
    // 展开态按钮换成「收起」并且仍在（粘在块顶，正文再长也能点到）。
    // 注意要重新查询：收起态与展开态的按钮挂在块的不同位置，React 会换节点。
    const expandedToggle = screen.getByTestId("external-agent-transcript-clamp-toggle");
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(expandedToggle.textContent).toBe("chat.externalAgent.transcript.collapse");

    fireEvent.click(expandedToggle);
    expect(
      screen.getByTestId("external-agent-transcript-clamp-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
