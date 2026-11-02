// 会话外部 agent 绑定的只读徽标。
//
// 展示位置：composer 左下角，紧跟模式选择器——用户看到"只读"的第一时间应该同时看到
// "为什么"（绑了谁）和"怎么退出"（解绑）。这是绑定状态的唯一可视入口。
//
// 只读期间模式选择器点不动是刻意的（CLI 侧唯一写入口会拒），所以这里不能只是一个
// 静态标签：必须有解绑出口，否则用户会把会话卡死。
import { memo, useCallback, useState } from "react";
import { LoaderIcon, LockIcon } from "lucide-react";
import type { ExternalAgentState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export interface ExternalAgentReadOnlyBadgeProps {
  binding: ExternalAgentState;
  /**
   * 解绑；resolve 前徽标保持 pending 视觉，避免连点与假成功。
   * 缺省 = 宿主还没接命令面：只展示只读状态，不提供点击（不假装能解绑）。
   */
  onUnbind?: () => Promise<void>;
  disabled?: boolean;
}

function ExternalAgentReadOnlyBadgeImpl({
  binding,
  onUnbind,
  disabled,
}: ExternalAgentReadOnlyBadgeProps) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(() => {
    if (pending || !onUnbind) return;
    setPending(true);
    void onUnbind().finally(() => setPending(false));
  }, [onUnbind, pending]);

  const label = intl.formatMessage({ id: "chat.externalAgent.readOnly" }, { agent: binding.label });
  const unbindLabel = intl.formatMessage(
    { id: "chat.externalAgent.unbind" },
    { agent: binding.label },
  );

  return (
    <ControlHintTooltip
      title={intl.formatMessage(
        { id: "chat.externalAgent.readOnlyHint" },
        { agent: binding.label },
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || pending || !onUnbind}
        data-composer-collapse-priority="1"
        data-testid="v4-composer-external-agent-badge"
        aria-label={pending ? unbindLabel : label}
        onClick={handleClick}
        className={cn(
          "h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle",
          "hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
        )}
      >
        {pending ? <LoaderIcon className="size-4 animate-spin" /> : <LockIcon className="size-4" />}
        <span className="inline max-w-40 truncate data-[composer-compact=true]:hidden">
          {pending ? unbindLabel : label}
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ExternalAgentReadOnlyBadge = memo(ExternalAgentReadOnlyBadgeImpl);
