// 会话外部 agent 的只读徽标（含模型/档位/外部会话切换）。
//
// 展示位置：composer 左下角，紧跟模式选择器——用户看到"只读"的第一时间应该同时看到
// "为什么"（绑了谁）、"用哪个模型/哪个外部会话"和"怎么退出"（解绑）。
//
// 只读期间模式选择器点不动是刻意的（CLI 侧唯一写入口会拒），所以这里不能只是静态
// 标签：必须有解绑出口，否则用户会把会话卡死；也必须有模型出口，否则换个模型就得
// 解绑再绑一次（那还会重新快照权限，见 setExternalAgentModel 的注释）。
//
// 外部会话子菜单（setExternalAgentSession）：续接是 codebuddy/claude 的 `-r <id>`，
// 换目标 = 接着另一段历史干活；清除 = 回到每次委派开新会话。列表在菜单展开时拉取
// （落执行机的目录扫描，不能在渲染期发起）。
import { memo, useCallback, useState } from "react";
import { ChevronDownIcon, LoaderIcon, LockIcon, PlusIcon } from "lucide-react";
import type {
  ExternalAgentState,
  V4ExternalAgentSessionsResult,
} from "@zcode/shared/zcode-protocol-v4";
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
  /** 切换续接的外部会话（null = 清除，回到每次开新会话）。 */
  onChangeSession?: (sessionId: string | null) => Promise<void>;
  /** 拉取历史会话列表；菜单展开时调用。缺席 = 不显示会话子菜单。 */
  onLoadSessions?: () => Promise<V4ExternalAgentSessionsResult>;
  disabled?: boolean;
}

interface SessionEntry {
  sessionId: string;
  title: string;
  updatedAt: number;
}

function formatSessionTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ExternalAgentReadOnlyBadgeImpl({
  binding,
  onUnbind,
  onChangeModel,
  modelOptions,
  onChangeEffort,
  effortOptions,
  onChangeSession,
  onLoadSessions,
  disabled,
}: ExternalAgentReadOnlyBadgeProps) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);
  // 会话列表只在菜单展开时拉一次（之后缓存到关闭为止）。
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

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

  const handleChangeSession = useCallback(
    (value: string) => {
      if (switching || !onChangeSession) return;
      setSwitching(true);
      void onChangeSession(value === "" ? null : value).finally(() => setSwitching(false));
    },
    [onChangeSession, switching],
  );

  const loadSessions = useCallback(() => {
    if (!onLoadSessions) return;
    setSessionsLoading(true);
    void onLoadSessions()
      .then((result) =>
        setSessions(
          result.sessions.map((entry) => ({
            sessionId: entry.sessionId,
            title: entry.title,
            updatedAt: entry.updatedAt,
          })),
        ),
      )
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false));
  }, [onLoadSessions]);

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
  const hasSessionMenu = Boolean(onChangeSession && onLoadSessions);
  const showMenu = hasModelMenu || hasEffortMenu || hasSessionMenu;

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
    <DropdownMenu
      {...(hasSessionMenu
        ? {
            onOpenChange: (open: boolean) => {
              // 每次展开都重拉：列表数据在另一台机器/另一个进程落盘，缓存会过期。
              if (open) {
                setSessions(null);
                loadSessions();
              }
            },
          }
        : {})}
    >
      <ControlHintTooltip
        title={intl.formatMessage(
          { id: "chat.externalAgent.readOnlyHint" },
          { agent: binding.label },
        )}
      >
        <DropdownMenuTrigger asChild>{badge}</DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="start" side="top" className="w-72">
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
        {hasSessionMenu ? (
          <>
            {(hasModelMenu || hasEffortMenu) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.externalAgent.sessionMenuLabel" })}
            </DropdownMenuLabel>
            {sessionsLoading && sessions === null ? (
              <div
                className="flex items-center gap-2 px-2 py-1.5 text-ui-xs text-foreground-subtle"
                data-testid="external-agent-sessions-loading"
              >
                <LoaderIcon className="size-3 animate-spin" />
                {intl.formatMessage({ id: "chat.externalAgent.sessionLoading" })}
              </div>
            ) : (sessions?.length ?? 0) === 0 ? (
              <div className="px-2 py-1.5 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "chat.externalAgent.sessionEmpty" })}
              </div>
            ) : (
              <DropdownMenuRadioGroup
                value={binding.externalSessionId ?? ""}
                onValueChange={handleChangeSession}
              >
                {/* 空串 = "不续接"：每次委派让 CLI 开新会话。 */}
                <DropdownMenuRadioItem value="">
                  <PlusIcon className="mr-1.5 inline size-3.5" />
                  {intl.formatMessage({ id: "chat.externalAgent.sessionFresh" })}
                </DropdownMenuRadioItem>
                {sessions?.map((session) => (
                  <DropdownMenuRadioItem key={session.sessionId} value={session.sessionId}>
                    <span className="flex min-w-0 flex-col">
                      <span className="min-w-0 truncate">{session.title}</span>
                      <span className="text-ui-xs text-foreground-subtle tabular-nums">
                        {formatSessionTime(session.updatedAt)} · {session.sessionId.slice(0, 8)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
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
