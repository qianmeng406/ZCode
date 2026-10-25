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
  AI_FEATURE_FOLLOW_MODEL_VALUE,
  buildAiFeatureModelChoice,
  buildAiFeatureModelGroups,
  buildAiFeatureSelection,
  findAiFeatureModel,
  formatAiFeatureModelValue,
  resolveAiFeatureDisplayLevel,
  type AiFeatureModelGroup,
} from "./aiFeatureModelOptions.js";

export interface AiFeatureModelSettingProps {
  label: string;
  description?: string;
  value: ModelSelection | null | undefined;
  onChange: (selection: ModelSelection | null) => void | Promise<void>;
  followLabel: string;
  levelLabel?: string;
  disabled?: boolean;
  testIdPrefix: string;
}

/**
 * 设置页的「模型 + 推理档位」两行控件。
 * 只负责展示与归一化，不直接写设置；由调用方决定落到哪个 AppSettings 字段。
 * 档位恒为显式值：选模型落盘最低公开档，下拉只列真实档位（无「默认档」哨兵项）；
 * 缺档/失效档在显示上回落最低档，与实际执行语义一致。
 */
export function AiFeatureModelSetting({
  label,
  description,
  value,
  onChange,
  followLabel,
  levelLabel,
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
  // 缺档/失效档显示回落最低档（与落盘/迁移/优化器同一解析规则），不留空选中态。
  const displayLevel = resolveAiFeatureDisplayLevel(selectedModel, selection) ?? "";

  const handleModelChange = (rawValue: string) => {
    if (rawValue === AI_FEATURE_FOLLOW_MODEL_VALUE) {
      void onChange(null);
      return;
    }
    const separator = rawValue.indexOf("/");
    if (separator <= 0 || separator >= rawValue.length - 1) return;
    const providerId = rawValue.slice(0, separator);
    const modelId = rawValue.slice(separator + 1);
    void onChange(buildAiFeatureModelChoice(groups, providerId, modelId));
  };

  const handleLevelChange = (rawValue: string) => {
    if (!selection) return;
    // 下拉只列目录内的真实档位，rawValue 即合法档位。
    void onChange(buildAiFeatureSelection(selection.providerId, selection.modelId, rawValue));
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
      {selection && levels.length > 0 && levelLabel ? (
        <SettingsRow
          label={levelLabel}
          controlLayout="wide"
          control={
            <Select value={displayLevel} onValueChange={handleLevelChange} disabled={disabled}>
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
