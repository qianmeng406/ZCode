// 「定制功能」设置分区：fork 相对上游新增能力的集中页。
// 纯受控组件——所有值与 setter 经 props 注入（照 PerformanceSection 模式），
// 不读 store；只有「首访提示已读」这一项落在 localStorage，且只经导出函数访问。
import { ArrowRight } from "lucide-react";
import type { ForkFeatureKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { OracleReviewModelSetting, PromptOptimizerSetting } from "@/settings/ai-features/index.js";

/**
 * 推荐组合：把「不知道从哪开」变成一次点击。
 * 只包含默认关闭的开关——promptOptimizer 本来默认开，放进组合里没有语义。
 */
export type ForkFeaturePresetId = "tools" | "memory";

export const FORK_FEATURE_PRESETS: Record<ForkFeaturePresetId, readonly ForkFeatureKey[]> = {
  tools: ["monitorTool", "notebookEdit", "applyPatch"],
  memory: ["memoryFileEditing", "memoryCapture", "memoryDreamManual"],
};

const FORK_FEATURES_NOTICE_STORAGE_KEY = "zcode:fork-features:notice-dismissed";

/** 首次进入「定制功能」页时给出一次说明；用户点掉后不再出现。 */
export function readForkFeaturesNoticeDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FORK_FEATURES_NOTICE_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式/禁用存储时按「已读」处理：宁可少提示一次，也不要在每次渲染时重试。
    return true;
  }
}

export function dismissForkFeaturesNotice(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FORK_FEATURES_NOTICE_STORAGE_KEY, "1");
  } catch {
    // 写不进去不影响当前会话：调用方同时更新内存态。
  }
}

export interface ForkFeaturesSectionContentProps {
  oracleReviewEnabled: boolean;
  onOracleReviewEnabledChange: (enabled: boolean) => void;
  promptOptimizerEnabled: boolean;
  onPromptOptimizerEnabledChange: (enabled: boolean) => void;
  monitorToolEnabled: boolean;
  onMonitorToolEnabledChange: (enabled: boolean) => void;
  notebookEditEnabled: boolean;
  onNotebookEditEnabledChange: (enabled: boolean) => void;
  applyPatchEnabled: boolean;
  onApplyPatchEnabledChange: (enabled: boolean) => void;
  memoryFileEditingEnabled: boolean;
  onMemoryFileEditingEnabledChange: (enabled: boolean) => void;
  memoryCaptureEnabled: boolean;
  onMemoryCaptureEnabledChange: (enabled: boolean) => void;
  memoryDreamManualEnabled: boolean;
  onMemoryDreamManualEnabledChange: (enabled: boolean) => void;
  /** 一次打开整组开关；值的提交仍在父组件里统一走设置服务。 */
  onApplyPreset: (preset: ForkFeaturePresetId) => void;
  /** 首访提示是否显示（父组件持有已读状态，避免本组件变成有状态组件）。 */
  showNotice: boolean;
  onDismissNotice: () => void;
  /** 记忆总开关：关闭时记忆相关的三行置灰，避免用户开了开关却看不到任何入口。 */
  memoryEnabled: boolean;
}

