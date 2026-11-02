// L2：v4 原生 bindExternalAgent / unbindExternalAgent。
//
// 这里钉死的是三条不变量（每条都有一个"看起来更省事但会破契约"的错误实现）：
// 1. 绑定必须先把 binding 落 entry 再改执行状态——反序会在写失败时留下
//    "只读但无绑定"的会话，既不能委派也切不回去。
// 2. 绑定即只读：setExecutionState({ mode: "plan", planEnabled: true })。
// 3. 解绑恢复绑定时快照的 plan/mode，不是无脑切回 build。
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/index.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import type { SessionEntryInfo } from "@zcode/contracts";

const TRACE = { traceId: "trace-1", sessionId: "s1" };

/** 极简 session entry 存储：只实现 external agent 读取/写入需要的三个方法。 */
function makeSessionStore() {
  const entries = new Map<string, SessionEntryInfo>();
  return {
    entries,
    saveSessionEntry: vi.fn(async (entry: SessionEntryInfo) => {
      entries.set(entry.id, entry);
    }),
    sessionEntries: vi.fn(async (query: { type: string }) =>
      [...entries.values()].filter((entry) => entry.type === query.type),
    ),
  };
}

function makeApp(options: { planEnabled?: boolean; mode?: string } = {}) {
  const calls: string[] = [];
  let planEnabled = options.planEnabled ?? false;
  let mode = options.mode ?? "build";
  let readOnly = false;
  return {
    calls,
    sessionId: "s1",
    runtime: {
      getPlanEnabled: vi.fn(() => planEnabled),
      getMode: vi.fn(() => mode),
      setExternalAgentReadOnly: vi.fn((next: boolean) => {
        readOnly = next;
        calls.push(next ? "lock" : "unlock");
      }),
      isExternalAgentReadOnly: vi.fn(() => readOnly),
      setExecutionState: vi.fn(async (input: { mode?: string; planEnabled?: boolean }) => {
        // 与 core 的唯一写入口同构：只读锁在时，一切"放出只读"的写入被拒。
        if (readOnly && input.planEnabled === false) throw new Error("read-only");
        calls.push(input.planEnabled ? "state:plan" : "state:unplan");
        if (input.mode !== undefined) mode = input.mode;
        if (input.planEnabled !== undefined) planEnabled = input.planEnabled;
      }),
      // 解绑路径读 getMode 判断是否还停在 plan。
      appendEvent: vi.fn(async () => {}),
    },
    getMode: vi.fn(() => mode),
  };
}

function makeRecord(
  app: ReturnType<typeof makeApp>,
  sessionStore: ReturnType<typeof makeSessionStore>,
): V4SessionRecordView {
  return {
    app: app as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    traceContext: TRACE,
    sessionStore,
  } as unknown as V4SessionRecordView;
}

function makeHost(record: V4SessionRecordView): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

const BINDING_PAYLOAD = {
  label: "codebuddy",
  driver: "claude-family" as const,
  command: "codebuddy",
};

describe("v4 原生 bindExternalAgent", () => {
  it("绑定成功：先落 entry，再强制进入只读 plan", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: false, mode: "yolo" });
    const record = makeRecord(app, sessionStore);
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("bindExternalAgent", BINDING_PAYLOAD),
    );

    const saved = [...sessionStore.entries.values()];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.type).toBe("runtime/external_agent");
    expect(saved[0]!.data).toMatchObject({
      label: "codebuddy",
      driver: "claude-family",
      command: "codebuddy",
      args: [],
      promptDelivery: "argv-append",
      // 原状态被快照，解绑时恢复。
      previousPlanEnabled: false,
      previousMode: "yolo",
    });
    expect(app.calls).toEqual(["lock", "state:plan"]);
    expect(app.runtime.setExecutionState).toHaveBeenCalledWith(
      { mode: "plan", planEnabled: true },
      TRACE,
    );
    // 绑定变化事件照常发出（冷恢复靠它重放徽标）。
    expect(app.runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("已是只读时不重复写执行状态（避免空转事件）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: true, mode: "plan" });
    await new V4CommandExecutor(makeHost(makeRecord(app, sessionStore))).execute(
      envelope("bindExternalAgent", BINDING_PAYLOAD),
    );
    expect(app.runtime.setExecutionState).not.toHaveBeenCalled();
    // 锁仍要上（否则已只读的会话重启后同样失去保护）。
    expect(app.runtime.setExternalAgentReadOnly).toHaveBeenCalledWith(true);
    expect(app.runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("同值重复绑定 → noop，不覆盖 previous*（否则原权限永久丢失）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: true, mode: "plan" });
    const record = makeRecord(app, sessionStore);
    const executor = new V4CommandExecutor(makeHost(record));
    await executor.execute(envelope("bindExternalAgent", BINDING_PAYLOAD));
    await expect(
      executor.execute(envelope("bindExternalAgent", BINDING_PAYLOAD)),
    ).rejects.toBeInstanceOf(V4CommandNoopError);
  });

  it("绑定另一个 agent → 拒绝，要求先解绑", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: true, mode: "plan" });
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(envelope("bindExternalAgent", BINDING_PAYLOAD));
    await expect(
      executor.execute(
        envelope("bindExternalAgent", { ...BINDING_PAYLOAD, label: "claude", command: "claude" }),
      ),
    ).rejects.toThrow(/已绑定/);
  });
});

