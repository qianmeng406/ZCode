import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSelection } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

const DEFAULT_IDLE_MS = 900;

/**
 * 输入预测（ghost hint）的 UI 侧接入。
 *
 * 服务端契约已存在（`v4/conversation/inputPrediction`）：返回"接在草稿后面的续写"。
 * 这里只负责节奏与过期控制：
 * - 停止输入 `idleMs` 后才请求，避免逐键调用模型；
 * - `revision` 用会话 revision（不是草稿 revision），迟到响应按请求号丢弃；
 * - 同一份草稿被用户忽略后不再重复请求，直到下一轮输入或会话推进。
 */
export function canRequestInputPrediction(params: {
  enabled: boolean;
  sessionId: string | null;
  blocked: boolean;
}): boolean {
  return params.enabled && params.sessionId !== null && !params.blocked;
}

export function useInputPrediction(params: {
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string | null;
  revision: number;
  draft: string;
  /** 设置页为输入预测指定的模型；null/缺省 = 会话当前模型。 */
  selection?: ModelSelection | null;
  /** 附件/引用等富草稿：无法安全续写，直接不请求。 */
  blocked: boolean;
  idleMs?: number;
}): { candidate: string | null; dismiss: () => void } {
  const services = useOptionalServices();
  const [candidate, setCandidate] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const dismissedKeyRef = useRef<string | null>(null);
  const idleMs = params.idleMs ?? DEFAULT_IDLE_MS;
  const draftKey = `${params.revision}\u0000${params.draft}`;

  useEffect(() => {
    setCandidate(null);
  }, [draftKey, params.enabled]);

  useEffect(() => {
    if (
      !canRequestInputPrediction({
        enabled: params.enabled,
        sessionId: params.sessionId,
        blocked: params.blocked,
      })
    ) {
      return;
    }
    const sessionId = params.sessionId;
    const agentService = services?.zcodeAgentService;
    if (
      !sessionId ||
      !agentService ||
      typeof agentService.conversationInputPredictionV4 !== "function"
    ) {
      return;
    }
    if (dismissedKeyRef.current === draftKey) return;

    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const draft = params.draft;
    const requestId = `input-prediction-${seq}`;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await agentService.conversationInputPredictionV4({
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            ...(params.selection ? { selection: params.selection } : {}),
            sessionId,
            revision: params.revision,
            ...(draft.trim() ? { draft } : {}),
            requestId,
          });
          if (requestSeqRef.current !== seq) return;
          const best = result.decision === "show" ? result.candidates[0] : undefined;
          if (best) setCandidate(best.text);
        } catch (error) {
          // 预测是建议，不是状态：失败静默，不影响输入。
          logger.debug?.("[InputPrediction] 预测失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, idleMs);

    return () => {
      clearTimeout(timer);
      if (requestSeqRef.current === seq) requestSeqRef.current += 1;
    };
  }, [
    draftKey,
    idleMs,
    params.blocked,
    params.draft,
    params.enabled,
    params.revision,
    params.selection,
    params.sessionId,
    params.workspacePath,
    params.workspaceIdentity,
    params.remoteSessionId,
    services,
  ]);

  const dismiss = useCallback(() => {
    dismissedKeyRef.current = draftKey;
    setCandidate(null);
  }, [draftKey]);

  return { candidate, dismiss };
}
