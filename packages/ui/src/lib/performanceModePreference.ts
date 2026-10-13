// 性能模式偏好：纯客户端展示偏好，仅存储值严格等于 "true" 才视为开启。
import { readSafeLocalStorage, writeSafeLocalStorage } from "./browserEnvironment.js";

export const PERFORMANCE_MODE_STORAGE_KEY = "zcode-performance-mode";

export function loadPerformanceMode(): boolean {
  return readSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY) === "true";
}

export function persistPerformanceMode(enabled: boolean): void {
  writeSafeLocalStorage(PERFORMANCE_MODE_STORAGE_KEY, enabled ? "true" : "false");
}
