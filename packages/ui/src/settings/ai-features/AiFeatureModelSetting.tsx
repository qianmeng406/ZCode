import { useMemo } from "react";
import type { ModelSelection } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  AI_FEATURE_DEFAULT_LEVEL_VALUE,
  AI_FEATURE_FOLLOW_MODEL_VALUE,
  buildAiFeatureModelGroups,
  buildAiFeatureSelection,
  findAiFeatureModel,
  formatAiFeatureModelValue,
  type AiFeatureModelGroup,
  type AiFeatureReasoningLevelPolicy,
} from "./aiFeatureModelOptions.js";

export interface AiFeatureModelSettingProps {
  label: string;
  description?: string;
  value: ModelSelection | null | undefined;
  onChange: (selection: ModelSelection | null) => void | Promise<void>;
  followLabel: string;
  defaultLevelLabel?: string;
  levelLabel?: string;
  /** lowest = 选中模型时带最低公开档（提示词优化）；none = 保持模型默认档（审查）。 */
  levelPolicy?: AiFeatureReasoningLevelPolicy;
  disabled?: boolean;
  testIdPrefix: string;
}

/**
 * 设置页的「模型 + 推理档位」两行控件。
 * 只负责展示与归一化，不直接写设置；由调用方决定落到哪个 AppSettings 字段。
 */
export function AiFeatureModelSetting({
  label,
  description,
  value,
  onChange,
  followLabel,
  defaultLevelLabel,
  levelLabel,
  levelPolicy = "none",
  disabled,
  testIdPrefix,
}: AiFeatureModelSettingProps) {
  const services = useBaseWorkspaceServices();
  const read = useModelSelectionServiceView(services.modelSelectionService, true);
  const view = read.state.status === "ready" ? read.state.view : null;
  const groups = useMemo(() => buildAiFeatureModelGroups(view), [view]);
  const selection = value ?? null;
  const selectedModel = findAiFeatureModel(groups, selection);
  const selectedModelMissing = Boolean(selection && !selectedModel);
  // 已下线/换提供方的历史选择仍要能显示出来，否则 Select 会变成空占位。
  const displayGroups = useMemo<readonly AiFeatureModelGroup[]>(() => {
    if (!selection || !selectedModelMissing) return groups;
    return [
      {
        providerId: selection.providerId,
        label: selection.providerId,
        models: [{ modelId: selection.modelId, levels: [] }],
      },
      ...groups,
    ];
  }, [groups, selectedModelMissing, selection]);
  const levels = selectedModel?.levels ?? [];
  const currentLevel = selection?.options?.reasoningLevel ?? "";

  const handleModelChange = (rawValue: string) => {
    if (rawValue === AI_FEATURE_FOLLOW_MODEL_VALUE) {
      void onChange(null);
      return;
    }
    const separator = rawValue.indexOf("/");
    if (separator <= 0 || separator >= rawValue.length - 1) return;
    const providerId = rawValue.slice(0, separator);
    const modelId = rawValue.slice(separator + 1);
    const model = findAiFeatureModel(groups, { providerId, modelId });
    const reasoningLevel = levelPolicy === "lowest" ? model?.levels[0] : undefined;
    void onChange(buildAiFeatureSelection(providerId, modelId, reasoningLevel));
  };

  const handleLevelChange = (rawValue: string) => {
    if (!selection) return;
    const reasoningLevel = rawValue === AI_FEATURE_DEFAULT_LEVEL_VALUE ? undefined : rawValue;
    void onChange(buildAiFeatureSelection(selection.providerId, selection.modelId, reasoningLevel));
  };

  return (
    <>
      <SettingsRow
        label={label}
        description={description}
        controlLayout="wide"
        control={
          <Select
            value={formatAiFeatureModelValue(selection)}
            onValueChange={handleModelChange}
            disabled={disabled || read.state.status !== "ready"}
          >
            <SelectTrigger
              size="lg"
              className="w-[280px] min-w-0 justify-between"
              aria-label={label}
              data-testid={`${testIdPrefix}-model-trigger`}
            >
              <SelectValue placeholder={followLabel} />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="end"
              sideOffset={4}
              className="max-h-72 w-(--radix-select-trigger-width) overflow-y-auto"
            >
              <SelectItem
                value={AI_FEATURE_FOLLOW_MODEL_VALUE}
                data-testid={`${testIdPrefix}-model-follow`}
              >
                {followLabel}
              </SelectItem>
              {displayGroups.map((group) => (
                <SelectGroup key={group.providerId}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.models.map((model) => (
                    <SelectItem
                      key={`${group.providerId}/${model.modelId}`}
                      value={`${group.providerId}/${model.modelId}`}
                      data-testid={`${testIdPrefix}-model-${group.providerId}-${model.modelId}`}
                    >
                      {model.modelId}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {selection && levels.length > 0 && levelLabel && defaultLevelLabel ? (
        <SettingsRow
          label={levelLabel}
          controlLayout="wide"
          control={
            <Select
              value={currentLevel || AI_FEATURE_DEFAULT_LEVEL_VALUE}
              onValueChange={handleLevelChange}
              disabled={disabled}
            >
              <SelectTrigger
                size="lg"
                className="w-[280px] min-w-0 justify-between"
                aria-label={levelLabel}
                data-testid={`${testIdPrefix}-level-trigger`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                align="end"
                sideOffset={4}
                className="w-(--radix-select-trigger-width)"
              >
                <SelectItem
                  value={AI_FEATURE_DEFAULT_LEVEL_VALUE}
                  data-testid={`${testIdPrefix}-level-default`}
                >
                  {defaultLevelLabel}
                </SelectItem>
                {levels.map((level) => (
                  <SelectItem
                    key={level}
                    value={level}
                    data-testid={`${testIdPrefix}-level-${level}`}
                  >
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
    </>
  );
}
