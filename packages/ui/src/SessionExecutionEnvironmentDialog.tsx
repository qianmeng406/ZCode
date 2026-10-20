import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderIcon, Monitor, Terminal } from "lucide-react";
import type { IPlatformService, WSLDistro } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  IDLE_PREPARATION_STATE,
  canConfigureSessionExecutionEnvironment,
  formatSessionExecutionEnvironmentLabel,
  validateSessionExecutionEnvironmentDraft,
  validateSessionExecutionEnvironmentSelection,
  type SessionExecutionEnvironmentPreparationState,
  type SessionExecutionEnvironmentSelection,
  type UseSessionExecutionEnvironmentResult,
} from "@/hooks/useSessionExecutionEnvironment.js";

/**
 * 会话执行环境选择弹窗（spec: docs/research/session-linux-execution.spec.md「UI」）。
 * 仅 Windows 本地 workspace + 已落库 session 提供入口；远程/其他平台不渲染。
 * distro 必须用户显式选择；user 可留空，此时由执行端使用该发行版的默认用户
 * （不修改 WSL 默认用户）。文件仍在 Windows 挂载盘，不承诺 ext4 性能、
 * node_modules 隔离或容器级沙箱。准备可取消、失败保留原环境可重试。
 *
 * workspacePath/workspaceIdentity 由 hook 的 scopeKey 单点持有，弹窗不重复接收，
 * 避免第二身份来源造成投影错位。
 */
export function SessionExecutionEnvironmentDialog({
  open,
  onOpenChange,
  sessionId,
  isRemoteWorkspace,
  isWindowsLocalWorkspace,
  platform,
  environment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  isRemoteWorkspace: boolean;
  isWindowsLocalWorkspace: boolean;
  platform: Pick<IPlatformService, "listWSLDistros">;
  environment: UseSessionExecutionEnvironmentResult;
}) {
  const available = canConfigureSessionExecutionEnvironment({
    sessionId,
    isRemoteWorkspace,
    isWindowsLocalWorkspace,
  });

  if (!available) {
    return null;
  }

  return (
    <SessionExecutionEnvironmentDialogInner
      open={open}
      onOpenChange={onOpenChange}
      platform={platform}
      environment={environment}
    />
  );
}

