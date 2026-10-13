import { useCallback } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { buildPromptOptimizerContext } from "@/v4/composer/promptOptimizerContext.js";
import {
  MAX_PROMPT_OPTIMIZER_DRAFT_CHARS,
  buildPromptOptimizerMessages,
  parsePromptOptimizerResult,
  validateOptimizedPrompt,
  type PromptOptimizerContextRange,
  type PromptOptimizerMode,
} from "@/v4/composer/promptOptimizerPrompt.js";
import {
  getPromptOptimizerState,
  invalidatePromptOptimizerScope,
  isCurrentPromptOptimizerRequest,
  isPromptOptimizerPending,
  nextPromptOptimizerRequestId,
  patchPromptOptimizerState,
  setPromptOptimizerState,
  usePromptOptimizerState,
  type PromptOptimizerState,
} from "@/v4/composer/promptOptimizerStore.js";

/**
 * 提示词优化的数据层：把输入框草稿经**一次**会话外 workspace generateText 请求改写。
 *
 * 与旧实现的区别（都是修掉真实缺陷，不是风格调整）：
 * - 不再用工作区级 `promptHistory` 当上下文：它跨会话，可能把别的会话里「提过但没确认」
 *   的方案写成已确认要求；改为只从当前会话窗口抽有限轮次。
 * - 结果不再直接落盘到输入框：返回**结构化候选 + 警告**，由用户确认后替换（撤销点在 Composer）。
 * - 传唯一 operationId，可在飞取消，且迟到结果不会回写。
 */

const PROMPT_OPTIMIZER_QUERY_SOURCE = "prompt_optimizer";
const OPTIMIZE_REQUEST_TIMEOUT_MS = 30_000;

export interface PromptOptimizerRequest {
  draft: string;
  /** 发起时的草稿版本凭据（内容修订号，不是文本本身）；应用候选前用它确认输入框没变过。 */
  version: string;
  mode: PromptOptimizerMode;
  contextRange: PromptOptimizerContextRange;
  /** 当前会话窗口（只读，不回溯分页）。 */
  rows: readonly ConversationRow[];
  /** 当前会话模型选择；调用方已在自家 ModelSelectionView 里解析过。 */
  selection: ModelSelection | null;
  /**
   * 所选模型声明的推理档位；`null` = 该模型不在当前视图里（已下线/换提供方）。
   * 由调用方传入而不是在 hook 里 await getView()：await 会把「分配请求身份」推迟到
   * 第一个挂起点之后，造成重复请求与取消空窗。
   */
  modelReasoningLevels: readonly string[] | null;
  /**
   * 组件本地的 ModelSelectionView 是否已就绪。
   * 用于区分两种完全不同的失败：视图还没加载完（稍后重试即可）与模型真的不在列表里
   * （需要用户重新选择）。缺了这个标志，视图未就绪会被误报成「模型已不可用」。
   */
  modelViewReady: boolean;
  /** 发起时草稿是否含 mention/附件等纯文本无法重建的内容（决定能否自动替换）。 */
  richContext: boolean;
}

type SelectionResolution =
  | { ok: true; selection: ModelSelection; selectionKey: string }
  | { ok: false; reason: "no-model" | "view-loading" | "unknown-model" };

/** 导出仅为单测：三态失败原因的判定必须可验证，不能只靠 UI 手测。 */
export function resolveOptimizerSelection(request: PromptOptimizerRequest): SelectionResolution {
  const chosen = request.selection;
  if (!chosen) {
    return { ok: false, reason: "no-model" };
  }
  if (!request.modelViewReady) {
    return { ok: false, reason: "view-loading" };
  }
  const levels = request.modelReasoningLevels;
  if (levels === null) {
    // 视图已就绪却找不到该模型：已下线/换提供方。明确报错，不静默改用别的模型。
    return { ok: false, reason: "unknown-model" };
  }
  const current = chosen.options?.reasoningLevel;
  const baseKey = `${chosen.providerId}/${chosen.modelId}`;
  if (levels.length === 0) {
    // 模型不接受推理档：带档位会被 adapters 校验拒绝，直接去掉。
    return {
      ok: true,
      selection: { providerId: chosen.providerId, modelId: chosen.modelId },
      selectionKey: baseKey,
    };
  }
  // 部分渠道强制要求推理档；缺省/失效时补最低公开档（与辅助快速通道一致）。
  const reasoningLevel = current && levels.includes(current) ? current : levels[0]!;
  return {
    ok: true,
    selection: {
      providerId: chosen.providerId,
      modelId: chosen.modelId,
      options: { reasoningLevel },
    },
    selectionKey: `${baseKey}#${reasoningLevel}`,
  };
}

const OPTIMIZER_MODEL_STORAGE_KEY = "zcode-prompt-optimizer-model";

