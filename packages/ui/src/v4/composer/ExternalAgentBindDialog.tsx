// 绑定外部 coding agent 的对话框。
//
// 三层信息，从上到下回答用户三个问题：
//   1. 用哪个？——内置预设（已适配调用形状），标出本机装没装；
//   2. 用哪个模型？——该 CLI 能枚举就给下拉，不能枚举就给自由输入；
//   3. 装在哪 / 叫什么？——命令与展示名，默认由预设填好，可手改。
//
// 「已适配」的实际含义：driver + 默认 argv 都实测过。手改命令后仍然是可选的行为，
// 但对话框不会假装那还是预设——预设标记只在未改动命令时保留。
import { useCallback, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, DownloadIcon, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ExternalAgentPreset, ExternalAgentPresetStatus } from "@zcode/shared";
import type { BindExternalAgentPayload } from "@/v4/composer/externalAgentCommands.js";

export interface ExternalAgentBindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: BindExternalAgentPayload) => Promise<void>;
  /** 探测结果；null/空 = 探测不可用（宿主未接线），此时退回纯手填。 */
  probe: ExternalAgentPresetStatus[] | null;
  /** 探测进行中（首次打开时短暂为 true）。 */
  probing?: boolean;
  /** 重新探测（用户刚装完 CLI 回来）。 */
  onReprobe?: () => void;
}

/** 表单状态：presetId 为 null 表示完全手填。 */
interface BindDraft {
  presetId: string | null;
  label: string;
  command: string;
  permissionMode: string;
  model: string;
  effort: string;
}

function draftFromPreset(preset: ExternalAgentPreset): BindDraft {
  return {
    presetId: preset.id,
    label: preset.label,
    command: preset.command,
    permissionMode: preset.permissionMode ?? "",
    // 预设给了静态候选就默认第一个；否则留空（用该 CLI 的默认模型）。
    model: preset.models[0] ?? "",
    // 档位刻意不预选：默认档是该 CLI 自己的判断，替用户钉死一个反而改变了行为。
    effort: "",
  };
}

const EMPTY_DRAFT: BindDraft = {
  presetId: null,
  label: "",
  command: "",
  permissionMode: "",
  model: "",
  effort: "",
};

