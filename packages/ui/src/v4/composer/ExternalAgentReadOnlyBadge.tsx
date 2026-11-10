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
import {
  BookOpenIcon,
  ChevronDownIcon,
  LoaderIcon,
  LockIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  /**
   * 每个模型的档位集合（`""` = CLI 默认模型）。
   *
   * 提供时模型菜单改为"模型 → 档位"两级子菜单：档位是模型能力，不同模型不同，
   * 一次点选就把模型与该模型的档位一起落定，不再拆成两个互不相干的分区。
   */
  modelEfforts?: Array<{ model: string; levels: string[] }>;
  /** 一次选择"模型 + 档位"（model=null → CLI 默认模型；effort=null → 该模型默认档位）。 */
  onChangeModelEffort?: (model: string | null, effort: string | null) => Promise<void>;
  /** 切换推理档位（null = CLI 默认）。 */
  onChangeEffort?: (effort: string | null) => Promise<void>;
  /** 可选推理档位；空 = 该 CLI 没有这个维度，不显示分区。 */
  effortOptions?: string[];
  /** 切换当前模型的上下文窗口（null = CLI/服务端默认窗口）。 */
  onChangeContextWindow?: (tokens: number | null) => Promise<void>;
  /** 当前模型可选的上下文窗口（token 数）；空 = 不显示分区。 */
  contextWindowOptions?: number[];
  /** 切换续接的外部会话（null = 清除，回到每次开新会话）。 */
  onChangeSession?: (sessionId: string | null) => Promise<void>;
  /** 拉取历史会话列表；菜单展开时调用。缺席 = 不显示会话子菜单。 */
  onLoadSessions?: () => Promise<V4ExternalAgentSessionsResult>;
  /** 删除一个外部会话（行内二次确认）。resolve false = 没删掉（本来就不存在）。 */
  onDeleteSession?: (externalSessionId: string) => Promise<boolean>;
  /**
   * 打开该外部会话的完整上下文面板。
   * 缺席 = 不显示「查看上下文」入口（宿主没接线或旧 CLI 不支持）。
   */
  onOpenSessionTranscript?: (session: { sessionId: string; title: string }) => void;
  disabled?: boolean;
}

interface SessionEntry {
  sessionId: string;
  title: string;
  updatedAt: number;
}

