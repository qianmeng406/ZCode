import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";

const captured = vi.hoisted(() => ({
  contentProps: null as Record<string, unknown> | null,
  permissionProps: null as Record<string, unknown> | null,
  permissionItems: [] as Array<Record<string, unknown>>,
  planProps: null as Record<string, unknown> | null,
  tooltipProps: null as Record<string, unknown> | null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: (props: Record<string, unknown> & { children?: ReactNode }) => {
    captured.tooltipProps = props;
    return createElement("span", null, props.children);
  },
}));

// 菜单是「独立 Plan 勾选 + 工作模式单选」：Beta 与其他模式同组单选，
// 不再有普通/极简/融合上下文三态 RadioGroup。
vi.mock("@/components/ui/dropdown-menu.js", () => {
  const children = (props: { children?: ReactNode }) => createElement("span", null, props.children);
  return {
    DropdownMenu: children,
    DropdownMenuTrigger: children,
    DropdownMenuSeparator: () => createElement("hr"),
    DropdownMenuContent: (props: Record<string, unknown>) => {
      captured.contentProps = props;
      return children(props);
    },
    DropdownMenuRadioGroup: (props: Record<string, unknown>) => {
      captured.permissionProps = props;
      return children(props);
    },
    DropdownMenuRadioItem: (props: Record<string, unknown>) => {
      captured.permissionItems.push(props);
      return children(props);
    },
    DropdownMenuCheckboxItem: (props: Record<string, unknown>) => {
      const testIdValue = String(props["data-testid"] ?? "");
      if (testIdValue.endsWith("plan")) {
        captured.planProps = props;
      }
      return children(props);
    },
  };
});

vi.mock("@/lib/pickerFocus.js", () => ({ isCoarseTouchDevice: () => false }));

vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({ configOptions: [] }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  getNextConfigSelectValue: vi.fn(),
  useToolbarShortcutBindings: vi.fn(),
}));

vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  // 工具条热键转正后 modeShortcutLabel 读生效表（spec §12.6）；本组件测试只关心
  // 模式选项逻辑，label 固定桩即可
  useShortcutCommandLabel: () => "Ctrl+Shift+M",
}));

import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

