import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  getSharedWebRemoteControlPoller,
  isSameWebRemoteControlStatus,
} from "@/hooks/sharedWebRemoteControlStatus.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

const IDLE_STATUS: WebRemoteControlStatus = { status: "idle" };
const noopSubscribe = () => () => {};
const idleSnapshot = () => IDLE_STATUS;

export function useWebRemoteControlStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): WebRemoteControlStatus {
  const platform = useOptionalPlatform();
  // 性能开关 dedupedIdlePollingEnabled（默认关闭）：开启后同一 platform 的多个
  // 订阅合并为单 interval + 单事件订阅；关闭时逐实例路径与原实现完全一致。
  const dedupedIdlePollingEnabled = useZCodeStoreWithDefault(
    (state) => state.dedupedIdlePollingEnabled,
    false,
  );
  const useSharedPoller = dedupedIdlePollingEnabled && enabled && Boolean(platform);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!useSharedPoller || !platform) return noopSubscribe();
      return getSharedWebRemoteControlPoller(platform, intervalMs).subscribe(onChange);
    },
    [intervalMs, platform, useSharedPoller],
  );
  const getSnapshot = useCallback(() => {
    if (!useSharedPoller || !platform) return IDLE_STATUS;
    return getSharedWebRemoteControlPoller(platform, intervalMs).getStatus();
  }, [intervalMs, platform, useSharedPoller]);
  const sharedStatus = useSyncExternalStore(subscribe, getSnapshot, idleSnapshot);

  const [status, setStatus] = useState<WebRemoteControlStatus>({ status: "idle" });

  useEffect(() => {
    if (useSharedPoller) return; // 共享路径由 useSyncExternalStore 驱动，不叠一份实例轮询。
    if (!enabled || !platform) {
      setStatus({ status: "idle" });
      return;
    }

    let disposed = false;

    const applyStatus = (nextStatus: WebRemoteControlStatus) => {
      if (disposed) {
        return;
      }
      setStatus((currentStatus) =>
        isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
      );
    };

    const syncStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        applyStatus(nextStatus);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Bugfix: 远控连接状态来自 main/relay，桌面 UI 必须轮询才能感知手机打开的 task。
        // 轮询失败属于高频诊断信息，只走 debug，避免生产日志随刷新频率增长。
        logger.debug("[useWebRemoteControlStatus] 同步 Web 远程控制状态失败", {
          error: message,
        });
      }
    };

    void syncStatus();
    const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.((nextStatus) => {
      // Bugfix: start/refresh 后如果只等 1s 轮询，手机立刻扫码时 main 还没拿到 renderer 同步的 task 快照。
      // main 已经是远控 session/transport 状态事实源，这里优先消费事件推送，轮询只保留为旧平台兜底。
      applyStatus(nextStatus);
    });
    const intervalId = window.setInterval(() => {
      void syncStatus();
    }, intervalMs);

    return () => {
      disposed = true;
      disposeStatusChanged?.();
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs, platform, useSharedPoller]);

  return useSharedPoller ? sharedStatus : status;
}
