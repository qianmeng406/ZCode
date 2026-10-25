/**
 * MCP App 实例失效后的自动重建策略：窗口内有界重试，超过上限把错误交还显式 UX。
 * 实例失效的常见来源是后端连接换源（插件 server 重启 / runtime 重启后的失效通知），
 * 多数场景立刻重建即可无感恢复；持续失效（插件本身坏掉）则退回原有的错误态。
 * 纯状态机、无 IO，宿主接线见 pluginUiManagedPage。
 */
export interface InstanceRecoveryDecision {
  retry: boolean;
  /** retry=true 时重建前等待的退避毫秒数。 */
  delayMs: number;
}

export interface InstanceRecoveryPolicy {
  /** 登记一次失效；窗口内超出重试上限时返回 retry=false。 */
  registerFailure(atMs: number): InstanceRecoveryDecision;
  /** 实例成功运行后清空计数：下一次失效从首轮退避重新开始。 */
  reset(): void;
}

export const INSTANCE_RECOVERY_DEFAULTS = {
  maxAttempts: 3,
  windowMs: 5 * 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
} as const;

export function createInstanceRecoveryPolicy(
  options: Partial<typeof INSTANCE_RECOVERY_DEFAULTS> = {},
): InstanceRecoveryPolicy {
  const { maxAttempts, windowMs, baseDelayMs, maxDelayMs } = {
    ...INSTANCE_RECOVERY_DEFAULTS,
    ...options,
  };
  let failures: number[] = [];
  return {
    registerFailure(atMs: number): InstanceRecoveryDecision {
      failures = failures.filter((at) => atMs - at <= windowMs);
      if (failures.length >= maxAttempts) return { retry: false, delayMs: 0 };
      failures.push(atMs);
      return {
        retry: true,
        delayMs: Math.min(maxDelayMs, baseDelayMs * 2 ** (failures.length - 1)),
      };
    },
    reset(): void {
      failures = [];
    },
  };
}
