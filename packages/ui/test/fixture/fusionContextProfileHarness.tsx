// 约束：仅 UI 验收 harness，不接入 prod 应用状态/服务；菜单与 locale/主题走生产实现，
// 局部 state 只模拟草稿配置与 picker 开合（Escape/外点可关）。
import { StrictMode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ContextProfile } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
// 主题复用生产 useTheme：applyTheme 在 documentElement 上切 Zai Light/Zai Dark tokens。
import { useTheme } from "@/useTheme.js";
import { Button } from "@/components/ui/button.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import "@/styles.css";

const noop = () => {};

// 组件树只需 useSettings()（快捷键表）与 platform.onSettingsChanged 存在；
// 其余服务不被 mode 控件触达，不给假实现，避免 harness 意外调用真实服务面。
const stubServices = {
  settingService: {
    get: async () => ({}),
    update: async () => ({}),
  },
  broadcastService: { send: noop, onMessage: () => () => {} },
  botsService: {},
  zcodeAgentService: {},
} as unknown as IServiceAccessor;

const stubPlatform = {
  onSettingsChanged: () => () => {},
} as unknown as IPlatformService;

// 验收常用草稿场景：新任务默认态、Beta 激活、历史 build+fusion、旧极简组合、计划开启。
const DRAFT_PRESETS: Record<
  string,
  Partial<{ mode: string; planEnabled: boolean; contextProfile: ContextProfile }>
> = {
  default: { mode: "build", planEnabled: false, contextProfile: "standard" },
  beta: { mode: "beta", planEnabled: false, contextProfile: "standard" },
  "beta-plan": { mode: "beta", planEnabled: true, contextProfile: "standard" },
  "legacy-build-fusion": { mode: "build", planEnabled: false, contextProfile: "fusion" },
  "legacy-minimal": { mode: "minimal", planEnabled: false, contextProfile: "minimal" },
  "guarded-fusion": { mode: "guarded", planEnabled: false, contextProfile: "fusion" },
};

function Harness() {
  const { locale, setLocale } = useZCodeIntl();
  // 生产主题机制：useTheme 把 zai-dark/zai-light 应用到 documentElement tokens。
  const { theme, setTheme } = useTheme();
  const [composerCompact, setComposerCompact] = useState(false);
  // 与生产同语义的局部排他 picker owner：null = 全收起，Escape/外点可关。
  const [activeConfigPicker, setActiveConfigPicker] = useState<"mode" | null>("mode");
  const [draftConfig, setDraftConfig] = useState(DRAFT_PRESETS.default);
  const [submitLog, setSubmitLog] = useState<string[]>([]);
  // 约束：compact 标记必须落在生产收起控件（data-composer-collapse-priority="1"，
  // 即 mode 控件）上，与 useComposerToolbarFit 的布局投影一致；wrapper 上的标记
  // 不影响生产 CSS 选择器，只会让截图仍显示完整 label。
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const control = toolbarRef.current?.querySelector<HTMLElement>(
      '[data-composer-collapse-priority="1"]',
    );
    if (!control) return;
    if (composerCompact) control.dataset.composerCompact = "true";
    else delete control.dataset.composerCompact;
  }, [composerCompact]);

  const record = useCallback((label: string) => {
    setSubmitLog((log) => [...log.slice(-9), label]);
  }, []);

  const handleSwitchMode = useCallback((mode: string) => {
    record(`onSwitchMode:${mode}`);
    setDraftConfig((current) => {
      if (mode === "plan") return { ...current, planEnabled: true };
      if (mode === "plan-off") return { ...current, planEnabled: false };
      // 与生产 useDraftConfigControl 同语义：显式选非 Beta 即清除遗留融合档位；
      // 选 Beta 保持档位不变（新 UI 不再写 contextProfile=fusion）。
      const contextProfile = mode === "beta" ? current.contextProfile : undefined;
      return { ...current, mode, contextProfile };
    });
  }, []);

  return (
    <div data-harness-root="true" className="min-h-screen bg-background p-6 text-foreground">
      <div
        data-harness-theme={theme}
        data-harness-locale={locale}
        className="mx-auto max-w-3xl rounded-xl border border-border bg-background p-4 text-foreground"
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="harness-locale-toggle"
            onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
          >
            locale: {locale}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="harness-theme-toggle"
            onClick={() => setTheme(theme === "zai-dark" ? "zai-light" : "zai-dark")}
          >
            theme: {theme}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="harness-compact-toggle"
            onClick={() => setComposerCompact(!composerCompact)}
          >
            compact: {String(composerCompact)}
          </Button>
          {Object.keys(DRAFT_PRESETS).map((preset) => (
            <Button
              key={preset}
              variant="outline"
              size="sm"
              data-testid={`harness-preset-${preset}`}
              onClick={() => setDraftConfig(DRAFT_PRESETS[preset])}
            >
              {preset}
            </Button>
          ))}
        </div>
        <div
          data-testid="harness-toolbar"
          ref={toolbarRef}
          data-harness-mode={draftConfig.mode ?? ""}
          data-harness-plan={String(draftConfig.planEnabled ?? false)}
          data-harness-profile={draftConfig.contextProfile ?? "standard"}
          className="flex w-[560px] max-w-full items-center gap-2 rounded-xl border border-border bg-surface p-2"
        >
          <V4ComposerModeSwitch
            workspacePath="/harness-workspace"
            provider="glm"
            draftConfig={draftConfig}
            disabled={false}
            activeConfigPicker={activeConfigPicker}
            onConfigPickerOpenChange={(picker, open) => setActiveConfigPicker(open ? picker : null)}
            onSwitchMode={handleSwitchMode}
          />
        </div>
        <div className="mt-4">
          <div className="mb-1 text-sm">回调日志（模拟提交捕获）：</div>
          <ul data-testid="harness-callback-log" className="max-h-40 overflow-auto text-sm">
            {submitLog.map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById("root")!;

// 验收排错：不用延迟掩盖，任何模块级/React 渲染异常直接以真实文本渲染到页面。
function showFatal(message: string) {
  const pre = document.createElement("pre");
  pre.setAttribute("data-harness-fatal", "true");
  pre.style.cssText = "color:#f87171;padding:16px;white-space:pre-wrap;font-size:12px";
  pre.textContent = message;
  container.replaceChildren(pre);
}
window.addEventListener("error", (event) => {
  showFatal(`window.error: ${event.message}\n${event.error?.stack ?? ""}`);
});
window.addEventListener("unhandledrejection", (event) => {
  showFatal(`unhandledrejection: ${String(event.reason)}`);
});

try {
  createRoot(container).render(
    <StrictMode>
      <PlatformProvider platform={stubPlatform}>
        <ServiceProvider services={stubServices}>
          <ZCodeIntlProvider initialLocale="zh-CN">
            <TooltipProvider>
              <Harness />
            </TooltipProvider>
          </ZCodeIntlProvider>
        </ServiceProvider>
      </PlatformProvider>
    </StrictMode>,
  );
} catch (error) {
  showFatal(`render error: ${error instanceof Error ? error.stack : String(error)}`);
}
