// 「定制功能」设置分区：fork 相对上游新增能力的集中页。
// 纯受控组件——所有值与 setter 经 props 注入（照 PerformanceSection 模式），
// 不读 store、不碰 localStorage；每个开关关闭时行为回到该功能引入之前。
import { ArrowRight, FlaskConical } from "lucide-react";
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

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
          <FlaskConical aria-hidden="true" className="size-4 text-foreground-subtle" />
          {text("settings.forkFeatures.title")}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {text("settings.forkFeatures.description")}
        </p>
      </div>

      <SettingsGroupCard>
        <h4 className="text-ui-base font-medium text-foreground">
          {text("settings.forkFeatures.group.reviewAndPrompt")}
        </h4>
        <SettingsRow
          label={text("settings.oracleReview")}
          description={text("settings.oracleReviewDescription")}
          control={
            <Switch
              aria-label={text("settings.oracleReview")}
              checked={oracleReviewEnabled}
              onCheckedChange={(checked) => {
                onOracleReviewEnabledChange(checked);
              }}
            />
          }
        />
        <OracleReviewModelSetting />
        <SettingsRow
          label={text("settings.forkFeatures.promptOptimizer")}
          description={text("settings.forkFeatures.promptOptimizerDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.promptOptimizer")}
              checked={promptOptimizerEnabled}
              onCheckedChange={(checked) => {
                onPromptOptimizerEnabledChange(checked);
              }}
            />
          }
        />
        <PromptOptimizerSetting />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <h4 className="text-ui-base font-medium text-foreground">
          {text("settings.forkFeatures.group.tools")}
        </h4>
        {/* 动态工作流由自身在服务端未提供时返回 null，这里不需要额外门。 */}
        <DynamicWorkflowModeSetting />
        <SettingsRow
          label={text("settings.forkFeatures.monitorTool")}
          description={text("settings.forkFeatures.monitorToolDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.monitorTool")}
              checked={monitorToolEnabled}
              onCheckedChange={(checked) => {
                onMonitorToolEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={text("settings.forkFeatures.notebookEdit")}
          description={text("settings.forkFeatures.notebookEditDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.notebookEdit")}
              checked={notebookEditEnabled}
              onCheckedChange={(checked) => {
                onNotebookEditEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={text("settings.forkFeatures.applyPatch")}
          description={text("settings.forkFeatures.applyPatchDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.applyPatch")}
              checked={applyPatchEnabled}
              onCheckedChange={(checked) => {
                onApplyPatchEnabledChange(checked);
              }}
            />
          }
        />
        <p className="px-0 pt-1 text-ui-sm leading-5 text-foreground-subtle">
          {text("settings.forkFeatures.toolsApplyImmediately")}
        </p>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <h4 className="text-ui-base font-medium text-foreground">
          {text("settings.forkFeatures.group.memory")}
        </h4>
        {memoryEnabled ? null : (
          <p className="text-ui-sm leading-5 text-foreground-subtle">
            {text("settings.forkFeatures.memoryDisabledHint")}
          </p>
        )}
        <SettingsRow
          label={text("settings.forkFeatures.memoryFileEditing")}
          description={text("settings.forkFeatures.memoryFileEditingDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.memoryFileEditing")}
              checked={memoryFileEditingEnabled}
              disabled={memorySwitchDisabled}
              onCheckedChange={(checked) => {
                onMemoryFileEditingEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={text("settings.forkFeatures.memoryCapture")}
          description={text("settings.forkFeatures.memoryCaptureDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.memoryCapture")}
              checked={memoryCaptureEnabled}
              disabled={memorySwitchDisabled}
              onCheckedChange={(checked) => {
                onMemoryCaptureEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={text("settings.forkFeatures.memoryDreamManual")}
          description={text("settings.forkFeatures.memoryDreamManualDescription")}
          control={
            <Switch
              aria-label={text("settings.forkFeatures.memoryDreamManual")}
              checked={memoryDreamManualEnabled}
              disabled={memorySwitchDisabled}
              onCheckedChange={(checked) => {
                onMemoryDreamManualEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={text("settings.forkFeatures.performanceLink")}
          description={text("settings.forkFeatures.performanceLinkDescription")}
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