export function ForkFeaturesSectionContent({
  oracleReviewEnabled,
  onOracleReviewEnabledChange,
  promptOptimizerEnabled,
  onPromptOptimizerEnabledChange,
  monitorToolEnabled,
  onMonitorToolEnabledChange,
  notebookEditEnabled,
  onNotebookEditEnabledChange,
  applyPatchEnabled,
  onApplyPatchEnabledChange,
  memoryFileEditingEnabled,
  onMemoryFileEditingEnabledChange,
  memoryCaptureEnabled,
  onMemoryCaptureEnabledChange,
  memoryDreamManualEnabled,
  onMemoryDreamManualEnabledChange,
  onApplyPreset,
  showNotice,
  onDismissNotice,
  memoryEnabled,
}: ForkFeaturesSectionContentProps) {
  const { intl } = useZCodeIntl();
  const text = (id: string) => intl.formatMessage({ id });
  const memorySwitchDisabled = !memoryEnabled;
  const toolsPresetApplied = monitorToolEnabled && notebookEditEnabled && applyPatchEnabled;
  const memoryPresetApplied =
    memoryFileEditingEnabled && memoryCaptureEnabled && memoryDreamManualEnabled;

  const experimentalLabel = (labelId: string) => (
    <span className="flex items-center gap-2">
      {text(labelId)}
      <span className="rounded bg-amber-500/12 px-1.5 py-0.5 text-ui-xs font-normal text-amber-700 dark:text-amber-400">
        {text("settings.forkFeatures.experimentalBadge")}
      </span>
    </span>
  );

  // 说明文字多为长句，窄设置窗口下固定控件列会把每行挤成十几个字，这里统一让开关贴标题行右端。
  const switchRow = (
    labelId: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    options: { disabled?: boolean; experimental?: boolean } = {},
  ) => (
    <SettingsRow
      label={options.experimental === false ? text(labelId) : experimentalLabel(labelId)}
      description={text(`${labelId}Description`)}
      controlPlacement="title"
      control={
        <Switch
          aria-label={text(labelId)}
          checked={checked}
          disabled={options.disabled === true}
          onCheckedChange={(next) => {
            onChange(next);
          }}
        />
      }
    />
  );

  const presetRow = (preset: ForkFeaturePresetId, applied: boolean, disabled: boolean) => (
    <SettingsRow
      label={text(`settings.forkFeatures.preset.${preset}`)}
      description={text(`settings.forkFeatures.preset.${preset}Description`)}
      controlPlacement="title"
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={applied || disabled}
          onClick={() => {
            onApplyPreset(preset);
          }}
        >
          {applied
            ? text("settings.forkFeatures.preset.applied")
            : text("settings.forkFeatures.preset.apply")}
        </Button>
      }
    />
  );

  return (
    <div className="min-w-0 space-y-4">
      {/* 页面标题由 SettingsPage 公共页头渲染，这里只放分区说明，避免「定制功能」出现两次。 */}
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {text("settings.forkFeatures.description")}
      </p>

      {showNotice ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/60 px-4 py-3">
          <div className="min-w-0 space-y-1">
            <p className="text-ui-base font-medium text-foreground">
              {text("settings.forkFeatures.noticeTitle")}
            </p>
            <p className="text-ui-sm leading-5 text-foreground-subtle">
              {text("settings.forkFeatures.noticeBody")}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onDismissNotice}>
            {text("settings.forkFeatures.noticeDismiss")}
          </Button>
        </div>
      ) : null}

      <SettingsGroupCard title={text("settings.forkFeatures.group.presets")}>
        {presetRow("tools", toolsPresetApplied, false)}
        {presetRow("memory", memoryPresetApplied, memorySwitchDisabled)}
      </SettingsGroupCard>

      <SettingsGroupCard title={text("settings.forkFeatures.group.reviewAndPrompt")}>
        {switchRow("settings.oracleReview", oracleReviewEnabled, onOracleReviewEnabledChange, {
          experimental: false,
        })}
        <OracleReviewModelSetting />
        {switchRow(
          "settings.forkFeatures.promptOptimizer",
          promptOptimizerEnabled,
          onPromptOptimizerEnabledChange,
          { experimental: false },
        )}
        <PromptOptimizerSetting />
      </SettingsGroupCard>

      <SettingsGroupCard title={text("settings.forkFeatures.group.tools")}>
        {/* 动态工作流由自身在服务端未提供时返回 null，这里不需要额外门。 */}
        <DynamicWorkflowModeSetting />
        {switchRow(
          "settings.forkFeatures.monitorTool",
          monitorToolEnabled,
          onMonitorToolEnabledChange,
        )}
        {switchRow(
          "settings.forkFeatures.notebookEdit",
          notebookEditEnabled,
          onNotebookEditEnabledChange,
        )}
        {switchRow(
          "settings.forkFeatures.applyPatch",
          applyPatchEnabled,
          onApplyPatchEnabledChange,
        )}
        <p className="mx-4 my-3 rounded-lg bg-surface/60 px-3 py-2 text-ui-sm leading-5 text-foreground-subtle">
          {text("settings.forkFeatures.toolsApplyImmediately")}
        </p>
      </SettingsGroupCard>

      <SettingsGroupCard title={text("settings.forkFeatures.group.memory")}>
        {memoryEnabled ? null : (
          <p className="mx-4 mt-3 rounded-lg bg-surface/60 px-3 py-2 text-ui-sm leading-5 text-foreground-subtle">
            {text("settings.forkFeatures.memoryDisabledHint")}
          </p>
        )}
        {switchRow(
          "settings.forkFeatures.memoryFileEditing",
          memoryFileEditingEnabled,
          onMemoryFileEditingEnabledChange,
          { disabled: memorySwitchDisabled },
        )}
        {switchRow(
          "settings.forkFeatures.memoryCapture",
          memoryCaptureEnabled,
          onMemoryCaptureEnabledChange,
          { disabled: memorySwitchDisabled },
        )}
        {switchRow(
          "settings.forkFeatures.memoryDreamManual",
          memoryDreamManualEnabled,
          onMemoryDreamManualEnabledChange,
          { disabled: memorySwitchDisabled },
        )}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={text("settings.forkFeatures.performanceLink")}
          description={text("settings.forkFeatures.performanceLinkDescription")}
          controlPlacement="title"
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingSettingsSection("performance");
              }}
            >
              {text("settings.forkFeatures.performanceLinkAction")}
              <ArrowRight aria-hidden="true" className="ml-1 size-3.5" />
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}
