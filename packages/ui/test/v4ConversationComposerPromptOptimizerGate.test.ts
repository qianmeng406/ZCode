import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { RemoteConversationAvailability } from "@/v4/RemoteConversationAvailability.js";

// fork 开关「提示词优化」的渲染门禁：关闭时 composer 里不能出现 ✨，打开时才渲染。
// 组件自身默认 true（设置尚未加载的瞬间），所以关掉开关必须靠宿主显式传 false。
vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: {
      leadingActions?: ReactNode;
      submitControl?: ReactNode;
      topContent?: ReactNode;
    }) =>
      React.createElement(
        "form",
        { "data-testid": "mock-chat-prompt-editor" },
        props.topContent,
        props.leadingActions,
        props.submitControl,
      ),
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachments: [],
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    attachmentInputRef: { current: null },
    openAttachmentPicker: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handlePaste: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  const Stub = () => React.createElement("span", null, "toolbar");
  return {
    V4ComposerModeSwitch: Stub,
    V4ComposerModelControls: Stub,
  };
});

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const AnyConversationComposer = ConversationComposer as unknown as (props: {
  promptOptimizerEnabled?: boolean;
}) => ReactNode;

function renderMarkup(promptOptimizerEnabled: boolean | undefined): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(RemoteConversationAvailability, {
        available: true,
        children: createElement(AnyConversationComposer as never, {
          snapshot: makeSnapshot(),
          sessionId: "session-1",
          workspacePath: "/workspace",
          provider: undefined,
          onSendText: vi.fn(async () => {}),
          onStop: vi.fn(),
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSwitchMode: vi.fn(),
          promptOptimizerEnabled,
        }),
      }),
    ),
  );
}

describe("ConversationComposer prompt optimizer gate", () => {
  it("renders the ✨ action while the fork switch is on", () => {
    expect(renderMarkup(true)).toContain('data-testid="v4-composer-optimize-prompt"');
  });

  it("omits the ✨ action when the fork switch is off", () => {
    expect(renderMarkup(false)).not.toContain("v4-composer-optimize-prompt");
  });

  it("defaults to visible while settings have not loaded (undefined)", () => {
    expect(renderMarkup(undefined)).toContain('data-testid="v4-composer-optimize-prompt"');
  });
});
