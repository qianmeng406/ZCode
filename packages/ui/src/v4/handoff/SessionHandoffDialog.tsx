import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function handoffFileName(title: string): string {
  const safeTitle = title.replace(/[\\/:*?"<>|]+/gu, "-").slice(0, 80) || "session";
  return `${safeTitle}-handoff.md`;
}

/**
 * 复制正文：优先 Clipboard API；非安全上下文/无权限时用 execCommand 兜底，
 * 两者都失败才返回 false（调用方据此提示用户手动全选）。
 */
async function copyPlainText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 继续走兜底。
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.("copy") ?? false;
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/** Web 端没有原生另存为对话框时的下载兜底；jsdom/受限环境返回 false。 */
function downloadTextFile(value: string, fileName: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  try {
    const url = URL.createObjectURL(new Blob([value], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

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
  historyLoaded = true,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly ConversationRow[];
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  selection?: ModelSelection | null;
  /** 完整历史是否已补齐；false 时摘要先等待，避免只摘要到最近一窗。 */
  historyLoaded?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const [mode, setMode] = useState<SessionHandoffMode>("summary");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<"copyFailed" | "saveFailed" | null>(null);
  const [fallbackReason, setFallbackReason] = useState<"no-model" | "error" | null>(null);
  const [edited, setEdited] = useState(false);
  const text = (id: string) => intl.formatMessage({ id });

  const deterministic = useMemo(
    () => buildDeterministicHandoffMarkdown(rows, title),
    [rows, title],
  );

  const generateSummary = useCallback(async () => {
    const agentService = services?.zcodeAgentService;
    if (!selection || !agentService) {
      setContent(deterministic);
      setFallbackReason("no-model");
      setStatus("fallback");
      return;
    }
    // 每次生成一个序号 + 固定 operationId：取消/重开后迟到的结果按序号丢弃，
    // 后端在飞请求经 cancelWorkspaceGenerateText 精确命中（审查卡片 ✕ 同款）。
    const seq = ++generationSeqRef.current;
    const operationId = `session-handoff:${seq}-${Date.now().toString(36)}`;
    operationIdRef.current = operationId;
    setStatus("loading");
    const transcript = buildSessionHandoffTranscript(rows);
    if (!transcript.trim()) {
      if (generationSeqRef.current === seq) {
        setContent(deterministic);
        setStatus("ready");
      }
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
        operationId,
        maxOutputTokens: 4_000,
        requestTimeoutMs: 60_000,
      });
      if (generationSeqRef.current !== seq) return;
      const generated = result.text.trim();
      if (!generated) throw new Error("empty handoff summary");
      setContent(generated);
      setStatus("ready");
    } catch (error) {
      if (generationSeqRef.current !== seq) return;
      logger.warn("[SessionHandoff] 摘要生成失败，回落完整导出", {
        error: error instanceof Error ? error.message : String(error),
      });
      setContent(deterministic);
      setFallbackReason("error");
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

  // 交接是显式动作：智能摘要不自动调用模型，等用户点「生成摘要」。
  // 打开时只取消可能还在飞的上一轮请求，避免模型调用在后台空跑。
  const generationSeqRef = useRef(0);
  const operationIdRef = useRef<string | null>(null);

  /** 取消在飞生成：先失效序号（迟到结果丢弃），再通知后端精确取消。 */
  const cancelGeneration = useCallback(() => {
    generationSeqRef.current += 1;
    const operationId = operationIdRef.current;
    operationIdRef.current = null;
    if (!operationId) return;
    void services?.zcodeAgentService
      .cancelWorkspaceGenerateText?.({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        querySource: "session_handoff",
        operationId,
      })
      .catch(() => undefined);
  }, [remoteSessionId, services, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!open) {
      setEdited(false);
      setFallbackReason(null);
      setNotice(null);
      setCopied(false);
      // 关闭即取消在飞生成；已生成/已编辑的内容保留，误关后不用重做。
      cancelGeneration();
    }
  }, [open, cancelGeneration]);

  // 完整导出是确定性模板：历史继续补拉/流式增长时刷新内容，但不覆盖用户编辑。
  useEffect(() => {
    if (!open || mode !== "full" || edited) return;
    setContent(deterministic);
  }, [open, mode, deterministic, edited]);

  const copy = useCallback(async () => {
    if (!content) return;
    const ok = await copyPlainText(content);
    setCopied(ok);
    setNotice(ok ? null : "copyFailed");
  }, [content]);

  const save = useCallback(async () => {
    if (!content) return;
    const fileName = handoffFileName(title);
    if (platform?.saveFile) {
      try {
        const result = await platform.saveFile({
          data: new TextEncoder().encode(content).buffer,
          suggestedName: fileName,
        });
        if (result.success || result.canceled) {
          setNotice(null);
          return;
        }
      } catch (error) {
        logger.warn("[SessionHandoff] 另存为失败，改用下载", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Web / 无原生另存为：交给浏览器下载；下载也不可用时退回复制并提示。
    if (downloadTextFile(content, fileName)) {
      setNotice(null);
      return;
    }
    const ok = await copyPlainText(content);
    setCopied(ok);
    setNotice("saveFailed");
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
          {status === "loading" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                cancelGeneration();
                setStatus("idle");
                setContent("");
              }}
              data-testid="v4-session-handoff-cancel"
            >
              {text("sessionHandoff.cancel")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void generateSummary()}
              disabled={mode === "full" || !historyLoaded}
              data-testid="v4-session-handoff-generate"
            >
              {status === "idle" && !content
                ? text("sessionHandoff.generate")
                : text("sessionHandoff.regenerate")}
            </Button>
          )}
        </div>

        {!historyLoaded ? (
          <p className="text-ui-sm text-muted-foreground" data-testid="v4-session-handoff-waiting">
            {text("sessionHandoff.loadingHistory")}
          </p>
        ) : null}

        {status === "fallback" ? (
          <p className="text-ui-sm text-warning" data-testid="v4-session-handoff-fallback">
            {text(
              fallbackReason === "no-model"
                ? "sessionHandoff.fallbackNoModel"
                : "sessionHandoff.fallback",
            )}
          </p>
        ) : null}

        {status === "loading" ? (
          <p className="text-ui-sm text-muted-foreground">{text("sessionHandoff.loading")}</p>
        ) : null}

        {notice ? (
          <p className="text-ui-sm text-warning" data-testid={`v4-session-handoff-${notice}`}>
            {text(
              notice === "copyFailed" ? "sessionHandoff.copyFailed" : "sessionHandoff.saveFailed",
            )}
          </p>
        ) : null}

        <Textarea
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setStatus("ready");
            setEdited(true);
            setCopied(false);
            setNotice(null);
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
          <Button type="button" onClick={() => void save()} disabled={!content}>
            {text("sessionHandoff.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