describe("v4 原生 unbindExternalAgent", () => {
  it("解绑：清 entry 并恢复绑定时快照的 mode/plan", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: false, mode: "yolo" });
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(envelope("bindExternalAgent", BINDING_PAYLOAD));
    app.runtime.setExecutionState.mockClear();
    app.runtime.appendEvent.mockClear();

    await executor.execute(envelope("unbindExternalAgent", {}));

    // entry 被覆盖成空对象（读取端把空对象视为未绑定）。
    const saved = [...sessionStore.entries.values()];
    expect(saved[0]!.data).toEqual({});
    // 先解锁再恢复：带锁恢复会被唯一写入口拒绝。
    expect(app.calls).toEqual(["lock", "state:plan", "unlock", "state:unplan"]);
    expect(app.runtime.setExecutionState).toHaveBeenCalledWith(
      { mode: "yolo", planEnabled: false },
      TRACE,
    );
    // 解绑事件 payload 为 null → 投影写回 null，徽标消失。
    expect(app.runtime.appendEvent).toHaveBeenCalledTimes(1);
    const event = (app.runtime.appendEvent.mock.calls[0] as unknown[])[0] as {
      payload: unknown;
    };
    expect(event.payload).toBeNull();
  });

  it("未绑定就解绑 → 明确拒绝（而不是静默成功）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    await expect(
      new V4CommandExecutor(makeHost(makeRecord(app, sessionStore))).execute(
        envelope("unbindExternalAgent", {}),
      ),
    ).rejects.toThrow(/没有绑定/);
  });
});

describe("v4 原生 setExternalAgentModel", () => {
  it("只改 model 字段：不重新快照 previous*，只读契约与授权不动", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp({ planEnabled: false, mode: "yolo" });
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, model: "hy3" }),
    );
    const before = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    expect(before.model).toBe("hy3");
    app.runtime.setExecutionState.mockClear();
    // 绑定自己发过一条绑定变化事件；这里只看换模型这一次。
    app.runtime.appendEvent.mockClear();

    await executor.execute(envelope("setExternalAgentModel", { model: "deepseek-v4-pro" }));

    const after = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    expect(after.model).toBe("deepseek-v4-pro");
    // 关键不变量：解绑恢复用的快照没被第二层覆盖。
    expect(after.previousPlanEnabled).toBe(before.previousPlanEnabled);
    expect(after.previousMode).toBe(before.previousMode);
    // 换模型不动执行状态——不该产生只读相关的写入。
    expect(app.runtime.setExecutionState).not.toHaveBeenCalled();
    // 但必须发绑定变化事件：徽标文案带模型名，投影要跟上。
    expect(app.runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("model=null 清空模型（回到 CLI 默认）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, model: "hy3" }),
    );
    await executor.execute(envelope("setExternalAgentModel", { model: null }));
    const after = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    expect(after.model).toBeUndefined();
  });

  it("同值切换 → noop（不产生空转事件）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, model: "hy3" }),
    );
    await expect(
      executor.execute(envelope("setExternalAgentModel", { model: "hy3" })),
    ).rejects.toBeInstanceOf(V4CommandNoopError);
  });

  it("未绑定就换模型 → 明确拒绝", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    await expect(
      new V4CommandExecutor(makeHost(makeRecord(app, sessionStore))).execute(
        envelope("setExternalAgentModel", { model: "hy3" }),
      ),
    ).rejects.toThrow(/没有绑定/);
  });
});

describe("v4 原生 setExternalAgentEffort", () => {
  it("只改 effort 字段：不重新快照 previous*，也不动模型", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, model: "hy3", effort: "medium" }),
    );
    const before = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    app.runtime.setExecutionState.mockClear();
    app.runtime.appendEvent.mockClear();

    await executor.execute(envelope("setExternalAgentEffort", { effort: "xhigh" }));

    const after = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    expect(after.effort).toBe("xhigh");
    // 换档位不该动模型。
    expect(after.model).toBe("hy3");
    // 解绑恢复用的快照没被覆盖。
    expect(after.previousPlanEnabled).toBe(before.previousPlanEnabled);
    expect(after.previousMode).toBe(before.previousMode);
    expect(app.runtime.setExecutionState).not.toHaveBeenCalled();
    expect(app.runtime.appendEvent).toHaveBeenCalledTimes(1);
  });

  it("effort=null 清空档位（回到 CLI 默认）", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, effort: "high" }),
    );
    await executor.execute(envelope("setExternalAgentEffort", { effort: null }));
    const after = [...sessionStore.entries.values()][0]!.data as Record<string, unknown>;
    expect(after.effort).toBeUndefined();
  });

  it("同值切换 → noop", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    const executor = new V4CommandExecutor(makeHost(makeRecord(app, sessionStore)));
    await executor.execute(
      envelope("bindExternalAgent", { ...BINDING_PAYLOAD, effort: "high" }),
    );
    await expect(
      executor.execute(envelope("setExternalAgentEffort", { effort: "high" })),
    ).rejects.toBeInstanceOf(V4CommandNoopError);
  });

  it("未绑定就换档位 → 明确拒绝", async () => {
    const sessionStore = makeSessionStore();
    const app = makeApp();
    await expect(
      new V4CommandExecutor(makeHost(makeRecord(app, sessionStore))).execute(
        envelope("setExternalAgentEffort", { effort: "high" }),
      ),
    ).rejects.toThrow(/没有绑定/);
  });
});