function SessionExecutionEnvironmentDialogInner({
  open,
  onOpenChange,
  platform,
  environment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: Pick<IPlatformService, "listWSLDistros">;
  environment: UseSessionExecutionEnvironmentResult;
}) {
  const { intl } = useZCodeIntl();
  // workspacePath/workspaceIdentity 由 hook 内部经 scopeKey 持有；
  // 弹窗只消费 hook 的投影与动作，避免第二个身份来源造成不一致。

  // 未提交的待定状态只留在本弹窗（spec：UI 只保留待提交状态）。
  const [distroDraft, setDistroDraft] = useState<string>("");
  const [userDraft, setUserDraft] = useState<string>("");
  const [distros, setDistros] = useState<WSLDistro[]>([]);
  const [distrosLoading, setDistrosLoading] = useState(false);
  const [distrosError, setDistrosError] = useState<string | null>(null);
  // 重试沿用上一次显式提交的选择；弹窗级状态，不跨会话/不落全局。
  const [lastSubmittedSelection, setLastSubmittedSelection] =
    useState<LastSubmittedSelection>(null);

  const preparation: SessionExecutionEnvironmentPreparationState =
    environment.preparation ?? IDLE_PREPARATION_STATE;

  // 发行版加载：每次打开只拉一次，在途请求用 token 失效（关闭/重开时递增）。
  // 不能把 distrosLoading 放进 effect 依赖并用 cleanup 作废回调——setDistrosLoading(true)
  // 会触发 effect 重跑，旧回调被 cancel 后 finally 永不执行，guard 又以 loading=true
  // 拒绝重试，状态将永久卡在“读取中”（真实 IPC 是宏任务、单测同步 stub 恰好掩盖该竞态）。
  const distroLoadTokenRef = useRef(0);
  const distroStartedForOpenRef = useRef(false);

  const loadDistros = useCallback(() => {
    const token = ++distroLoadTokenRef.current;
    setDistrosLoading(true);
    setDistrosError(null);
    void platform
      .listWSLDistros()
      .then((next) => {
        if (token !== distroLoadTokenRef.current) return;
        setDistros(next);
        setDistrosLoading(false);
      })
      .catch((runtimeError: unknown) => {
        if (token !== distroLoadTokenRef.current) return;
        logger.warn("[SessionExecutionEnvironment] listWSLDistros 失败", {
          error: String(runtimeError),
        });
        setDistrosError(String(runtimeError));
        setDistrosLoading(false);
      });
  }, [platform]);

  useEffect(() => {
    if (!open) {
      // 关闭弹窗：作废在途回调，允许下次打开重新加载（含失败后的重开重试）。
      distroStartedForOpenRef.current = false;
      distroLoadTokenRef.current += 1;
      return;
    }
    if (distroStartedForOpenRef.current) return;
    distroStartedForOpenRef.current = true;
    loadDistros();
  }, [open, loadDistros]);

  // 每次打开弹窗重置草稿为空；显式选择不预填当前值，避免把旧选择误当新提交。
  useEffect(() => {
    if (!open) return;
    setDistroDraft("");
    setUserDraft("");
    setLastSubmittedSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开瞬间重置
  }, [open]);

  const draftError = useMemo(
    () => validateSessionExecutionEnvironmentDraft(distroDraft, userDraft),
    [distroDraft, userDraft],
  );
  const isBusy = preparation.phase === "preparing" || preparation.phase === "cancelling";
  const currentLabel = formatSessionExecutionEnvironmentLabel(intl, environment.current);

  const submit = (selection: SessionExecutionEnvironmentSelection | { kind: "local" }) => {
    if (isBusy) return;
    if (selection.kind === "wsl") {
      // 提交前再校验一次（distro 必填、user 可空）；不合法直接丢弃，不发 service。
      if (validateSessionExecutionEnvironmentSelection(selection)) return;
      setLastSubmittedSelection(selection);
    }
    void environment.submitSelection(selection).then((submitted) => {
      if (submitted) onOpenChange(false);
    });
  };

  // 提交弹窗草稿：只需选中 distro；用户留空 = 使用发行版默认用户。
  const submitDraft = () => {
    const distro = distroDraft.trim();
    if (!distro) {
      return;
    }
    const user = userDraft.trim();
    submit({ kind: "wsl", distro, ...(user ? { user } : {}) });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // 准备进行中不允许点遮罩/Esc 直接丢掉弹窗；必须先取消准备。
        if (!nextOpen && isBusy) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-ui-lg">
            {intl.formatMessage({ id: "sessionExecutionEnvironment.dialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: "sessionExecutionEnvironment.dialog.description",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <Monitor className="size-4 text-foreground-subtle" />
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "sessionExecutionEnvironment.current.label" })}
              </span>
            </span>
            <span className="min-w-0 truncate font-mono text-ui-sm text-foreground">
              {currentLabel}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "sessionExecutionEnvironment.distro.label" })}
            </span>
            <Select
              value={distroDraft}
              onValueChange={setDistroDraft}
              disabled={isBusy || distrosLoading || distros.length === 0}
            >
              <SelectTrigger
                className="w-full"
                aria-label={intl.formatMessage({ id: "sessionExecutionEnvironment.distro.label" })}
                data-testid="session-execution-environment-distro"
              >
                <SelectValue
                  placeholder={intl.formatMessage({
                    id: distrosError
                      ? "sessionExecutionEnvironment.distro.unavailable"
                      : distrosLoading
                        ? "sessionExecutionEnvironment.distro.loading"
                        : "sessionExecutionEnvironment.distro.placeholder",
                  })}
                />
              </SelectTrigger>
              <SelectContent>
                {distros.map((entry) => (
                  <SelectItem key={entry.name} value={entry.name}>
                    <span className="flex items-center gap-2">
                      <Terminal className="size-3.5 text-foreground-subtle" />
                      <span className="font-mono text-ui-sm">{entry.name}</span>
                      {entry.isDefault ? (
                        <span className="text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({
                            id: "sessionExecutionEnvironment.distro.defaultTag",
                          })}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {distrosError ? (
              <span className="text-ui-xs text-destructive">
                {intl.formatMessage({ id: "sessionExecutionEnvironment.distro.unavailableHint" })}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="session-execution-environment-user"
              className="text-ui-sm font-medium text-foreground"
            >
              {intl.formatMessage({ id: "sessionExecutionEnvironment.user.label" })}
            </label>
            <Input
              id="session-execution-environment-user"
              value={userDraft}
              onChange={(event) => setUserDraft(event.target.value)}
              placeholder={intl.formatMessage({
                id: "sessionExecutionEnvironment.user.placeholder",
              })}
              disabled={isBusy || !distroDraft}
              aria-invalid={
                userDraft.trim() === ""
                  ? false
                  : draftError === "sessionExecutionEnvironment.error.invalidUser"
              }
              data-testid="session-execution-environment-user"
              className="h-9 font-mono"
            />
            <span className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "sessionExecutionEnvironment.user.defaultHint" })}
            </span>
            {draftError ? (
              <span className="text-ui-xs text-destructive" role="alert">
                {intl.formatMessage({ id: draftError })}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2">
            <span className="flex items-center gap-1.5 text-ui-sm font-medium text-foreground">
              <AlertTriangle className="size-3.5 text-warning" />
              {intl.formatMessage({ id: "sessionExecutionEnvironment.hint.title" })}
            </span>
            {HINT_MESSAGE_IDS.map((messageId) => (
              <span key={messageId} className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: messageId })}
              </span>
            ))}
          </div>

          {environment.preparingTarget ? (
            <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2">
              <span className="flex items-center gap-1.5 text-ui-sm text-foreground">
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
                {intl.formatMessage({ id: "sessionExecutionEnvironment.prepare.running" })}
              </span>
              <span className="font-mono text-ui-xs text-foreground-subtle">
                {formatSessionExecutionEnvironmentLabel(intl, environment.preparingTarget)}
              </span>
            </div>
          ) : null}

          {preparation.phase === "failed" ? (
            <div className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "sessionExecutionEnvironment.prepare.failed" })}
              </span>
              <span className="break-all font-mono text-ui-xs text-foreground-subtle">
                {preparation.error}
              </span>
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({
                  id: "sessionExecutionEnvironment.prepare.failedKeptOriginal",
                })}
              </span>
            </div>
          ) : null}

          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "sessionExecutionEnvironment.scopeNote" })}
          </span>
        </div>

        <DialogFooter className="gap-2">
          {isBusy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void environment.cancelPreparation();
              }}
              disabled={preparation.phase === "cancelling"}
              data-testid="session-execution-environment-cancel-prepare"
            >
              {preparation.phase === "cancelling" ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : null}
              {intl.formatMessage({ id: "sessionExecutionEnvironment.action.cancelPrepare" })}
            </Button>
          ) : (
            <>
              {preparation.phase === "failed" && lastSubmittedSelection ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => submit(lastSubmittedSelection)}
                >
                  {intl.formatMessage({ id: "sessionExecutionEnvironment.action.retry" })}
                </Button>
              ) : null}
              {environment.current?.kind === "wsl" ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => submit({ kind: "local" })}
                  data-testid="session-execution-environment-use-default"
                >
                  {intl.formatMessage({ id: "sessionExecutionEnvironment.action.useDefault" })}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {intl.formatMessage({ id: "common.close" })}
              </Button>
              <Button
                type="button"
                onClick={() => submitDraft()}
                disabled={Boolean(draftError) || !distroDraft.trim()}
                title={
                  !distroDraft.trim()
                    ? intl.formatMessage({
                        id: "sessionExecutionEnvironment.error.distroRequired",
                      })
                    : undefined
                }
                data-testid="session-execution-environment-submit"
              >
                {intl.formatMessage({ id: "sessionExecutionEnvironment.action.apply" })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 重试沿用上一次提交的选择（user 可缺省 = 默认用户）；弹窗级状态，不跨会话。 */
type LastSubmittedSelection = SessionExecutionEnvironmentSelection | null;

/** 使用须知条目（挂载盘性能 / 依赖冲突 / 非安全沙箱），按 spec「UI」固定顺序展示。 */
const HINT_MESSAGE_IDS = [
  "sessionExecutionEnvironment.hint.mountedFiles",
  "sessionExecutionEnvironment.hint.nativeDeps",
  "sessionExecutionEnvironment.hint.noSandbox",
] as const;
