// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkFeaturesSectionContent } from "../src/settings/fork-features/ForkFeaturesSection.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

const setPendingSettingsSection = vi.fn();
vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSection: (section: string) => setPendingSettingsSection(section),
}));

// 被搬进本页的三个子组件各自依赖服务与模块级 store，这里只验证它们被渲染，不验证内部行为。
vi.mock("@/settings/ai-features/index.js", () => ({
  OracleReviewModelSetting: () => createElement("div", { "data-testid": "oracle-model" }),
  PromptOptimizerSetting: () => createElement("div", { "data-testid": "prompt-optimizer" }),
}));

vi.mock("@/settings/DynamicWorkflowModeSetting.js", () => ({
  DynamicWorkflowModeSetting: () => createElement("div", { "data-testid": "dynamic-workflow" }),
}));

const noop = () => {};

function renderSection(overrides: Partial<Parameters<typeof ForkFeaturesSectionContent>[0]> = {}) {
  const handlers = {
    onOracleReviewEnabledChange: vi.fn(),
    onPromptOptimizerEnabledChange: vi.fn(),
    onMonitorToolEnabledChange: vi.fn(),
    onNotebookEditEnabledChange: vi.fn(),
    onApplyPatchEnabledChange: vi.fn(),
    onMemoryFileEditingEnabledChange: vi.fn(),
    onMemoryCaptureEnabledChange: vi.fn(),
    onMemoryDreamManualEnabledChange: vi.fn(),
    onApplyPreset: vi.fn(),
    onDismissNotice: vi.fn(),
  };
  render(
    createElement(ForkFeaturesSectionContent, {
      oracleReviewEnabled: false,
      promptOptimizerEnabled: true,
      monitorToolEnabled: false,
      notebookEditEnabled: false,
      applyPatchEnabled: false,
      memoryFileEditingEnabled: false,
      memoryCaptureEnabled: false,
      memoryDreamManualEnabled: false,
      memoryEnabled: true,
      showNotice: false,
      ...handlers,
      ...overrides,
    }),
  );
  return handlers;
}

const switchByName = (label: string) =>
  screen.getByRole("switch", { name: label }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  noop();
});

describe("ForkFeaturesSectionContent", () => {
  it("renders every fork switch with the injected values", () => {
    renderSection({ promptOptimizerEnabled: true, monitorToolEnabled: true });

    expect(switchByName("settings.forkFeatures.promptOptimizer").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(switchByName("settings.forkFeatures.monitorTool").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(switchByName("settings.forkFeatures.notebookEdit").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(switchByName("settings.forkFeatures.applyPatch").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("routes each click to its own handler", () => {
    const handlers = renderSection();

    fireEvent.click(switchByName("settings.forkFeatures.monitorTool"));
    fireEvent.click(switchByName("settings.forkFeatures.notebookEdit"));
    fireEvent.click(switchByName("settings.forkFeatures.applyPatch"));
    fireEvent.click(switchByName("settings.forkFeatures.memoryCapture"));

    expect(handlers.onMonitorToolEnabledChange).toHaveBeenCalledWith(true);
    expect(handlers.onNotebookEditEnabledChange).toHaveBeenCalledWith(true);
    expect(handlers.onApplyPatchEnabledChange).toHaveBeenCalledWith(true);
    expect(handlers.onMemoryCaptureEnabledChange).toHaveBeenCalledWith(true);
    expect(handlers.onPromptOptimizerEnabledChange).not.toHaveBeenCalled();
  });

  it("disables the memory switches while memory itself is off", () => {
    renderSection({ memoryEnabled: false });

    expect(switchByName("settings.forkFeatures.memoryFileEditing").disabled).toBe(true);
    expect(switchByName("settings.forkFeatures.memoryCapture").disabled).toBe(true);
    expect(switchByName("settings.forkFeatures.memoryDreamManual").disabled).toBe(true);
    // 非记忆开关不受影响。
    expect(switchByName("settings.forkFeatures.monitorTool").disabled).toBe(false);
    expect(screen.getByText("settings.forkFeatures.memoryDisabledHint")).toBeTruthy();
  });

  it("keeps the moved AI-feature blocks mounted on the new page", () => {
    renderSection();

    expect(screen.getByTestId("oracle-model")).toBeTruthy();
    expect(screen.getByTestId("prompt-optimizer")).toBeTruthy();
    expect(screen.getByTestId("dynamic-workflow")).toBeTruthy();
  });

  it("jumps to the performance section instead of duplicating its switches", () => {
    renderSection();

    fireEvent.click(screen.getByText("settings.forkFeatures.performanceLinkAction"));
    expect(setPendingSettingsSection).toHaveBeenCalledWith("performance");
  });

  it("applies a recommended preset in one click", () => {
    const handlers = renderSection();

    fireEvent.click(screen.getAllByText("settings.forkFeatures.preset.apply")[0]);
    expect(handlers.onApplyPreset).toHaveBeenCalledWith("tools");

    fireEvent.click(screen.getAllByText("settings.forkFeatures.preset.apply")[1]);
    expect(handlers.onApplyPreset).toHaveBeenCalledWith("memory");
  });

  it("marks a fully enabled preset as applied and does not dispatch again", () => {
    const handlers = renderSection({
      monitorToolEnabled: true,
      notebookEditEnabled: true,
      applyPatchEnabled: true,
    });

    const applied = screen.getByText("settings.forkFeatures.preset.applied");
    fireEvent.click(applied);
    expect(handlers.onApplyPreset).not.toHaveBeenCalled();
  });

  it("disables the memory preset while memory itself is off", () => {
    renderSection({ memoryEnabled: false });

    // 推荐组合区两个按钮都在，但记忆那个被置灰。
    const presetButtons = screen
      .getAllByText("settings.forkFeatures.preset.apply")
      .map((node) => node.closest("button") as HTMLButtonElement | null);
    expect(presetButtons).toHaveLength(2);
    expect(presetButtons.filter((button) => button?.disabled === true)).toHaveLength(1);
  });

  it("shows the first-visit notice only when asked and reports dismissal", () => {
    const hidden = renderSection({ showNotice: false });
    expect(screen.queryByText("settings.forkFeatures.noticeTitle")).toBeNull();
    cleanup();

    const shown = renderSection({ showNotice: true });
    expect(screen.getByText("settings.forkFeatures.noticeTitle")).toBeTruthy();
    fireEvent.click(screen.getByText("settings.forkFeatures.noticeDismiss"));
    expect(shown.onDismissNotice).toHaveBeenCalledTimes(1);
    expect(hidden.onDismissNotice).not.toHaveBeenCalled();
  });

  it("labels default-off features as experimental without tagging shipped ones", () => {
    renderSection();

    // 6 项默认关闭的功能各一个徽标；promptOptimizer 与 Oracle 审查已随版本发布，不标实验。
    expect(screen.getAllByText("settings.forkFeatures.experimentalBadge")).toHaveLength(6);
  });
});
