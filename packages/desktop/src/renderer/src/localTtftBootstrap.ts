import type { IPlatformService, LocalTtftRecord } from "@zcode/shared";
import {
  loadPerformanceSettings,
  LocalTtftObserver,
  PERFORMANCE_SETTINGS_STORAGE_KEY,
  setLocalTtftObserver,
} from "@zcode/ui";

/** 定时器注入点：生产走全局 setInterval/clearInterval；测试注入 fake 断言启停节奏。 */
export interface LocalTtftTimerHost {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const defaultTimerHost: LocalTtftTimerHost = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

/** 单窗口批量出口；关闭采集只影响新输入，已启用的发送保留原决定。 */
export function initializeDesktopLocalTtft(
  platform: IPlatformService,
  timerHost: LocalTtftTimerHost = defaultTimerHost,
): () => void {
  if (!platform.reportLocalTtftBatch || !platform.getRendererActionTraceConfig) return () => {};
  const rendererInstanceId = crypto.randomUUID();
  let records: LocalTtftRecord[] = [];
  let sequence = 0;
  let dropped = 0;
  const observer = new LocalTtftObserver(
    (record) => {
      if (records.length >= 128) {
        dropped++;
        return;
      }
      records.push(record);
    },
    undefined,
    undefined,
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  setLocalTtftObserver(observer);
  const flush = () => {
    observer.sampleClock();
    observer.expire();
    while (records.length) {
      const batch = records.splice(0, 32);
      try {
        platform.reportLocalTtftBatch?.({
          version: 1,
          rendererInstanceId,
          sequence: sequence++,
          records: batch,
          dropped,
        });
        dropped = 0;
      } catch {
        dropped += batch.length;
      }
    }
  };
  // dedupedIdlePollingEnabled（默认关闭）：开启后 flush 定时器跟随 observer.enabled
  // 启停——遥测未启用时不再每秒空转；关闭时保持原「常驻 1s 定时器」行为。
  // 开关值初始化读一次，跨窗口经 storage 事件跟随（本窗翻转重启后完全生效）。
  let dedupedIdlePollingEnabled = loadPerformanceSettings().dedupedIdlePollingEnabled;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  // force=true：配置拉取失败时按原行为兜底常驻（未知状态宁可多冲刷，不漏发缓冲记录）。
  const syncFlushTimer = (force = false) => {
    const shouldRun = force || observer.enabled || !dedupedIdlePollingEnabled;
    if (shouldRun && flushTimer === undefined) {
      flushTimer = timerHost.setInterval(flush, 1000);
    } else if (!shouldRun && flushTimer !== undefined) {
      flush(); // 停表前把已缓冲记录发出去。
      timerHost.clearInterval(flushTimer);
      flushTimer = undefined;
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== PERFORMANCE_SETTINGS_STORAGE_KEY) return;
    dedupedIdlePollingEnabled = loadPerformanceSettings().dedupedIdlePollingEnabled;
    syncFlushTimer();
  };
  const apply = (config: { localTtftEnabled?: boolean }) => {
    observer.enabled = config.localTtftEnabled === true;
    syncFlushTimer();
  };
  void platform
    .getRendererActionTraceConfig()
    .then(apply)
    .catch(() => {
      // 配置未知（reject）：兜底启动 flush 定时器，避免缓冲记录永不冲刷。
      syncFlushTimer(true);
    });
  const off = platform.onRendererActionTraceConfigChanged?.(apply);
  const background = () => observer.background();
  const foreground = () => {
    if (document.visibilityState === "visible") observer.foreground();
  };
  const visibility = () => {
    if (document.visibilityState !== "visible") background();
    else foreground();
  };
  if (!document.hasFocus() || document.visibilityState !== "visible") background();
  window.addEventListener("blur", background);
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("storage", onStorage);
  // 功能关闭时立即启动（与原实现一致）；功能开启时等首个配置到达再决定。
  syncFlushTimer();
  return () => {
    observer.interrupt();
    flush();
    records = [];
    if (flushTimer !== undefined) timerHost.clearInterval(flushTimer);
    off?.();
    setLocalTtftObserver(undefined);
    window.removeEventListener("blur", background);
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("storage", onStorage);
  };
}