/** 用户指定的优化模型（全局偏好）；null = 跟随会话模型。 */
export function readStoredOptimizerModelSelection(): ModelSelection | null {
  try {
    const raw = localStorage.getItem(OPTIMIZER_MODEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ModelSelection).providerId === "string" &&
      typeof (parsed as ModelSelection).modelId === "string" &&
      (parsed as ModelSelection).providerId.trim() &&
      (parsed as ModelSelection).modelId.trim()
    ) {
      // 保留推理档：丢弃它会让「需要推理档」的模型在下次选择时失效。
      const reasoningLevel = (parsed as ModelSelection).options?.reasoningLevel;
      return {
        providerId: (parsed as ModelSelection).providerId,
        modelId: (parsed as ModelSelection).modelId,
        ...(typeof reasoningLevel === "string" && reasoningLevel.trim()
          ? { options: { reasoningLevel } }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredOptimizerModelSelection(selection: ModelSelection | null): void {
  try {
    if (!selection) {
      localStorage.removeItem(OPTIMIZER_MODEL_STORAGE_KEY);
    } else {
      localStorage.setItem(OPTIMIZER_MODEL_STORAGE_KEY, JSON.stringify(selection));
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃持久化，选择仍在本会话内生效。
  }
}

export interface UsePromptOptimizerOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 草稿 scope：sessionId 或新任务的 __draft__。 */
  scopeId: string;
  locale: string;
}

export function usePromptOptimizer(options: UsePromptOptimizerOptions) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const scopeKey = `${workspaceKey}\0${options.scopeId}`;
  const state = usePromptOptimizerState(scopeKey);

  const buildTarget = useCallback(
    () => ({
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    }),
    [options.remoteSessionId, options.workspaceIdentity, options.workspacePath],
  );

  const fail = useCallback(
    (requestId: number, errorReason: string, toastId: string, detail?: string): void => {
      patchPromptOptimizerState(scopeKey, requestId, { status: "error", errorReason });
      toast(
        intl.formatMessage({ id: toastId }) + (detail ? ` · ${detail.slice(0, 120)}` : ""),
      );
    },
    [intl, scopeKey],
  );

  const optimize = useCallback(
    async (request: PromptOptimizerRequest): Promise<void> => {
      const agentService = services?.zcodeAgentService;
      const draft = request.draft.trim();
      // 单飞检查必须同步完成：任何 await 之后再判 pending 都挡不住连点。
      if (!agentService || !draft || isPromptOptimizerPending(scopeKey)) {
        return;
      }
      if (draft.length > MAX_PROMPT_OPTIMIZER_DRAFT_CHARS) {
        toast(intl.formatMessage({ id: "chat.composer.optimizePromptTooLong" }));
        return;
      }
      const resolution = resolveOptimizerSelection(request);
      if (!resolution.ok) {
        toast(
          intl.formatMessage({
            id:
              resolution.reason === "no-model"
                ? "chat.composer.optimizePromptNoModel"
                : resolution.reason === "view-loading"
                  ? "chat.composer.optimizePromptViewLoading"
                  : "chat.composer.optimizePromptUnknownModel",
          }),
        );
        return;
      }
      const context = buildPromptOptimizerContext(
        request.contextRange === "conversation" ? request.rows : [],
      );
      // 复用键必须含模型选择与上下文材料：否则换模型、或会话里多了关键对话后，
      // 再点一次仍会拿到旧结果。
      const cacheKey = [
        resolution.selectionKey,
        request.mode,
        request.contextRange,
        request.version,
        `${draft.length}:${context.text.length}:${context.text}`,
      ].join("\u0001");
      const existing = getPromptOptimizerState(scopeKey);
      if (existing?.status === "ready" && existing.cacheKey === cacheKey) {
        return;
      }

      const requestId = nextPromptOptimizerRequestId(scopeKey);
      const operationId = `prompt-optimizer:${requestId}:${Math.random().toString(36).slice(2, 10)}`;
      const startedAt = Date.now();
      setPromptOptimizerState(scopeKey, {
        status: "pending",
        requestId,
        operationId,
        baseDraft: draft,
        baseVersion: request.version,
        mode: request.mode,
        contextRange: request.contextRange,
        startedAt,
        cacheKey,
        richContext: request.richContext,
      });

      try {
        const result = await agentService.generateWorkspaceText({
          ...buildTarget(),
          selection: resolution.selection,
          messages: buildPromptOptimizerMessages({
            draft,
            projectName: getPathLeaf(options.workspacePath) || options.workspacePath,
            mode: request.mode,
            contextRange: request.contextRange,
            context,
          }),
          querySource: PROMPT_OPTIMIZER_QUERY_SOURCE,
          operationId,
          // 超时只能走协议层 requestTimeoutMs：AbortSignal 不可跨 RPC 序列化。
          requestTimeoutMs: OPTIMIZE_REQUEST_TIMEOUT_MS,
        });
        // 迟到回写闸门：被取消/被新请求取代/已放弃时，结果直接丢弃。
        if (!isCurrentPromptOptimizerRequest(scopeKey, requestId)) {
          return;
        }
        const parsed = parsePromptOptimizerResult(result.text);
        if (!parsed.ok) {
          fail(
            requestId,
            parsed.reason,
            "chat.composer.optimizePromptParseFailed",
            parsed.reason,
          );
          return;
        }
        const durationMs = Date.now() - startedAt;
        patchPromptOptimizerState(scopeKey, requestId, {
          status: "ready",
          optimized: parsed.optimizedPrompt,
          unresolved: parsed.unresolved,
          warnings: validateOptimizedPrompt(draft, parsed.optimizedPrompt),
          durationMs,
          operationId: null,
        });
        logger.info("[PromptOptimizer] 提示词优化完成", {
          workspacePath: options.workspacePath,
          providerId: result.selection.providerId,
          model: result.selection.modelId,
          mode: request.mode,
          contextRange: request.contextRange,
          contextChars: context.text.length,
          contextTruncated: context.truncated,
          draftChars: draft.length,
          resultChars: parsed.optimizedPrompt.length,
          durationMs,
        });
      } catch (error) {
        if (!isCurrentPromptOptimizerRequest(scopeKey, requestId)) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn("[PromptOptimizer] 提示词优化失败", {
          workspacePath: options.workspacePath,
          mode: request.mode,
          durationMs: Date.now() - startedAt,
          error: detail,
        });
        fail(requestId, detail, "chat.composer.optimizePromptFailed", detail);
      }
    },
    [buildTarget, fail, intl, options.workspacePath, scopeKey, services],
  );

  const cancel = useCallback((): void => {
    const current = getPromptOptimizerState(scopeKey);
    if (!current || current.status !== "pending") {
      return;
    }
    // 先失效序号，再通知后端；顺序保证迟到结果不可能回写。
    invalidatePromptOptimizerScope(scopeKey);
    const operationId = current.operationId;
    setPromptOptimizerState(scopeKey, { ...current, status: "cancelled", operationId: null });
    if (operationId) {
      void services?.zcodeAgentService
        .cancelWorkspaceGenerateText({
          ...buildTarget(),
          querySource: PROMPT_OPTIMIZER_QUERY_SOURCE,
          operationId,
        })
        .catch(() => undefined);
    }
  }, [buildTarget, scopeKey, services]);

  const dismiss = useCallback((): void => {
    invalidatePromptOptimizerScope(scopeKey);
    setPromptOptimizerState(scopeKey, null);
  }, [scopeKey]);

  /**
   * 记录撤销点（应用候选时由 Composer 调用）：appliedText 是刚写入输入框的正文，
   * undoText/undoEditorStateJson 是替换前的编辑器快照。前者让 Composer 判定
   * 「用户是否还在这次的替换状态上」，后者让撤销能还原 mention/格式而不只是纯文本。
   */
  const markApplied = useCallback(
    (appliedText: string, undo: { text: string; editorStateJson?: string }): void => {
      const current = getPromptOptimizerState(scopeKey);
      if (!current) {
        return;
      }
      patchPromptOptimizerState(scopeKey, current.requestId, {
        appliedText,
        undoText: undo.text,
        undoEditorStateJson: undo.editorStateJson,
      });
    },
    [scopeKey],
  );

  /** 取回撤销快照并清除撤销点；无撤销点时返回 null。 */
  const consumeUndo = useCallback((): {
    text: string;
    editorStateJson?: string;
  } | null => {
    const current = getPromptOptimizerState(scopeKey);
    const undoText = current?.undoText;
    if (!current || undoText === undefined) {
      return null;
    }
    const undoEditorStateJson = current.undoEditorStateJson;
    patchPromptOptimizerState(scopeKey, current.requestId, {
      appliedText: undefined,
      undoText: undefined,
      undoEditorStateJson: undefined,
    });
    return {
      text: undoText,
      ...(undoEditorStateJson === undefined ? {} : { editorStateJson: undoEditorStateJson }),
    };
  }, [scopeKey]);

  const clearUndo = useCallback((): void => {
    const current = getPromptOptimizerState(scopeKey);
    if (current && (current.appliedText !== undefined || current.undoText !== undefined)) {
      patchPromptOptimizerState(scopeKey, current.requestId, {
        appliedText: undefined,
        undoText: undefined,
        undoEditorStateJson: undefined,
      });
    }
  }, [scopeKey]);

  return {
    state: state as PromptOptimizerState | null,
    optimizing: state?.status === "pending",
    optimize,
    cancel,
    dismiss,
    markApplied,
    consumeUndo,
    clearUndo,
  };
}
