import { useState } from "react";
import type { AppSettings, PromptOptimizerContextRange, PromptOptimizerMode } from "@zcode/shared";
import { PROMPT_OPTIMIZER_CONTEXT_RANGES, PROMPT_OPTIMIZER_MODES } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { AiFeatureModelSetting } from "./AiFeatureModelSetting.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

const PROMPT_OPTIMIZER_MODE_LABEL_KEYS: Record<PromptOptimizerMode, string> = {
  polish: "chat.composer.optimizeModePolish",
  structure: "chat.composer.optimizeModeStructure",
};

const PROMPT_OPTIMIZER_CONTEXT_LABEL_KEYS: Record<PromptOptimizerContextRange, string> = {
  draft: "chat.composer.optimizeContextDraft",
  conversation: "chat.composer.optimizeContextConversation",
};

function useAiFeatureSettings() {
  const { intl } = useZCodeIntl();
  // 设置页可能渲染在远端 workspace 的 ServiceProvider 下；AI 偏好属于本机 Host，
  // 必须显式绑定 base services，不能写入当前远端会话的设置。
  const services = useBaseWorkspaceServices();
  const { settings, update } = useSettings({ services });
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<AppSettings>) => {
    setSaving(true);
    try {
      await update(patch);
    } catch (error) {
      logger.warn("[settings] 保存 AI 功能偏好失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.aiFeature.saveError" }));
    } finally {
      setSaving(false);
    }
  };
  return { intl, settings, saving, save };
}

/**
 * 提示词优化的全局配置：模型、优化方式、上下文范围。
 * 输入栏的 ✨ 只保留动作，不再承载配置下拉。
 */
export function PromptOptimizerSetting() {
  const { settings, intl, saving, save } = useAiFeatureSettings();
  const disabled = !settings || saving;
  const mode = settings?.promptOptimizerMode ?? "polish";
  const contextRange = settings?.promptOptimizerContextRange ?? "conversation";

  return (
    <>
      <AiFeatureModelSetting
        label={intl.formatMessage({ id: "settings.promptOptimizer.model" })}
        description={intl.formatMessage({ id: "settings.promptOptimizer.modelDescription" })}
        value={settings?.promptOptimizerModel}
        onChange={(selection) => save({ promptOptimizerModel: selection })}
        followLabel={intl.formatMessage({ id: "settings.aiFeature.followSession" })}
        defaultLevelLabel={intl.formatMessage({ id: "settings.aiFeature.reasoningDefault" })}
        levelLabel={intl.formatMessage({ id: "settings.aiFeature.reasoningLevel" })}
        levelPolicy="lowest"
        disabled={disabled}
        testIdPrefix="settings-prompt-optimizer"
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.promptOptimizer.mode" })}
        description={intl.formatMessage({ id: "settings.promptOptimizer.modeDescription" })}
        controlLayout="wide"
        control={
          <Select
            value={mode}
            onValueChange={(value) =>
              void save({ promptOptimizerMode: value as PromptOptimizerMode })
            }
            disabled={disabled}
          >
            <SelectTrigger
              size="lg"
              className="w-[280px] min-w-0 justify-between"
              aria-label={intl.formatMessage({ id: "settings.promptOptimizer.mode" })}
              data-testid="settings-prompt-optimizer-mode-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end" sideOffset={4}>
              {PROMPT_OPTIMIZER_MODES.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  data-testid={`settings-prompt-optimizer-mode-${option}`}
                >
                  {intl.formatMessage({ id: PROMPT_OPTIMIZER_MODE_LABEL_KEYS[option] })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.promptOptimizer.context" })}
        description={intl.formatMessage({ id: "settings.promptOptimizer.contextDescription" })}
        controlLayout="wide"
        control={
          <Select
            value={contextRange}
            onValueChange={(value) =>
              void save({ promptOptimizerContextRange: value as PromptOptimizerContextRange })
            }
            disabled={disabled}
          >
            <SelectTrigger
              size="lg"
              className="w-[280px] min-w-0 justify-between"
              aria-label={intl.formatMessage({ id: "settings.promptOptimizer.context" })}
              data-testid="settings-prompt-optimizer-context-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end" sideOffset={4}>
              {PROMPT_OPTIMIZER_CONTEXT_RANGES.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  data-testid={`settings-prompt-optimizer-context-${option}`}
                >
                  {intl.formatMessage({ id: PROMPT_OPTIMIZER_CONTEXT_LABEL_KEYS[option] })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </>
  );
}

/** Oracle 审查模型；自动审查与手动审查共用。 */
export function OracleReviewModelSetting() {
  const { settings, intl, saving, save } = useAiFeatureSettings();
  return (
    <AiFeatureModelSetting
      label={intl.formatMessage({ id: "settings.oracleReviewModel.label" })}
      description={intl.formatMessage({ id: "settings.oracleReviewModel.description" })}
      value={settings?.oracleReviewModel}
      onChange={(selection) => save({ oracleReviewModel: selection })}
      followLabel={intl.formatMessage({ id: "settings.aiFeature.followSession" })}
      defaultLevelLabel={intl.formatMessage({ id: "settings.aiFeature.reasoningDefault" })}
      levelLabel={intl.formatMessage({ id: "settings.aiFeature.reasoningLevel" })}
      levelPolicy="none"
      disabled={!settings || saving}
      testIdPrefix="settings-oracle-review"
    />
  );
}
