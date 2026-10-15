import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
  contextProfileSchema,
  getZCodeAgentAvailableModes,
  testId,
  type ContextProfile,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/** Plan 与「上下文档位」（普通/极简/融合互斥）是正交选择；权限仍为单选；只编辑草稿，不向 Runtime 发切换命令。 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
  onSwitchContextProfile,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
  | "onSwitchContextProfile"
>) {
  const { intl } = useZCodeIntl();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  const permissions = modes.filter((mode) => mode.id !== "plan");
  // 新 UI 不再产生旧 mode=minimal（组合语义）：极简上下文由独立开关表达。
  // 仅当草稿仍处于旧极简时保留该选项以显示兼容状态；改选普通权限后不再出现。
  const selectablePermissions = permissions.filter(
    (mode) => mode.id !== "minimal" || draftConfig?.mode === "minimal",
  );
  // 新菜单隐藏 Edit，但历史草稿仍可回显，不能因候选变化隐藏整个权限入口。
  const selected =
    selectablePermissions.find((mode) => mode.id === draftConfig?.mode) ??
    (draftConfig?.mode === "edit" ? { id: "edit", name: "Edit" } : undefined);
  const label = (mode: (typeof modes)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const plan = modes.find((mode) => mode.id === "plan")!;
  const planLabel = label(plan);
  // Plan 拆成独立勾选项后仍需保留原菜单说明，复用相同的国际化映射。
  const planDescriptionId = getModeOptionDescriptionMessageId(displayProvider, { value: plan.id });
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: draftConfig?.mode ?? "build",
      options: selectablePermissions.map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [draftConfig?.mode],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) onSwitchMode(next);
  }, [modeOption, onSwitchMode]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  // 上下文档位是互斥三态（普通/极简/融合），与权限单选正交；用 RadioGroup 保证键盘与选择语义。
  const activeContextProfile: ContextProfile =
    draftConfig?.contextProfile === "minimal" || draftConfig?.contextProfile === "fusion"
      ? draftConfig.contextProfile
      : "standard";
  const ContextProfileIcon = resolveModeOptionIcon(activeContextProfile);
  // 当前档位必须可见：融合/极简激活时在触发按钮上追加档位标签；compact 模式下退化为
  // 档位图标徽标（不依赖权限图标），aria-label 同步携带档位，窄屏仍可识别。
  const profileMarkerLabel =
    activeContextProfile === "standard"
      ? undefined
      : intl.formatMessage({
          id:
            activeContextProfile === "fusion"
              ? "chat.toolbar.mode.fusionContext.label"
              : "chat.toolbar.mode.minimalContext.label",
        });
  const profileTriggerTone =
    // fusion 不是自动执行权限，不用 warning 色；用中性强调与权限色区分。
    activeContextProfile === "fusion" ? "text-icon-blue" : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={
                profileMarkerLabel
                  ? `${intl.formatMessage({ id: "chat.toolbar.mode.label" })} · ${profileMarkerLabel}`
                  : intl.formatMessage({ id: "chat.toolbar.mode.label" })
              }
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:px-0",
                profileMarkerLabel
                  ? "data-[composer-compact=true]:w-11"
                  : "data-[composer-compact=true]:w-7",
                selected.id === "guarded" &&
                  "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue",
                // yolo / minimal 同为自动执行权限，触发按钮同用警示色提示。
                // 与 display.tsx 的 isHighPermissionModeValue 同值域；这里拿不到那个 helper
                // （它在展示层文件内部），改它时两处要一起改。
                (selected.id === "yolo" || selected.id === "minimal") &&
                  "text-warning hover:text-warning",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {label(selected)}
              </span>
              {profileMarkerLabel && (
                <span
                  data-testid="v4-composer-context-profile-marker"
                  className={cn(
                    "inline items-center rounded-md bg-surface px-1.5 text-ui-sm text-foreground-subtle group-data-[composer-compact=true]/mode:px-0",
                    profileTriggerTone,
                  )}
                >
                  {/* 全尺寸显示档位文案；compact 只保留档位图标，仍与权限图标可区分。 */}
                  <span className="inline group-data-[composer-compact=true]/mode:hidden">
                    {profileMarkerLabel}
                  </span>
                  <ContextProfileIcon className="hidden size-3.5 group-data-[composer-compact=true]/mode:inline" />
                </span>
              )}
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuCheckboxItem
            checked={draftConfig?.planEnabled ?? false}
            onCheckedChange={(checked) => onSwitchMode(checked ? "plan" : "plan-off")}
            data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}
            className="min-h-13 items-start gap-3 py-2"
          >
            <LightbulbIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{planLabel}</span>
              {planDescriptionId && (
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: planDescriptionId })}
                </span>
              )}
            </span>
          </DropdownMenuCheckboxItem>
          {/* 上下文档位三态互斥：普通/极简/融合；切换只改档位，权限与 Plan 不变。 */}
          <DropdownMenuRadioGroup
            value={activeContextProfile}
            onValueChange={(value) => {
              // 值域守卫：schema 校验失败的选择不落到草稿。
              const parsed = contextProfileSchema.safeParse(value);
              if (!parsed.success) return;
              onSwitchContextProfile?.(parsed.data);
            }}
          >
            {(
              [
                {
                  value: "standard" as const,
                  labelId: "chat.toolbar.mode.standardContext.label",
                  descriptionId: "chat.toolbar.mode.standardContext.description",
                  testIdSuffix: "standard-context",
                },
                {
                  value: "minimal" as const,
                  labelId: "chat.toolbar.mode.minimalContext.label",
                  descriptionId: "chat.toolbar.mode.minimalContext.description",
                  testIdSuffix: "minimal-context",
                },
                {
                  value: "fusion" as const,
                  labelId: "chat.toolbar.mode.fusionContext.label",
                  descriptionId: "chat.toolbar.mode.fusionContext.description",
                  testIdSuffix: "fusion-context",
                },
              ] as const
            ).map((profile) => {
              const ProfileIcon = resolveModeOptionIcon(profile.value);
              return (
                <DropdownMenuRadioItem
                  key={profile.value}
                  value={profile.value}
                  disabled={disabled || !onSwitchContextProfile}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, profile.testIdSuffix)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ProfileIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{intl.formatMessage({ id: profile.labelId })}</span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: profile.descriptionId })}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={selected.id} onValueChange={onSwitchMode}>
            {selectablePermissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {descriptionId && (
                      <span className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({ id: descriptionId })}
                      </span>
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {draftConfig?.planEnabled && (
        <span data-testid="v4-composer-plan-marker" className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "chat.plan.removeMarker" })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => onSwitchMode("plan-off")}
              aria-label={intl.formatMessage({ id: "chat.plan.removeMarker" })}
              className="group/plan h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <LightbulbIcon className="size-4 group-hover/plan:hidden group-focus-visible/plan:hidden" />
              <XIcon className="hidden size-4 group-hover/plan:block group-focus-visible/plan:block" />
              <span className="inline group-data-[composer-compact=true]/plan:hidden">
                {intl.formatMessage({ id: "mode.plan" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