/** 上下文窗口展示标签：200000 → 200K，1000000 → 1M。 */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
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
  modelEfforts,
  onChangeModelEffort,
  onChangeEffort,
  effortOptions,
  onChangeContextWindow,
  contextWindowOptions,
  onChangeSession,
  onLoadSessions,
  onDeleteSession,
  onOpenSessionTranscript,
  disabled,
}: ExternalAgentReadOnlyBadgeProps) {
  const { intl } = useZCodeIntl();
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);
  // 会话列表只在菜单展开时拉一次（之后缓存到关闭为止）。
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // 删除是破坏性操作：第一次点垃圾桶只进入"待确认"，再点一次才真删。
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const handleChangeModelEffort = useCallback(
    (model: string | null, effort: string | null) => {
      if (switching || !onChangeModelEffort) return;
      setSwitching(true);
      void onChangeModelEffort(model, effort).finally(() => setSwitching(false));
    },
    [onChangeModelEffort, switching],
  );

  const handleChangeContextWindow = useCallback(
    (value: string) => {
      if (switching || !onChangeContextWindow) return;
      setSwitching(true);
      void onChangeContextWindow(value === "" ? null : Number(value)).finally(() =>
        setSwitching(false),
      );
    },
    [onChangeContextWindow, switching],
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

  // 查看上下文：打开侧栏面板并收起菜单（面板不在菜单里）。
  const handleOpenTranscript = useCallback(
    (session: SessionEntry) => {
      if (!onOpenSessionTranscript) return;
      setMenuOpen(false);
      onOpenSessionTranscript({ sessionId: session.sessionId, title: session.title });
    },
    [onOpenSessionTranscript],
  );

  // 两步删除：第一次点只进入待确认，第二次才真正执行。
  const handleDeleteSession = useCallback(
    (session: SessionEntry) => {
      if (!onDeleteSession || deletingId) return;
      if (pendingDeleteId !== session.sessionId) {
        setPendingDeleteId(session.sessionId);
        return;
      }
      setDeletingId(session.sessionId);
      void onDeleteSession(session.sessionId)
        .then((deleted) => {
          // 无论删没删掉都从列表里移除：删失败（本来就不存在）时列表也该刷新。
          setSessions((current) =>
            (current ?? []).filter((s) => s.sessionId !== session.sessionId),
          );
          setPendingDeleteId(null);
          if (!deleted) loadSessions();
        })
        .catch(() => setPendingDeleteId(null))
        .finally(() => setDeletingId(null));
    },
    [deletingId, loadSessions, onDeleteSession, pendingDeleteId],
  );

  // 徽标文案带上模型与档位：只读会话里"现在谁在跑、以什么强度"是事实。
  const agentName = [
    binding.label,
    binding.model,
    binding.effort ? `effort: ${binding.effort}` : undefined,
    binding.contextWindow ? `ctx: ${formatContextWindow(binding.contextWindow)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = intl.formatMessage({ id: "chat.externalAgent.readOnly" }, { agent: agentName });
  const unbindLabel = intl.formatMessage(
    { id: "chat.externalAgent.unbind" },
    { agent: binding.label },
  );
  const hasModelMenu = Boolean(onChangeModel) && (modelOptions?.length ?? 0) > 0;
  // 模型-档位绑定菜单优先：提供 per-model 档位时，模型与档位合成一个两级菜单。
  const hasModelEfforts = Boolean(onChangeModelEffort) && (modelEfforts?.length ?? 0) > 0;
  const hasEffortMenu = Boolean(onChangeEffort) && (effortOptions?.length ?? 0) > 0;
  const hasContextWindowMenu =
    Boolean(onChangeContextWindow) && (contextWindowOptions?.length ?? 0) > 0;
  const hasSessionMenu = Boolean(onChangeSession && onLoadSessions);
  const showMenu =
    hasModelEfforts || hasModelMenu || hasEffortMenu || hasContextWindowMenu || hasSessionMenu;

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
      {...(hasSessionMenu || onOpenSessionTranscript || onDeleteSession
        ? {
            open: menuOpen,
            onOpenChange: (open: boolean) => {
              setMenuOpen(open);
              if (!open) setPendingDeleteId(null);
              // 每次展开都重拉：列表数据在另一台机器/另一个进程落盘，缓存会过期。
              if (open && hasSessionMenu) {
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
        {hasModelEfforts ? (
          <>
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.externalAgent.modelMenuLabel" },
                { agent: binding.label },
              )}
            </DropdownMenuLabel>
            {/* 模型可能有十几二十条：与续接会话同样单独滚动，标题固定在上方。 */}
            <div
              className="max-h-56 overflow-y-auto overscroll-contain"
              data-testid="external-agent-models-scroll"
            >
              {modelEfforts?.map(({ model, levels }) => {
                const isCurrent = (binding.model ?? "") === model;
                return (
                  <DropdownMenuSub key={model || "__default__"}>
                    <DropdownMenuSubTrigger disabled={disabled || switching}>
                      <span className="flex min-w-0 flex-col">
                        <span className={cn("min-w-0 truncate", isCurrent && "text-foreground")}>
                          {model || intl.formatMessage({ id: "chat.externalAgent.modelDefault" })}
                        </span>
                        {isCurrent && binding.effort ? (
                          <span className="text-ui-xs text-foreground-subtle">
                            {binding.effort}
                          </span>
                        ) : null}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={isCurrent ? (binding.effort ?? "") : ""}
                        onValueChange={(value) =>
                          handleChangeModelEffort(model || null, value === "" ? null : value)
                        }
                      >
                        <DropdownMenuRadioItem value="">
                          {intl.formatMessage({ id: "chat.externalAgent.effortDefault" })}
                        </DropdownMenuRadioItem>
                        {levels.map((level) => (
                          <DropdownMenuRadioItem key={level} value={level}>
                            {level}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
            </div>
          </>
        ) : hasModelMenu ? (
          <>
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.externalAgent.modelMenuLabel" },
                { agent: binding.label },
              )}
            </DropdownMenuLabel>
            {/* RadioGroup 的空串 = "CLI 默认模型"，与绑定表单里那个占位选项同义。 */}
            <div
              className="max-h-56 overflow-y-auto overscroll-contain"
              data-testid="external-agent-models-scroll"
            >
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
            </div>
          </>
        ) : null}
        {(hasModelEfforts || hasModelMenu) && hasEffortMenu && !hasModelEfforts ? (
          <DropdownMenuSeparator />
        ) : null}
        {hasEffortMenu && !hasModelEfforts ? (
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
        {hasContextWindowMenu ? (
          <>
            {(hasModelMenu || hasEffortMenu) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.externalAgent.contextWindowMenuLabel" })}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={binding.contextWindow ? String(binding.contextWindow) : ""}
              onValueChange={handleChangeContextWindow}
            >
              <DropdownMenuRadioItem value="">
                {intl.formatMessage({ id: "chat.externalAgent.contextWindowDefault" })}
              </DropdownMenuRadioItem>
              {contextWindowOptions?.map((tokens) => (
                <DropdownMenuRadioItem key={tokens} value={String(tokens)}>
                  {formatContextWindow(tokens)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {hasSessionMenu ? (
          <>
            {(hasModelMenu || hasEffortMenu || hasContextWindowMenu) && <DropdownMenuSeparator />}
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
                {/* 空串 = "不续接"：每次委派让 CLI 开新会话。固定在上方，不随列表滚动。 */}
                <DropdownMenuRadioItem value="">
                  <PlusIcon className="mr-1.5 inline size-3.5" />
                  {intl.formatMessage({ id: "chat.externalAgent.sessionFresh" })}
                </DropdownMenuRadioItem>
                {/* 会话可能有几十条：只让列表自己滚，避免把模型/档位/解绑一起卷走。
                    overscroll-contain 防止滚到头后带动外层菜单。 */}
                <div
                  className="max-h-56 overflow-y-auto overscroll-contain"
                  data-testid="external-agent-sessions-scroll"
                >
                  {sessions?.map((session) => {
                    const pendingDelete = pendingDeleteId === session.sessionId;
                    const deleting = deletingId === session.sessionId;
                    return (
                      <div
                        key={session.sessionId}
                        className="flex items-center gap-1 pr-1"
                        data-testid="external-agent-session-row"
                      >
                        <DropdownMenuRadioItem value={session.sessionId} className="min-w-0 flex-1">
                          <span className="flex min-w-0 flex-col">
                            <span className="min-w-0 truncate">{session.title}</span>
                            <span className="text-ui-xs text-foreground-subtle tabular-nums">
                              {formatSessionTime(session.updatedAt)} ·{" "}
                              {session.sessionId.slice(0, 8)}
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                        {/* 两个行内动作不是菜单项：点它们不改变"续接目标"，也不该关掉菜单
                            （删除要两步确认）。 */}
                        {onOpenSessionTranscript ? (
                          <button
                            type="button"
                            className="shrink-0 rounded p-1 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                            data-testid="external-agent-session-open"
                            aria-label={intl.formatMessage({
                              id: "chat.externalAgent.sessionViewContext",
                            })}
                            title={intl.formatMessage({
                              id: "chat.externalAgent.sessionViewContext",
                            })}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              handleOpenTranscript(session);
                            }}
                          >
                            <BookOpenIcon className="size-3.5" />
                          </button>
                        ) : null}
                        {onDeleteSession ? (
                          pendingDelete ? (
                            <span
                              className="flex shrink-0 items-center gap-1"
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="rounded bg-danger/10 px-1.5 py-0.5 text-ui-xs text-danger hover:bg-danger/20 disabled:opacity-50"
                                data-testid="external-agent-session-delete-confirm"
                                disabled={deleting}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleDeleteSession(session);
                                }}
                              >
                                {deleting
                                  ? intl.formatMessage({ id: "chat.externalAgent.sessionDeleting" })
                                  : intl.formatMessage({
                                      id: "chat.externalAgent.sessionDeleteConfirm",
                                    })}
                              </button>
                              <button
                                type="button"
                                className="rounded p-1 text-foreground-subtle hover:bg-surface-hover"
                                data-testid="external-agent-session-delete-cancel"
                                aria-label={intl.formatMessage({ id: "common.cancel" })}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setPendingDeleteId(null);
                                }}
                              >
                                <XIcon className="size-3" />
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-foreground-subtle hover:bg-surface-hover hover:text-danger"
                              data-testid="external-agent-session-delete"
                              aria-label={intl.formatMessage({
                                id: "chat.externalAgent.sessionDelete",
                              })}
                              title={intl.formatMessage({ id: "chat.externalAgent.sessionDelete" })}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                handleDeleteSession(session);
                              }}
                            >
                              <Trash2Icon className="size-3.5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    );
                  })}
                </div>
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
