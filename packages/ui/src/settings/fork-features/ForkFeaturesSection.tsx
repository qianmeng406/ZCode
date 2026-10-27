// 「定制功能」设置分区：fork 相对上游新增能力的集中页。
// 纯受控组件——所有值与 setter 经 props 注入（照 PerformanceSection 模式），
// 不读 store、不碰 localStorage；每个开关关闭时行为回到该功能引入之前。
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { OracleReviewModelSetting, PromptOptimizerSetting } from "@/settings/ai-features/index.js";

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
  memoryEnabled,
}: ForkFeaturesSectionContentProps) {
  const { intl } = useZCodeIntl();
  const text = (id: string) => intl.formatMessage({ id });
  const memorySwitchDisabled = !memoryEnabled;
  // 说明文字多为长句，窄设置窗口下固定控件列会把每行挤成十几个字，这里统一让开关贴标题行右端。
  const switchRow = (
    labelId: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    disabled = false,
  ) => (
    <SettingsRow
      label={text(labelId)}
      description={text(`${labelId}Description`)}
      controlPlacement="title"
      control={
        <Switch
          aria-label={text(labelId)}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => {
            onChange(next);
          }}
        />
      }
    />
  );

  return (
    <div className="min-w-0 space-y-4">
      {/* 页面标题由 SettingsPage 公共页头渲染，这里只放分区说明，避免「定制功能」出现两次。 */}
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {text("settings.forkFeatures.description")}
      </p>

      <SettingsGroupCard title={text("settings.forkFeatures.group.reviewAndPrompt")}>
        {switchRow("settings.oracleReview", oracleReviewEnabled, onOracleReviewEnabledChange)}
        <OracleReviewModelSetting />
        {switchRow(
          "settings.forkFeatures.promptOptimizer",
          promptOptimizerEnabled,
          onPromptOptimizerEnabledChange,
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
          memorySwitchDisabled,
        )}
        {switchRow(
          "settings.forkFeatures.memoryCapture",
          memoryCaptureEnabled,
          onMemoryCaptureEnabledChange,
          memorySwitchDisabled,
        )}
        {switchRow(
          "settings.forkFeatures.memoryDreamManual",
          memoryDreamManualEnabled,
          onMemoryDreamManualEnabledChange,
          memorySwitchDisabled,
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
