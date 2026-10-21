import { describe, expect, it } from "vitest";
import {
  applyRuntimeExecutionState,
  installRuntimeExecutionState,
} from "../src/runtime/execution-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 档位单独变化的持久化/安装/事件契约：
 * 只切 contextProfile（mode/plan 不变）也必须走 保存 → 安装 → 事件 完整链路。
 * 历史缺陷：applyRuntimeExecutionState 的早返回只比较 mode/planEnabled，
 * 档位单独变化时被幂等短路，UI 显示已切融合但下一次请求仍按 standard 构建。
 */

interface FakeRuntime {
  runtime: AgentRuntimeInternal;
  saved: unknown[];
  events: { type: unknown; payload: unknown }[];
  cacheInvalidations: () => number;
}

function makeRuntime(config: Record<string, unknown> = {}): FakeRuntime {
  const saved: unknown[] = [];
  const events: { type: unknown; payload: unknown }[] = [];
  let cacheInvalidations = 0;
  const runtime = {
    sessionId: "sess_state",
    // 档位与权限正交：用 yolo 基线隔离验证 profile-only 链路本身。
    config: { mode: "yolo", planEnabled: false, ...config },
    sessionPersisted: true,
    sessionStore: {
      saveSessionEntry: async (entry: unknown) => {
        saved.push(entry);
        return entry;
      },
    },
    needsPlanModeExitReminder: false,
    contextProjectionRevision: 0,
    invalidateToolCache() {
      cacheInvalidations += 1;
    },
    rootTraceContext: { traceId: "trace", sessionId: "sess_state" },
    createEvent: (type: unknown, payload: unknown) => ({ type, payload }),
    appendEvent: async (event: { type: unknown; payload: unknown }) => {
      events.push(event);
    },
    readSessionTargetForContext: async () => null,
  };
  return {
    runtime: runtime as unknown as AgentRuntimeInternal,
    saved,
    events,
    cacheInvalidations: () => cacheInvalidations,
  };
}

describe("runtime execution state profile-only change", () => {
  it("persists, installs and publishes the event", async () => {
    const { runtime, saved, events, cacheInvalidations } = makeRuntime();
    const next = await applyRuntimeExecutionState(
      runtime,
      { contextProfile: "fusion" },
      { source: "command" },
    );
    expect(next.mode).toBe("yolo");
    expect(next.planEnabled).toBe(false);
    expect(next.contextProfile).toBe("fusion");
    expect(saved).toHaveLength(1);
    expect(cacheInvalidations()).toBe(1);
    expect(runtime.contextProjectionRevision).toBe(1);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.contextProfile).toBe("fusion");
    expect(payload.previousContextProfile).toBe("standard");
    expect(runtime.config.contextProfile).toBe("fusion");
  });

  it("stays idempotent for truly identical state: no save, no install, no event", async () => {
    const { runtime, saved, events, cacheInvalidations } = makeRuntime({
      contextProfile: "fusion",
    });
    await applyRuntimeExecutionState(runtime, { contextProfile: "fusion" }, { source: "command" });
    expect(saved).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(cacheInvalidations()).toBe(0);
  });

  it("leaves memory untouched when persistence fails", async () => {
    const { runtime, events } = makeRuntime();
    (
      runtime as unknown as { sessionStore: { saveSessionEntry: () => Promise<never> } }
    ).sessionStore = {
      saveSessionEntry: async () => {
        throw new Error("disk full");
      },
    };
    await expect(
      applyRuntimeExecutionState(runtime, { contextProfile: "fusion" }, { source: "command" }),
    ).rejects.toThrow(/disk full/);
    expect(runtime.config.contextProfile).toBeUndefined();
    expect(runtime.contextProjectionRevision).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("installRuntimeExecutionState invalidates derived state on profile-only change", () => {
    const { runtime, cacheInvalidations } = makeRuntime();
    installRuntimeExecutionState(runtime, {
      mode: "yolo",
      planEnabled: false,
      contextProfile: "fusion",
    });
    expect(runtime.config.contextProfile).toBe("fusion");
    expect(cacheInvalidations()).toBe(1);
    expect(runtime.contextProjectionRevision).toBe(1);
  });

  it("beta input forces standard profile and persists the full transition", async () => {
    const { runtime, saved, events } = makeRuntime({
      mode: "minimal",
      contextProfile: "minimal",
    });
    const next = await applyRuntimeExecutionState(runtime, { mode: "beta" }, { source: "command" });
    // Beta 覆盖遗留 minimal：完整上下文 + 完整工具表，权限复用完全访问（yolo）。
    expect(next).toEqual({ mode: "beta", planEnabled: false, contextProfile: "standard" });
    expect(runtime.config.mode).toBe("beta");
    expect(runtime.config.contextProfile).toBe("standard");
    expect(saved).toHaveLength(1);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.mode).toBe("beta");
    expect(payload.contextProfile).toBe("standard");
    expect(payload.previousMode).toBe("minimal");
  });

  it("restore preserves build+fusion and yolo+fusion without escalating to beta", async () => {
    // 恢复是读取不是切换：Beta 是完全访问，build+fusion 不能自动升级（否则静默提权）。
    const preservedBuild = makeRuntime();
    installRuntimeExecutionState(preservedBuild.runtime, {
      mode: "build",
      planEnabled: false,
      contextProfile: "fusion",
    });
    expect(preservedBuild.runtime.config.mode).toBe("build");
    expect(preservedBuild.runtime.config.contextProfile).toBe("fusion");

    const preservedYolo = makeRuntime();
    installRuntimeExecutionState(preservedYolo.runtime, {
      mode: "yolo",
      planEnabled: false,
      contextProfile: "fusion",
    });
    expect(preservedYolo.runtime.config.mode).toBe("yolo");
    expect(preservedYolo.runtime.config.contextProfile).toBe("fusion");
  });

  it("keeps standard and fusion contexts distinct", () => {
    const { runtime, cacheInvalidations } = makeRuntime({ contextProfile: "fusion" });
    installRuntimeExecutionState(runtime, {
      mode: "yolo",
      planEnabled: false,
      contextProfile: "standard",
    });
    expect(runtime.config.contextProfile).toBe("standard");
    expect(cacheInvalidations()).toBe(1);
  });
});
