import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildDeterministicHandoffMarkdown,
  buildSessionHandoffPrompt,
  buildSessionHandoffTranscript,
} from "@zcode/shared/session-handoff";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export type SessionHandoffMode = "summary" | "full";

/**
 * 会话交接：把当前会话整理成一份可直接粘给另一个 agent / 人的 Markdown。
 *
 * - 智能摘要：复用 handoff 语义的固定小节，走一次 workspace generateText；
 * - 完整导出：确定性模板，零模型、离线可用；
 * - 摘要失败/无模型时自动回落到完整导出，仍然给出可用产物。
 */
export function SessionHandoffDialog({
  open,
  onClose,
  rows,
  title,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  selection,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly ConversationRow[];
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  selection?: ModelSelection | null;
}) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const [mode, setMode] = useState<SessionHandoffMode>("summary");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [copied, setCopied] = useState(false);
  const text = (id: string) => intl.formatMessage({ id });

  const deterministic = useMemo(
    () => buildDeterministicHandoffMarkdown(rows, title),
    [rows, title],
  );

  const generateSummary = useCallback(async () => {
    const agentService = services?.zcodeAgentService;
    if (!selection || !agentService) {
      setContent(deterministic);
      setStatus("fallback");
      return;
    }
    setStatus("loading");
    const transcript = buildSessionHandoffTranscript(rows);
    if (!transcript.trim()) {
      setContent(deterministic);
      setStatus("ready");
      return;
    }
    try {
      const result = await agentService.generateWorkspaceText({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        selection,
        prompt: buildSessionHandoffPrompt(transcript, title),
        querySource: "session_handoff",
        operationId: `session-handoff:${Date.now().toString(36)}`,
        maxOutputTokens: 4_000,
        requestTimeoutMs: 60_000,
      });
      const generated = result.text.trim();
      if (!generated) throw new Error("empty handoff summary");
      setContent(generated);
      setStatus("ready");
    } catch (error) {
      logger.warn("[SessionHandoff] 摘要生成失败，回落完整导出", {
        error: error instanceof Error ? error.message : String(error),
      });
      setContent(deterministic);
      setStatus("fallback");
    }
  }, [
    deterministic,
    remoteSessionId,
    rows,
    selection,
    services,
    title,
    workspaceIdentity,
    workspacePath,
  ]);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    if (mode === "full") {
      setContent(deterministic);
      setStatus("ready");
      return;
    }
    void generateSummary();
  }, [open, mode, deterministic, generateSummary]);

  const copy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch (error) {
      logger.warn("[SessionHandoff] 复制失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [content]);

  const save = useCallback(async () => {
    if (!content || !platform?.saveFile) return;
    const safeTitle = title.replace(/[\\/:*?"<>|]+/gu, "-").slice(0, 80) || "session";
    await platform.saveFile({
      data: new TextEncoder().encode(content).buffer,
      suggestedName: `${safeTitle}-handoff.md`,
    });
  }, [content, platform, title]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-w-3xl" data-testid="v4-session-handoff-dialog">
        <DialogHeader>
          <DialogTitle>{text("sessionHandoff.title")}</DialogTitle>
          <DialogDescription>{text("sessionHandoff.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "summary" ? "secondary" : "ghost"}
            onClick={() => setMode("summary")}
          >
            {text("sessionHandoff.mode.summary")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "full" ? "secondary" : "ghost"}
            onClick={() => setMode("full")}
          >
            {text("sessionHandoff.mode.full")}
          </Button>
          <span className="min-w-0 flex-1" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void generateSummary()}
            disabled={status === "loading" || mode === "full"}
          >
            {text("sessionHandoff.regenerate")}
          </Button>
        </div>

        {status === "fallback" ? (
          <p className="text-ui-sm text-warning" data-testid="v4-session-handoff-fallback">
            {text("sessionHandoff.fallback")}
          </p>
        ) : null}

        {status === "loading" ? (
          <p className="text-ui-sm text-muted-foreground">{text("sessionHandoff.loading")}</p>
        ) : null}

        <Textarea
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setStatus("ready");
          }}
          className="min-h-[320px] font-mono text-ui-sm"
          placeholder={text("sessionHandoff.placeholder")}
          data-testid="v4-session-handoff-content"
        />

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {text("common.close")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void copy()} disabled={!content}>
            {copied ? text("sessionHandoff.copied") : text("sessionHandoff.copy")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!content || !platform?.saveFile}
          >
            {text("sessionHandoff.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
