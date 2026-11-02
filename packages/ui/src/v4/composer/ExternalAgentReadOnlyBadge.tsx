// 会话外部 agent 的只读徽标（含模型切换）。
//
// 展示位置：composer 左下角，紧跟模式选择器——用户看到"只读"的第一时间应该同时看到
// "为什么"（绑了谁）、"用哪个模型"和"怎么退出"（解绑）。
//
// 只读期间模式选择器点不动是刻意的（CLI 侧唯一写入口会拒），所以这里不能只是静态
// 标签：必须有解绑出口，否则用户会把会话卡死；也必须有模型出口，否则换个模型就得
// 解绑再绑一次（那还会重新快照权限，见 setExternalAgentModel 的注释）。
import { memo, useCallback, useState } from "react";
import { ChevronDownIcon, LoaderIcon, LockIcon } from "lucide-react";
import type { ExternalAgentState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export interface ExternalAgentReadOnlyBadgeProps {
  binding: ExternalAgentState;
  /** 解绑；resolve 前徽标保持 pending 视觉，避免连点与假成功。 */
  onUnbind?: () => Promise<void>;
  /**
   * 切换外部 agent 的模型（null = 回到该 CLI 的默认模型）。
   * 缺席 = 不提供模型入口（宿主未接线）。
   */
  onChangeModel?: (model: string | null) => Promise<void>;
  /** 可选模型候选；空则不显示模型菜单。 */
  modelOptions?: string[];
  /** 切换推理档位（null = CLI 默认）。 */
  onChangeEffort?: (effort: string | null) => Promise<void>;
  /** 可选推理档位；空 = 该 CLI 没有这个维度，不显示分区。 */
  effortOptions?: string[];
  disabled?: boolean;
}

function ExternalAgentReadOnlyBadgeImpl({
  binding,
  onUnbind,
  onChangeModel,
  modelOptions,
  onChangeEffort,
  effortOptions,
  disabled,
}: ExternalAgentReadOnlyBadgeProps) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);

  const handleUnbind = useCallback(() => {
    if (pending || !onUnbind) return;
    setPending(true);
    void onUnbind().finally(() => setPending(false));
  }, [onUnbind, pending]);

  const handleChangeModel = useCallback(
    (value: string) => {
      if (switching || !onChangeModel) return;
      setSwitching(true);
      void onChangeModel(value === "" ? null : value).finally(() => setSwitching(false));
    },
    [onChangeModel, switching],
  );

  const handleChangeEffort = useCallback(
    (value: string) => {
      if (switching || !onChangeEffort) return;
      setSwitching(true);
      void onChangeEffort(value === "" ? null : value).finally(() => setSwitching(false));
    },
    [onChangeEffort, switching],
  );

  // 徽标文案带上模型与档位：只读会话里"现在谁在跑、以什么强度"是事实。
  const agentName = [
    binding.label,
    binding.model,
    binding.effort ? `effort: ${binding.effort}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = intl.formatMessage({ id: "chat.externalAgent.readOnly" }, { agent: agentName });
  const unbindLabel = intl.formatMessage(
    { id: "chat.externalAgent.unbind" },
    { agent: binding.label },
  );
  const hasModelMenu = Boolean(onChangeModel) && (modelOptions?.length ?? 0) > 0;
  const hasEffortMenu = Boolean(onChangeEffort) && (effortOptions?.length ?? 0) > 0;
  const showMenu = hasModelMenu || hasEffortMenu;

  const badge = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || pending || switching}
      data-composer-collapse-priority="1"
      data-testid="v4-composer-external-agent-badge"
      aria-label={pending ? unbindLabel : label}
      onClick={showMenu ? undefined : handleUnbind}
      className={cn(
        "h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle",
        "hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
      )}
    >
      {pending || switching ? (
        <LoaderIcon className="size-4 animate-spin" />
      ) : (
        <LockIcon className="size-4" />
      )}
      <span className="inline max-w-48 truncate data-[composer-compact=true]:hidden">{label}</span>
      {showMenu ? <ChevronDownIcon className="size-3 data-[composer-compact=true]:hidden" /> : null}
    </Button>
  );

  if (!showMenu) {
    return (
      <ControlHintTooltip
        title={intl.formatMessage(
          { id: "chat.externalAgent.readOnlyHint" },
          { agent: binding.label },
        )}
      >
        {badge}
      </ControlHintTooltip>
    );
  }

  return (
    <DropdownMenu>
      <ControlHintTooltip
        title={intl.formatMessage(
          { id: "chat.externalAgent.readOnlyHint" },
          { agent: binding.label },
        )}
      >
        <DropdownMenuTrigger asChild>{badge}</DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="start" side="top" className="w-64">
        {hasModelMenu ? (
          <>
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.externalAgent.modelMenuLabel" },
                { agent: binding.label },
              )}
            </DropdownMenuLabel>
            {/* RadioGroup 的空串 = "CLI 默认模型"，与绑定表单里那个占位选项同义。 */}
            <DropdownMenuRadioGroup value={binding.model ?? ""} onValueChange={handleChangeModel}>
              <DropdownMenuRadioItem value="">
                {intl.formatMessage({ id: "chat.externalAgent.modelDefault" })}
              </DropdownMenuRadioItem>
              {modelOptions?.map((model) => (
                <DropdownMenuRadioItem key={model} value={model}>
                  {model}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {hasModelMenu && hasEffortMenu ? <DropdownMenuSeparator /> : null}
        {hasEffortMenu ? (
          <>
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.externalAgent.effortMenuLabel" })}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={binding.effort ?? ""} onValueChange={handleChangeEffort}>
              <DropdownMenuRadioItem value="">
                {intl.formatMessage({ id: "chat.externalAgent.effortDefault" })}
              </DropdownMenuRadioItem>
              {effortOptions?.map((effort) => (
                <DropdownMenuRadioItem key={effort} value={effort}>
                  {effort}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending || !onUnbind}
          onSelect={() => handleUnbind()}
          className="text-warning focus:text-warning"
        >
          {unbindLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const ExternalAgentReadOnlyBadge = memo(ExternalAgentReadOnlyBadgeImpl);
