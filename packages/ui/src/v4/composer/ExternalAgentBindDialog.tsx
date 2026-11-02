// 绑定外部 coding agent 的对话框。
//
// 表单刻意只有三件事：选哪个预设、用哪个模型、用哪一档推理。
// 可执行命令与权限档位由预设自动带出（驱动/默认 argv/permissionMode 都实测过），
// 不暴露给用户——能改对的场景预设里已写好，能改错的场景用户无从判断。
//
// 模型与档位候选来自探测（服务端缓存 → product.json 兜底）；探测不可用时退化为
// 自由输入，保证功能不至于不可用。
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, DownloadIcon, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CLI_PICKER_DEFAULT_EFFORTS, resolveEffortLevels } from "@zcode/shared";
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
  command: string;
  model: string;
  effort: string;
}

function draftFromPreset(preset: ExternalAgentPreset): BindDraft {
  return {
    presetId: preset.id,
    command: preset.command,
    // 预设给了静态候选就默认第一个；否则留空（用该 CLI 的默认模型）。
    model: preset.models[0] ?? "",
    // 档位刻意不预选：默认档是该 CLI 自己的判断，替用户钉死一个反而改变了行为。
    effort: "",
  };
}

const EMPTY_DRAFT: BindDraft = { presetId: null, command: "", model: "", effort: "" };

/** Radix 的 SelectItem 不允许空串 value，"默认"档用这个哨兵承载，提交时还原成空。 */
const DEFAULT_OPTION = "__default__";

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

  // 推理档位候选按**当前选中的模型**解析，且优先用探测到的真实目录（服务端缓存）。
  // 该模型没有已知档位时回落到 CLI 选择器缺省档（与 codebuddy EffortPanel 一致）。
  const effortOptions = useMemo(
    () =>
      selectedPreset
        ? resolveEffortLevels(
            selectedPreset,
            draft.model || undefined,
            selectedStatus?.modelCatalog,
          )
        : [...CLI_PICKER_DEFAULT_EFFORTS],
    [selectedPreset, selectedStatus, draft.model],
  );

  const selectPreset = useCallback((preset: ExternalAgentPreset) => {
    setDraft(draftFromPreset(preset));
  }, []);

  const handleSubmit = useCallback(() => {
    if (pending) return;
    if (!draft.command.trim()) return;
    const preset = selectedPreset;
    setPending(true);
    void onSubmit({
      label: preset?.label ?? draft.command.trim(),
      // 手填时按 claude-family 处理：它的参数形状最宽（-p + 输出格式 + 末尾 prompt），
      // 用户手填的 CLI 多半同构；不合规时执行期会给出真实报错。
      driver: preset?.driver ?? "claude-family",
      command: draft.command.trim(),
      ...(preset && preset.args.length > 0 ? { args: [...preset.args] } : {}),
      promptDelivery: preset?.promptDelivery ?? "argv-append",
      // 权限档位由预设带出，不暴露给用户编辑。
      ...(preset?.permissionMode ? { permissionMode: preset.permissionMode } : {}),
      ...(preset ? { presetId: preset.id } : {}),
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
      ...(draft.effort.trim() ? { effort: draft.effort.trim() } : {}),
    }).finally(() => setPending(false));
  }, [draft, onSubmit, pending, selectedPreset]);

  const canSubmit = !pending && draft.command.trim().length > 0;

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

        {selectedPreset ? (
          <section className="flex flex-col gap-3">
            <Field label={intl.formatMessage({ id: "chat.externalAgent.bindModel" })}>
              {modelOptions.length > 0 ? (
                <Select
                  value={draft.model || DEFAULT_OPTION}
                  onValueChange={(value) =>
                    // 换模型时清空档位：旧档位属于旧模型，带过去可能根本无效。
                    setDraft({ ...draft, model: value === DEFAULT_OPTION ? "" : value, effort: "" })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    size="lg"
                    data-testid="external-agent-bind-model"
                  >
                    <SelectValue
                      placeholder={intl.formatMessage({ id: "chat.externalAgent.modelDefault" })}
                    />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={DEFAULT_OPTION}>
                      {intl.formatMessage({ id: "chat.externalAgent.modelDefault" })}
                    </SelectItem>
                    {modelOptions.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={draft.model}
                  placeholder={intl.formatMessage({ id: "chat.externalAgent.modelPlaceholder" })}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                  data-testid="external-agent-bind-model"
                />
              )}
            </Field>
            <Field label={intl.formatMessage({ id: "chat.externalAgent.bindEffort" })}>
              <Select
                value={draft.effort || DEFAULT_OPTION}
                onValueChange={(value) =>
                  setDraft({ ...draft, effort: value === DEFAULT_OPTION ? "" : value })
                }
              >
                <SelectTrigger
                  className="w-full"
                  size="lg"
                  data-testid="external-agent-bind-effort"
                >
                  <SelectValue
                    placeholder={intl.formatMessage({ id: "chat.externalAgent.effortDefault" })}
                  />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={DEFAULT_OPTION}>
                    {intl.formatMessage({ id: "chat.externalAgent.effortDefault" })}
                  </SelectItem>
                  {effortOptions.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </section>
        ) : statuses.length === 0 && !probing ? (
          // 探测不可用：退回手填命令（此时没有任何预设可带出执行参数）。
          <section className="flex flex-col gap-3">
            <Field label={intl.formatMessage({ id: "chat.externalAgent.bindCommand" })}>
              <Input
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                data-testid="external-agent-bind-command"
              />
            </Field>
            <Field label={intl.formatMessage({ id: "chat.externalAgent.bindModel" })}>
              <Input
                value={draft.model}
                placeholder={intl.formatMessage({ id: "chat.externalAgent.modelPlaceholder" })}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                data-testid="external-agent-bind-model"
              />
            </Field>
          </section>
        ) : null}

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