function ExternalAgentBindDialogImpl({
  open,
  onOpenChange,
  onSubmit,
  probe,
  probing = false,
  onReprobe,
}: ExternalAgentBindDialogProps) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<BindDraft>(EMPTY_DRAFT);
  const [pending, setPending] = useState(false);

  const statuses = probe ?? [];
  const selectedStatus = useMemo(
    () => statuses.find((entry) => entry.preset.id === draft.presetId),
    [statuses, draft.presetId],
  );
  const selectedPreset = selectedStatus?.preset;
  // 模型候选：探测到的优先；探测缺席但预设声明了静态候选时用它。
  const modelOptions = useMemo(() => {
    if (!selectedPreset) return [];
    const probed = selectedStatus?.models ?? [];
    return probed.length > 0 ? probed : selectedPreset.models;
  }, [selectedPreset, selectedStatus]);

  // 推理档位候选：来自预设（各 CLI 值域不同，claude 无 minimal、codebuddy 有）。
  const effortOptions = selectedPreset?.effortLevels ?? [];

  const selectPreset = useCallback((preset: ExternalAgentPreset) => {
    setDraft(draftFromPreset(preset));
  }, []);

  const handleSubmit = useCallback(() => {
    if (pending) return;
    if (!draft.label.trim() || !draft.command.trim()) return;
    const preset = selectedPreset;
    setPending(true);
    void onSubmit({
      label: draft.label.trim(),
      // 手填时按 claude-family 处理：它的参数形状最宽（-p + 输出格式 + 末尾 prompt），
      // 用户手填的 CLI 多半同构；不合规时执行期会给出真实报错。
      driver: preset?.driver ?? "claude-family",
      command: draft.command.trim(),
      ...(preset && preset.args.length > 0 ? { args: [...preset.args] } : {}),
      promptDelivery: preset?.promptDelivery ?? "argv-append",
      ...(draft.permissionMode.trim() ? { permissionMode: draft.permissionMode.trim() } : {}),
      ...(preset ? { presetId: preset.id } : {}),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
    }).finally(() => setPending(false));
  }, [draft, onSubmit, pending, selectedPreset]);

  const canSubmit = !pending && draft.label.trim().length > 0 && draft.command.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="external-agent-bind-dialog">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.externalAgent.bindTitle" })}</DialogTitle>
        </DialogHeader>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "chat.externalAgent.bindDescription" })}
        </p>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.externalAgent.bindChoose" })}
            </span>
            {onReprobe ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-ui-sm"
                onClick={onReprobe}
                disabled={probing}
              >
                {probing ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <DownloadIcon className="size-3.5" />
                )}
                {intl.formatMessage({ id: "chat.externalAgent.bindReprobe" })}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5" data-testid="external-agent-preset-list">
            {statuses.map((status) => {
              const { preset } = status;
              const selected = draft.presetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={pending}
                  onClick={() => selectPreset(preset)}
                  data-testid={`external-agent-preset-${preset.id}`}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    selected
                      ? "border-primary/60 bg-primary/5"
                      : "border-border hover:bg-surface-hover",
                  )}
                >
                  <span className="mt-0.5 shrink-0">
                    {selected ? (
                      <CheckIcon className="size-4 text-primary" />
                    ) : (
                      <span className="block size-4 rounded-full border border-border" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span className="text-ui-base font-medium">{preset.label}</span>
                      {status.installed ? (
                        <span className="rounded bg-surface-raised px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                          {status.version ??
                            intl.formatMessage({ id: "chat.externalAgent.installed" })}
                        </span>
                      ) : (
                        <span className="rounded bg-warning/10 px-1.5 py-0.5 text-ui-xs text-warning">
                          {intl.formatMessage({ id: "chat.externalAgent.notInstalled" })}
                        </span>
                      )}
                    </span>
                    <span className="text-ui-sm text-foreground-subtle">{preset.description}</span>
                  </span>
                </button>
              );
            })}
            {statuses.length === 0 && !probing ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.externalAgent.probeUnavailable" })}
              </p>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Field label={intl.formatMessage({ id: "chat.externalAgent.bindLabel" })}>
            <Input
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              data-testid="external-agent-bind-label"
            />
          </Field>
          <Field label={intl.formatMessage({ id: "chat.externalAgent.bindCommand" })}>
            <Input
              value={draft.command}
              onChange={(event) =>
                // 手改命令视为自定义：预设标记只对未改动的命令成立。
                setDraft({ ...draft, command: event.target.value, presetId: null })
              }
              data-testid="external-agent-bind-command"
            />
          </Field>
          <Field label={intl.formatMessage({ id: "chat.externalAgent.bindModel" })}>
            {modelOptions.length > 0 ? (
              <select
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                data-testid="external-agent-bind-model"
                className="h-9 w-full rounded-md border border-border bg-surface px-2 text-ui-base"
              >
                <option value="">
                  {intl.formatMessage({ id: "chat.externalAgent.modelDefault" })}
                </option>
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={draft.model}
                placeholder={intl.formatMessage({ id: "chat.externalAgent.modelPlaceholder" })}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                data-testid="external-agent-bind-model"
              />
            )}
          </Field>
          <Field label={intl.formatMessage({ id: "chat.externalAgent.bindPermissionMode" })}>
            <Input
              value={draft.permissionMode}
              placeholder="acceptEdits"
              onChange={(event) => setDraft({ ...draft, permissionMode: event.target.value })}
            />
          </Field>
          {effortOptions.length > 0 ? (
            <Field label={intl.formatMessage({ id: "chat.externalAgent.bindEffort" })}>
              <select
                value={draft.effort}
                onChange={(event) => setDraft({ ...draft, effort: event.target.value })}
                data-testid="external-agent-bind-effort"
                className="h-9 w-full rounded-md border border-border bg-surface px-2 text-ui-base"
              >
                <option value="">
                  {intl.formatMessage({ id: "chat.externalAgent.effortDefault" })}
                </option>
                {effortOptions.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </section>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="external-agent-bind-submit"
          >
            {intl.formatMessage({ id: "chat.externalAgent.bindSubmit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-sm text-foreground-subtle">{label}</span>
      {children}
    </label>
  );
}

export const ExternalAgentBindDialog = ExternalAgentBindDialogImpl;
