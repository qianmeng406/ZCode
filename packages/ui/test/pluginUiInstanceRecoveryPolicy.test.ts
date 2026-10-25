import { describe, expect, it } from "vitest";
import {
  createInstanceRecoveryPolicy,
  INSTANCE_RECOVERY_DEFAULTS,
} from "@/plugin-ui/domain/instanceRecoveryPolicy.js";

describe("MCP App instance recovery policy", () => {
  it("retries with exponential backoff inside the window", () => {
    const policy = createInstanceRecoveryPolicy();
    expect(policy.registerFailure(0)).toEqual({ retry: true, delayMs: 1_000 });
    expect(policy.registerFailure(1_500)).toEqual({ retry: true, delayMs: 2_000 });
    expect(policy.registerFailure(5_000)).toEqual({ retry: true, delayMs: 4_000 });
  });

  it("stops retrying after maxAttempts within the window", () => {
    const policy = createInstanceRecoveryPolicy();
    policy.registerFailure(0);
    policy.registerFailure(1_000);
    policy.registerFailure(2_000);
    expect(policy.registerFailure(3_000)).toEqual({ retry: false, delayMs: 0 });
  });

  it("forgets failures older than the window and retries again", () => {
    const policy = createInstanceRecoveryPolicy();
    policy.registerFailure(0);
    policy.registerFailure(1);
    // 窗口外：前两次失效都不再计数，退避回到首轮。
    expect(policy.registerFailure(INSTANCE_RECOVERY_DEFAULTS.windowMs + 2)).toEqual({
      retry: true,
      delayMs: 1_000,
    });
  });

  it("clamps the backoff at maxDelayMs", () => {
    const policy = createInstanceRecoveryPolicy({ baseDelayMs: 4_000 });
    expect(policy.registerFailure(0).delayMs).toBe(4_000);
    expect(policy.registerFailure(1).delayMs).toBe(8_000);
    expect(policy.registerFailure(2).delayMs).toBe(10_000);
  });

  it("reset clears the failure history after a successful run", () => {
    const policy = createInstanceRecoveryPolicy();
    policy.registerFailure(0);
    policy.registerFailure(1_000);
    policy.reset();
    expect(policy.registerFailure(2_000)).toEqual({ retry: true, delayMs: 1_000 });
  });
});
