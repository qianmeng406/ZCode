import { modeTriggerColor } from "@/chat-input-toolbar/display-help.js";
import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useYoloModeConfirmation } from "@/hooks/useConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/**
 * 主控模式：绑定外部 agent 后"只读分析 + 委派执行"的呈现层别名。
 *
 * 内部仍然是 `mode=plan + planEnabled=true + externalAgentReadOnly`（只读的唯一事实
 * 是 planEnabled），所以这个 id 只在本菜单里合成，不进 @zcode/shared 的模式目录——
 * 否则会漏进 automation / off-peak 等共用同一目录的表单。
 */
const ORCHESTRATOR_MODE_ID = "orchestrator";

/**
 * Plan 与工作模式（变更前确认/自主/资料查询/极简/Beta）正交；权限仍为单选；
 * 只编辑草稿，不向 Runtime 发切换命令。
 * Beta（提示词融合模式测试版本）是独立模式入口，触发按钮直接显示 Beta 标签，
 * 不再附加上下文档位徽标。历史 fusion 档位只作为读取兼容：build+fusion 等组合
 * 仍按原权限回显，不自动升级为完全访问的 Beta。
 *
 * 主控模式是例外：它不写草稿，而是打开绑定弹窗（未绑定）或保持现状（已绑定）。
 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
  orchestratorActive = false,
  orchestratorAvailable = true,
  onSelectOrchestrator,
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
> & {
  /** 当前会话已绑定外部 agent：模式菜单呈现为"主控模式"。 */
  orchestratorActive?: boolean;
  /** 存在会话（绑定命令需要 sessionId）；草稿任务里主控入口不可用。 */
  orchestratorAvailable?: boolean;
  /** 选中"主控模式"（未绑定时由调用方打开绑定弹窗）。 */
  onSelectOrchestrator?: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 原草稿回调随 scope 换代，旧确认不能把权限写入后来选中的任务。
  const confirmMode = useYoloModeConfirmation(disabled ? null : onSwitchMode, draftConfig?.mode);
  const requestSwitchMode = useCallback(
    (mode: string) => {
      confirmMode(mode, () => onSwitchMode(mode));
    },
    [confirmMode, onSwitchMode],
  );
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  // Beta 由 shared 模式目录直接提供（mode=beta），UI 不再本地补候选。历史 fusion 档位
  // 只做读取兼容：按原权限回显，不把 build+fusion 自动升级成完全访问的 Beta。
  const permissionModes = modes.filter((mode) => mode.id !== "plan");
  // 主控项排在权限组最前：它是"绑定 + 只读"的入口，语义上高于具体权限档位。
  const selectablePermissions = [
    { id: ORCHESTRATOR_MODE_ID, name: "Orchestrator" },
    ...permissionModes,
  ];
  // 当前值：主控态强制回显主控；历史 build+fusion 仍回显 build（权限未变）。
  const currentModeId = orchestratorActive ? ORCHESTRATOR_MODE_ID : draftConfig?.mode;
  // 新菜单隐藏 Edit/minimal，但历史草稿仍可回显，不能因候选变化隐藏整个权限入口。
  const selected =
    selectablePermissions.find((mode) => mode.id === currentModeId) ??
    (currentModeId === "edit" || currentModeId === "minimal"
      ? { id: currentModeId, name: currentModeId === "edit" ? "Edit" : "Minimal mode" }
      : undefined);
  const label = (mode: { id: string; name: string }) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const plan = modes.find((mode) => mode.id === "plan")!;
  const planLabel = label(plan);
  // Plan 拆成独立勾选项后仍需保留原菜单说明，复用相同的国际化映射。
  const planDescriptionId = getModeOptionDescriptionMessageId(displayProvider, { value: plan.id });
  // 快捷键循环只走真实权限档位：主控不在循环里，避免 Ctrl+Shift+M 意外弹出绑定窗。
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: currentModeId ?? "build",
      options: permissionModes.map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [currentModeId, permissionModes],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) requestSwitchMode(next);
  }, [modeOption, requestSwitchMode]);
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
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                selected.id === "guarded" &&
                  "text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue",
                // yolo / minimal / beta 同为完全访问类权限，触发按钮同用警示色提示。
                // 与 display.tsx 的 isHighPermissionModeValue 同值域；这里拿不到那个 helper
                // （它在展示层文件内部），改它时两处要一起改。
                (selected.id === "yolo" || selected.id === "minimal" || selected.id === "beta") &&
                  "text-warning hover:text-warning",
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {/* Plan 菜单重写时普通 span 丢失了旧 ConfigSelect 的翻滚；复用同一动画组件恢复。 */}
                <RollingToolbarLabel label={label(selected)} />
              </span>
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
            if (!useConfirmDialogStore.getState().pendingRequest && !isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          {/* 主控态天然只读：Plan 勾选项与 plan 标记都要藏起来，否则用户会以为
              还能单独关掉只读。 */}
          {!orchestratorActive && (
            <>
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
              <DropdownMenuSeparator />
            </>
          )}
          {/* 工作模式单选：Beta 与其他模式同组；显式选非 Beta 即退出 Beta（草稿层清融合档位）。
              主控不是草稿切换：未绑定时交给调用方弹绑定窗，已绑定时保持现状。 */}
          <DropdownMenuRadioGroup
            value={selected.id}
            onValueChange={(value) => {
              if (value === ORCHESTRATOR_MODE_ID) {
                onConfigPickerOpenChange("mode", false);
                onSelectOrchestrator?.();
                return;
              }
              onSwitchMode(value);
            }}
          >
            {selectablePermissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              // 历史隐藏值（如 edit/minimal）只能回显不能改选；其余候选（含 Beta）始终可选。
              const isLegacyEchoOnly = mode.id === "edit" && selected.id !== "edit";
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  disabled={
                    disabled ||
                    isLegacyEchoOnly ||
                    (mode.id === ORCHESTRATOR_MODE_ID && !orchestratorAvailable)
                  }
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
      {draftConfig?.planEnabled && !orchestratorActive && (
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