describe("V4ComposerModeSwitch", () => {
  beforeEach(() => {
    captured.contentProps = null;
    captured.permissionProps = null;
    captured.permissionItems = [];
    captured.planProps = null;
    captured.tooltipProps = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderModeSwitch(
    draftConfig: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig,
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
        ...extra,
      }),
    );
  }

  it("Guarded 在新的 Plan/权限菜单保持蓝色和独立 Plan 标记", () => {
    const html = renderModeSwitch({ mode: "guarded", planEnabled: true });
    expect(captured.permissionProps?.value).toBe("guarded");
    expect(captured.planProps?.checked).toBe(true);
    expect(html).toContain("text-icon-blue");
    expect(html).not.toContain("text-warning");
  });

  it("模式菜单关闭后把焦点恢复到 V4 输入框", () => {
    renderModeSwitch({ mode: "build" });

    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    vi.stubGlobal("document", { querySelector });
    const preventDefault = vi.fn();
    const close = captured.contentProps!.onCloseAutoFocus as (event: {
      preventDefault: () => void;
    }) => void;
    close({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(querySelector).toHaveBeenCalledWith(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("草稿显示自己的模式，不被旧预热 snapshot mode 覆盖", () => {
    renderModeSwitch({ mode: "yolo" });

    expect(captured.permissionProps).toMatchObject({
      value: "yolo",
    });
    expect(captured.tooltipProps).toMatchObject({ shortcut: "Ctrl+Shift+M" });
  });

  it("已有 session 修改模式后显示 Composer 值，不回读旧 snapshot", () => {
    renderModeSwitch({ mode: "edit" });

    expect(captured.permissionProps).toMatchObject({
      value: "edit",
    });
  });

  it("已有 session 没有 snapshot config 时仍显示 Composer 模式", () => {
    renderModeSwitch({ mode: "yolo" });

    expect(captured.permissionProps).toMatchObject({
      value: "yolo",
    });
  });

  it("Plan 勾选独立于权限，菜单通过已有草稿回调切换", () => {
    const onSwitchMode = vi.fn();
    const html = renderModeSwitch(
      { mode: "yolo", planEnabled: true },
      { activeConfigPicker: "mode", onSwitchMode },
    );
    expect(captured.permissionProps?.value).toBe("yolo");
    expect(captured.planProps?.checked).toBe(true);
    expect(
      renderToStaticMarkup(createElement("div", null, captured.planProps?.children as ReactNode)),
    ).toContain("mode.description.glm.plan");
    expect(html).toContain('data-testid="v4-composer-plan-marker"');
    const onCheckedChange = captured.planProps!.onCheckedChange as (checked: boolean) => void;
    onCheckedChange(false);
    expect(onSwitchMode).toHaveBeenNthCalledWith(1, "plan-off");
    onCheckedChange(true);
    expect(onSwitchMode).toHaveBeenNthCalledWith(2, "plan");
    expect(onSwitchMode).toHaveBeenCalledTimes(2);
  });

  it("Beta 是独立模式单选入口：极简入口已移除，触发按钮直接显示 Beta 标签", () => {
    const html = renderModeSwitch({ mode: "beta" });
    const values = captured.permissionItems.map((item) => String(item.value));
    expect(values).toContain("beta");
    expect(values).not.toContain("minimal");
    expect(captured.permissionProps?.value).toBe("beta");
    // 不再渲染上下文档位徽标。
    expect(html).not.toContain("v4-composer-context-profile-marker");
    expect(html).toContain("mode.label.glm.beta");
    // Beta 权限为完全访问，触发按钮与 yolo 同警示色。
    expect(html).toContain("text-warning");
  });

  it("选择其他工作模式即退出 Beta：RadioGroup 回调直接发模式值", () => {
    const onSwitchMode = vi.fn();
    renderModeSwitch({ mode: "beta" }, { activeConfigPicker: "mode", onSwitchMode });
    const buildItem = captured.permissionItems.find((item) => item.value === "build")!;
    expect(buildItem).toBeDefined();
    const fire = captured.permissionProps?.onValueChange as (value: string) => void;
    fire("build");
    expect(onSwitchMode).toHaveBeenCalledWith("build");
  });

  it("旧 build+fusion 历史草稿保留 build 显示，不自动升级为 Beta", () => {
    const html = renderModeSwitch({ mode: "build", contextProfile: "fusion" });
    expect(captured.permissionProps?.value).toBe("build");
    expect(html).toContain("mode.label.glm.build");
    expect(html).not.toContain("v4-composer-context-profile-marker");
  });

  it("非 Beta 权限与 fusion 的历史组合保持原语义，不自动改写权限", () => {
    const html = renderModeSwitch({ mode: "guarded", contextProfile: "fusion" });
    expect(captured.permissionProps?.value).toBe("guarded");
    expect(html).toContain("mode.label.glm.guarded");
  });

  it("极简入口已移除：历史 minimal 草稿仅回显，不再作为可选模式", () => {
    const html = renderModeSwitch({ mode: "minimal" });
    const values = captured.permissionItems.map((item) => String(item.value));
    expect(values).not.toContain("minimal");
    expect(captured.permissionProps?.value).toBe("minimal");
    // 历史 minimal 回显仍带警示色（完全访问类权限）。
    expect(html).toContain("text-warning");
  });

  it("档位显示名回归：真实 zh-CN 文案渲染为「Beta 模式」，描述标注测试版本与完全访问权限", () => {
    // 本文件把 formatMessage 桩成回显 key，显示名回归只能在这里断言真实字符串：
    // 若有人把 zh-CN 的 label 改回旧值，此用例直接失败。
    const html = renderModeSwitch({ mode: "beta" });
    expect(zhCN["mode.label.glm.beta"]).toBe("Beta 模式");
    expect(zhCN["mode.description.glm.beta"]).toContain("提示词融合模式测试版本");
    expect(zhCN["mode.description.glm.beta"]).toContain("完全访问");
    expect(enUS["mode.label.glm.beta"]).toBe("Beta mode");
    expect(enUS["mode.description.glm.beta"]).toContain("Prompt-fusion mode test version");
    expect(enUS["mode.description.glm.beta"].toLowerCase()).toContain("full-access");
    // key 桩下的 HTML 仍含模式 key；真实显示值由上面几条 message 断言锁定。
    expect(html).toContain("mode.label.glm.beta");
  });

  it("不再渲染普通/极简/融合上下文三态与档位徽标", () => {
    const html = renderModeSwitch({ mode: "build", contextProfile: "standard" });
    expect(html).not.toContain("standard-context");
    expect(html).not.toContain("minimal-context");
    expect(html).not.toContain("fusion-context");
    expect(html).not.toContain("chat.toolbar.mode.standardContext.label");
    expect(html).not.toContain("v4-composer-context-profile-marker");
    expect(
      captured.permissionItems.every((item) => !String(item["data-testid"]).endsWith("-context")),
    ).toBe(true);
  });

  it("缺省草稿按 build 显示且无档位徽标", () => {
    const html = renderModeSwitch({ mode: "build" });
    expect(captured.permissionProps?.value).toBe("build");
    expect(html).not.toContain("v4-composer-context-profile-marker");
  });
});
