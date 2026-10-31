import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeOracleReviewRecord } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { buildReviewQueue, openReviewQueueItems, type ReviewQueueItem } from "./reviewQueue.js";
import {
  addReviewedQueueKeys,
  clearReviewedQueueKeys,
  readReviewedQueueKeys,
} from "./oracleReviewQueueState.js";

const QUEUE_RECORD_LIMIT = 50;

export interface OracleReviewQueueState {
  items: ReviewQueueItem[];
  openItems: ReviewQueueItem[];
  reviewedKeys: ReadonlySet<string>;
  loading: boolean;
  markReviewed: (keys: readonly string[]) => void;
  markAllReviewed: () => void;
  clearReviewed: () => void;
}

/**
 * 侧栏队列的数据接入：独立取 50 条审查记录（协议上限），不挤占历史卡片区
 * 现有的 10 条展示预算。`refreshToken` 由历史订阅传入，新审查落盘后刷新。
 *
 * 存储面缺席（旧宿主 / 无 agent service）时保持空队列，不报错。
 */
export function useOracleReviewQueue(params: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  refreshToken?: unknown;
}): OracleReviewQueueState {
  const services = useOptionalServices();
  const [records, setRecords] = useState<ZCodeOracleReviewRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [reviewedKeys, setReviewedKeys] = useState<ReadonlySet<string>>(() =>
    readReviewedQueueKeys(params.workspaceKey, params.sessionId),
  );
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setReviewedKeys(readReviewedQueueKeys(params.workspaceKey, params.sessionId));
  }, [params.workspaceKey, params.sessionId]);

  useEffect(() => {
    const agentService = services?.zcodeAgentService;
    if (!agentService || typeof agentService.listOracleReviewRecords !== "function") {
      setRecords([]);
      return;
    }
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    let disposed = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await agentService.listOracleReviewRecords({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          sessionId: params.sessionId,
          limit: QUEUE_RECORD_LIMIT,
        });
        if (disposed || requestSeqRef.current !== seq) return;
        setRecords(result.unavailable ? [] : result.records);
      } catch (error) {
        if (disposed || requestSeqRef.current !== seq) return;
        logger.warn("[OracleReview] 审查队列读取失败", {
          sessionId: params.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        setRecords([]);
      } finally {
        if (!disposed && requestSeqRef.current === seq) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    services,
    params.sessionId,
    params.workspacePath,
    params.workspaceIdentity,
    params.remoteSessionId,
    params.refreshToken,
  ]);

  const items = useMemo(() => buildReviewQueue(records), [records]);
  const openItems = useMemo(() => openReviewQueueItems(items, reviewedKeys), [items, reviewedKeys]);

  const markReviewed = useCallback(
    (keys: readonly string[]) => {
      if (keys.length === 0) return;
      setReviewedKeys(addReviewedQueueKeys(params.workspaceKey, params.sessionId, keys));
    },
    [params.workspaceKey, params.sessionId],
  );

  const markAllReviewed = useCallback(() => {
    markReviewed(items.map((item) => item.key));
  }, [items, markReviewed]);

  const clearReviewed = useCallback(() => {
    setReviewedKeys(clearReviewedQueueKeys(params.workspaceKey, params.sessionId));
  }, [params.workspaceKey, params.sessionId]);

  return {
    items,
    openItems,
    reviewedKeys,
    loading,
    markReviewed,
    markAllReviewed,
    clearReviewed,
  };
}
