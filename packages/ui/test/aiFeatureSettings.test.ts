// @vitest-environment jsdom
// 提示词优化 / Oracle 审查的配置已从输入栏移到常规设置；这里锁住设置行的保存语义。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(async (_patch: unknown) => undefined),
  settings: {} as Record<string, unknown>,
  view: {
    revision: 1,
    providers: [
      {
        providerId: "openai",
        providerName: "OpenAI",
        models: [
          {
            modelId: "gpt-5",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
        ],
      },
    ],
  },
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings, update: mocks.update }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ modelSelectionService: {} }),
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: () => ({
    state: { status: "ready", view: mocks.view },
    reload: vi.fn(),
    refresh: vi.fn(async () => ({ kind: "ready", view: mocks.view })),
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/select.js", async () => {
  const React = await import("react");
  type SelectContextValue = (value: string) => void;
  const SelectContext = React.createContext<SelectContextValue>(() => undefined);
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: SelectContextValue;
      children: React.ReactNode;
    }) =>
      React.createElement(
        SelectContext.Provider,
        { value: onValueChange },
        React.createElement("div", { "data-select-value": value }, children),
      ),
    SelectTrigger: ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement("button", props, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    SelectGroup: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    SelectLabel: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    SelectItem: ({
      value,
      children,
      ...props
    }: {
      value: string;
      children: React.ReactNode;
      "data-testid"?: string;
    }) => {
      const onSelect = React.useContext(SelectContext);
      return React.createElement("button", { ...props, onClick: () => onSelect(value) }, children);
    },
  };
});

import { OracleReviewModelSetting, PromptOptimizerSetting } from "@/settings/ai-features/index.js";

describe("AI feature settings", () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(undefined);
    mocks.settings = {};
  });
  afterEach(() => cleanup());

  it("renders optimizer model/mode/context and oracle model rows", () => {
    render(createElement(PromptOptimizerSetting));
    expect(screen.getByTestId("settings-prompt-optimizer-model-trigger")).toBeTruthy();
    expect(screen.getByTestId("settings-prompt-optimizer-mode-trigger")).toBeTruthy();
    expect(screen.getByTestId("settings-prompt-optimizer-context-trigger")).toBeTruthy();
    expect(screen.getByTestId("settings-prompt-optimizer-model-openai-gpt-5")).toBeTruthy();

    render(createElement(OracleReviewModelSetting));
    expect(screen.getByTestId("settings-oracle-review-model-trigger")).toBeTruthy();
    expect(screen.getByTestId("settings-oracle-review-model-openai-gpt-5")).toBeTruthy();
  });

  it("uses the lowest reasoning level when picking an optimizer model", async () => {
    render(createElement(PromptOptimizerSetting));
    fireEvent.click(screen.getByTestId("settings-prompt-optimizer-model-openai-gpt-5"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        promptOptimizerModel: {
          providerId: "openai",
          modelId: "gpt-5",
          options: { reasoningLevel: "low" },
        },
      }),
    );
  });

  it("saves optimizer mode and context choices", async () => {
    render(createElement(PromptOptimizerSetting));
    fireEvent.click(screen.getByTestId("settings-prompt-optimizer-mode-structure"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ promptOptimizerMode: "structure" }),
    );
    fireEvent.click(screen.getByTestId("settings-prompt-optimizer-context-draft"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ promptOptimizerContextRange: "draft" }),
    );
  });

  it("writes the lowest reasoning level when picking an oracle model", async () => {
    render(createElement(OracleReviewModelSetting));
    fireEvent.click(screen.getByTestId("settings-oracle-review-model-openai-gpt-5"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        oracleReviewModel: {
          providerId: "openai",
          modelId: "gpt-5",
          options: { reasoningLevel: "low" },
        },
      }),
    );
  });

  it("writes an explicit oracle reasoning level and shows the effective level for legacy no-level picks", async () => {
    mocks.settings = {
      oracleReviewModel: { providerId: "openai", modelId: "gpt-5" },
    };
    render(createElement(OracleReviewModelSetting));
    // 无档存量选择在下拉中显示为最低档（与实际执行语义一致），不出现永不选中的哨兵项。
    const levelSelect = screen
      .getByTestId("settings-oracle-review-level-trigger")
      .closest("[data-select-value]");
    expect(levelSelect?.getAttribute("data-select-value")).toBe("low");
    fireEvent.click(screen.getByTestId("settings-oracle-review-level-high"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        oracleReviewModel: {
          providerId: "openai",
          modelId: "gpt-5",
          options: { reasoningLevel: "high" },
        },
      }),
    );
  });

  it("writes an explicit optimizer reasoning level", async () => {
    mocks.settings = {
      promptOptimizerModel: {
        providerId: "openai",
        modelId: "gpt-5",
        options: { reasoningLevel: "high" },
      },
    };
    render(createElement(PromptOptimizerSetting));
    fireEvent.click(screen.getByTestId("settings-prompt-optimizer-level-low"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        promptOptimizerModel: {
          providerId: "openai",
          modelId: "gpt-5",
          options: { reasoningLevel: "low" },
        },
      }),
    );
  });
});
