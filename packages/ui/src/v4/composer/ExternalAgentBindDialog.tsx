// 绑定外部 coding agent 的对话框。
//
// 这是整条功能唯一的入口：没有它，bindExternalAgent 命令面就只是协议里的一条
// 死路径。表单只收静态执行配置（label/driver/command/permissionMode），因为
// 绑定会落 session entry 并跨重启生效——运行态（进程句柄、外部 session_id）不进这里。
//
// 表单只做"能提交"级别的校验，不做路径白名单：绑定是用户的显式操作，与模型
// 动态驱动的 Bash 调用性质不同，过度校验只会挡住合法的自定义 CLI。
import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BindExternalAgentPayload } from "@/v4/composer/externalAgentCommands.js";

export interface ExternalAgentBindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: BindExternalAgentPayload) => Promise<void>;
}

const DEFAULT_BINDING: BindExternalAgentPayload = {
  label: "codebuddy",
  driver: "claude-family",
  command: "codebuddy",
  promptDelivery: "argv-append",
  permissionMode: "acceptEdits",
};

function ExternalAgentBindDialogImpl({
  open,
  onOpenChange,
  onSubmit,
}: ExternalAgentBindDialogProps) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<BindExternalAgentPayload>(DEFAULT_BINDING);
  const [pending, setPending] = useState(false);

  const handleSubmit = useCallback(() => {
    if (pending) return;
    if (!draft.label.trim() || !draft.command.trim()) return;
    setPending(true);
    void onSubmit({
      ...draft,
      label: draft.label.trim(),
      command: draft.command.trim(),
      permissionMode: draft.permissionMode?.trim() || undefined,
    }).finally(() => setPending(false));
  }, [draft, onSubmit, pending]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="external-agent-bind-dialog">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.externalAgent.bindTitle" })}</DialogTitle>
        </DialogHeader>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "chat.externalAgent.bindDescription" })}
        </p>
        <div className="flex flex-col gap-3">
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
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              data-testid="external-agent-bind-command"
            />
          </Field>
          <Field label={intl.formatMessage({ id: "chat.externalAgent.bindPermissionMode" })}>
            <Input
              value={draft.permissionMode ?? ""}
              placeholder="acceptEdits"
              onChange={(event) => setDraft({ ...draft, permissionMode: event.target.value })}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending || !draft.label.trim() || !draft.command.trim()}
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
