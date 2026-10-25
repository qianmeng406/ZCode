// Web 远控状态轮询的共享层（性能开关 dedupedIdlePollingEnabled）。
// 同一 platform 的 N 个 useWebRemoteControlStatus 订阅合并为单 interval + 单事件
// 订阅；状态在共享层做一次相等性去重，扇出给 useSyncExternalStore（引用稳定）。
// 最后一个订阅退出即整体拆除（interval/事件订阅/注册表条目），下次订阅重建。
import type { WebRemoteControlStatus } from "@zcode/shared";
import { logger } from "@/logger.js";

export function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileTaskView?.taskId === right.mobileTaskView?.taskId &&
    left.mobileTaskView?.workspacePath === right.mobileTaskView?.workspacePath &&
    left.mobileTaskView?.workspaceIdentity === right.mobileTaskView?.workspaceIdentity &&
    left.mobileTaskView?.remoteSessionId === right.mobileTaskView?.remoteSessionId &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

/** 共享轮询需要的 platform 面（与 IPlatformService 相关子集结构兼容，便于测试注入）。 */
export interface SharedWebRemoteControlPlatform {
  getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;
  onWebRemoteControlStatusChanged?: (
    listener: (status: WebRemoteControlStatus) => void,
  ) => (() => void) | undefined;
}

export interface SharedWebRemoteControlTimerHost {
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(handle: number): void;
}

const defaultTimerHost: SharedWebRemoteControlTimerHost = {
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (handle) => window.clearInterval(handle),
};

export interface SharedWebRemoteControlPoller {
  subscribe(onChange: () => void): () => void;
  getStatus(): WebRemoteControlStatus;
}

const pollers = new WeakMap<object, SharedWebRemoteControlPoller>();

export function getSharedWebRemoteControlPoller(
  platform: SharedWebRemoteControlPlatform,
  intervalMs: number,
  timerHost: SharedWebRemoteControlTimerHost = defaultTimerHost,
): SharedWebRemoteControlPoller {
  const existing = pollers.get(platform);
  if (existing) return existing;

  let status: WebRemoteControlStatus = { status: "idle" };
  const listeners = new Set<() => void>();
  let intervalHandle: number | null = null;
  let refCount = 0;

  const applyStatus = (nextStatus: WebRemoteControlStatus) => {
    if (isSameWebRemoteControlStatus(status, nextStatus)) return;
    status = nextStatus;
    for (const listener of listeners) listener();
  };
  const syncStatus = async () => {
    try {
      applyStatus(await platform.getWebRemoteControlStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 与逐实例路径同口径：轮询失败是高频诊断信息，只走 debug。
      logger.debug("[sharedWebRemoteControlStatus] 同步 Web 远程控制状态失败", {
        error: message,
      });
    }
  };
  const disposeStatusChanged = platform.onWebRemoteControlStatusChanged?.(applyStatus);

  const poller: SharedWebRemoteControlPoller = {
    subscribe(onChange) {
      refCount += 1;
      listeners.add(onChange);
      if (intervalHandle === null) {
        void syncStatus();
        intervalHandle = timerHost.setInterval(() => {
          void syncStatus();
        }, intervalMs);
      }
      return () => {
        listeners.delete(onChange);
        refCount -= 1;
        if (refCount > 0 || intervalHandle === null) return;
        timerHost.clearInterval(intervalHandle);
        intervalHandle = null;
        disposeStatusChanged?.();
        pollers.delete(platform);
      };
    },
    getStatus() {
      return status;
    },
  };
  pollers.set(platform, poller);
  return poller;
}
