import { describe, expect, it } from "vitest";
import {
  SessionLinuxLeaseRegistry,
  SessionLinuxScopeError,
} from "../src/sessionLinuxExecution/leaseRegistry.js";

function baseLeaseInput(overrides?: Partial<Parameters<SessionLinuxLeaseRegistry["register"]>[0]>) {
  return {
    sessionId: "session-a",
    leaseId: "lease-1",
    generation: 1,
    workspace: { windowsPath: "C:\\proj", linuxPath: "/mnt/c/proj" },
    createdAtMs: 1000,
    ...overrides,
  };
}

describe("SessionLinuxLeaseRegistry", () => {
  it("registers a lease and validates scope by sessionId+leaseId+generation", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    const lease = registry.requireActiveLease({
      sessionId: "session-a",
      leaseId: "lease-1",
      generation: 1,
    });
    expect(lease.workspace.linuxPath).toBe("/mnt/c/proj");
  });

  it("rejects stale generation and unknown lease with typed errors", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    expect(() =>
      registry.requireActiveLease({ sessionId: "session-a", leaseId: "lease-1", generation: 2 }),
    ).toThrowError(SessionLinuxScopeError);
    try {
      registry.requireActiveLease({ sessionId: "session-a", leaseId: "lease-1", generation: 2 });
    } catch (error) {
      expect((error as SessionLinuxScopeError).code).toBe("stale_generation");
    }
    expect(() =>
      registry.requireActiveLease({ sessionId: "other", leaseId: "lease-1", generation: 1 }),
    ).toThrowError(SessionLinuxScopeError);
    expect(() =>
      registry.requireActiveLease({ sessionId: "session-a", leaseId: "missing", generation: 1 }),
    ).toThrowError(SessionLinuxScopeError);
  });

  it("rejects sessionId mismatch as stale_generation even with matching lease", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    try {
      registry.requireActiveLease({
        sessionId: "session-b",
        leaseId: "lease-1",
        generation: 1,
      });
      expect.fail("expected rejection");
    } catch (error) {
      expect((error as SessionLinuxScopeError).code).toBe("stale_generation");
    }
  });

  it("tracks execution ownership per lease", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    const scope = { sessionId: "session-a", leaseId: "lease-1", generation: 1 };
    registry.registerExecution(scope, { executionId: "exec-1" });
    const { execution } = registry.requireExecution(scope, "exec-1");
    expect(execution.executionId).toBe("exec-1");

    registry.updateExecution(scope, "exec-1", { taskId: "task-9" });
    expect(registry.requireExecution(scope, "exec-1").execution.taskId).toBe("task-9");
    expect(registry.listExecutions("lease-1")).toHaveLength(1);

    // 其他 lease 不得引用该 execution
    registry.register(baseLeaseInput({ leaseId: "lease-2", generation: 2 }));
    expect(() =>
      registry.requireExecution(
        { sessionId: "session-a", leaseId: "lease-2", generation: 2 },
        "exec-1",
      ),
    ).toThrowError(SessionLinuxScopeError);
  });

  it("release only drops the released lease; other session's resources survive", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    registry.register(
      baseLeaseInput({ sessionId: "session-b", leaseId: "lease-b", generation: 1 }),
    );
    registry.registerExecution(
      { sessionId: "session-b", leaseId: "lease-b", generation: 1 },
      { executionId: "exec-b" },
    );

    registry.release("lease-1");
    registry.release("lease-1"); // 幂等
    expect(registry.size()).toBe(1);
    expect(() =>
      registry.requireActiveLease({ sessionId: "session-a", leaseId: "lease-1", generation: 1 }),
    ).toThrowError(SessionLinuxScopeError);
    // session-b 不受影响
    expect(
      registry.requireExecution(
        { sessionId: "session-b", leaseId: "lease-b", generation: 1 },
        "exec-b",
      ).execution.executionId,
    ).toBe("exec-b");
  });

  it("commitLease retires older generations of the same session only", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput({ leaseId: "lease-1", generation: 1 }));
    registry.register(baseLeaseInput({ leaseId: "lease-2", generation: 2 }));
    registry.register(
      baseLeaseInput({ sessionId: "session-b", leaseId: "lease-b", generation: 1 }),
    );

    registry.commitLease("lease-2");
    expect(registry.size()).toBe(2);
    expect(registry.getLease("lease-1")).toBeUndefined();
    expect(registry.getLease("lease-b")).toBeDefined();
    expect(
      registry.requireActiveLease({ sessionId: "session-a", leaseId: "lease-2", generation: 2 })
        .generation,
    ).toBe(2);
  });

  it("releaseAll drops every lease and reports affected sessions", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    registry.register(
      baseLeaseInput({ sessionId: "session-b", leaseId: "lease-b", generation: 1 }),
    );
    const sessions = registry.releaseAll();
    expect(sessions.has("session-a")).toBe(true);
    expect(sessions.has("session-b")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("registerExecution requires an active lease", () => {
    const registry = new SessionLinuxLeaseRegistry();
    registry.register(baseLeaseInput());
    registry.release("lease-1");
    expect(() =>
      registry.registerExecution(
        { sessionId: "session-a", leaseId: "lease-1", generation: 1 },
        { executionId: "exec-x" },
      ),
    ).toThrowError(SessionLinuxScopeError);
  });
});
