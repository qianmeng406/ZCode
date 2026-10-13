import assert from "node:assert/strict";
import test from "node:test";
import { initializeMcp, startMcpStartup } from "../src/runtime/methods/mcp.js";
import { installRuntimeExecutionState } from "../src/runtime/execution-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * MCP 生命周期契约：极简档位「跳过启动」不等于「初始化完成」。
 * 以前两个完成标志一起置 true，切回标准档位后 initializeMcp 永久短路，
 * 同一 runtime 再也拿不到 MCP 工具（实测问题的回归）。
 */

const DESCRIPTOR = {
  serverName: "audit",
  toolName: "read",
  inputSchema: { type: "object" },
};

interface FakeRuntime {
  runtime: AgentRuntimeInternal;
  calls: () => { discovery: number; connect: number; registered: string[] };
}

function makeRuntime(
  mode: "build" | "minimal",
  options: { servers?: Record<string, unknown>; connect?: () => Promise<unknown> } = {},
): FakeRuntime {
  const registered: string[] = [];
  let discovery = 0;
  let connect = 0;
  const runtime: Record<string, unknown> = {
    sessionId: "sess_mcp",
    config: {
      mode,
      planEnabled: false,
      mcp: { enabled: true, servers: options.servers ?? {} },
      workspaceIdentity: undefined,
    },
    workingDirectory: "C:/tmp/ws",
    sessionPersisted: false,
    mcpInitialized: false,
    mcpToolsRegistered: false,
    contextProjectionRevision: 0,
    contextPrefixRevision: -1,
    needsPlanModeExitReminder: false,
    invalidateToolCache() {},
    trackResidencyBlockingWork: <T>(promise: Promise<T>) => promise,
    registry: {
      register: (entry: { name: string }) => {
        registered.push(entry.name);
      },
    },
    mcpPort: {
      status: async () => {
        discovery += 1;
        return {};
      },
      listTools: async () => {
        discovery += 1;
        return [DESCRIPTOR];
      },
      connectConfiguredServers: async () => {
        connect += 1;
        const snapshot = options.connect ? await options.connect() : undefined;
        return snapshot ?? { statuses: {}, tools: [DESCRIPTOR] };
      },
    },
  };
  const bound = runtime as unknown as AgentRuntimeInternal;
  // 真实 runtime 由 prototype 绑定这两个方法；测试按同一方式挂上。
  runtime.startMcpStartup = (trace: never) => startMcpStartup.call(bound, trace);
  runtime.initializeMcp = (trace: never) => initializeMcp.call(bound, trace);
  return {
    runtime: bound,
    calls: () => ({ discovery, connect, registered }),
  };
}

test("minimal startup does not seal MCP initialization", async () => {
  const { runtime, calls } = makeRuntime("minimal");
  await initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  assert.equal(calls().discovery, 0, "极简不触发 MCP 启动");
  assert.equal(runtime.mcpInitialized, false, "跳过启动不是初始化完成");
  assert.equal(runtime.mcpToolsRegistered, false);

  // 切回标准档位后必须能补启动并注册，无需重建 runtime。
  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: false });
  await initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  assert.ok(calls().discovery > 0, "退出极简后补启动");
  assert.ok(calls().registered.length > 0, "退出极简后注册工具");
  assert.equal(runtime.mcpToolsRegistered, true);
});

test("registration advances the projection revision once", async () => {
  const { runtime } = makeRuntime("build");
  await initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  assert.equal(runtime.contextProjectionRevision, 1);
  await initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  assert.equal(runtime.contextProjectionRevision, 1, "幂等调用不重复推进");
  assert.equal(runtime.mcpToolsRegistered, true);
});

test("concurrent initializeMcp shares a single registration", async () => {
  const { runtime, calls } = makeRuntime("build");
  await Promise.all([
    initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" }),
    initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" }),
  ]);
  assert.equal(calls().registered.length, 1, "并发只注册一次");
  assert.equal(runtime.mcpToolsRegistered, true);
});

test("switching to minimal during startup defers registration without reconnecting", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runtime, calls } = makeRuntime("build", {
    servers: { audit: { type: "stdio", command: "fake" } },
    connect: async () => {
      await gate;
      return { statuses: {}, tools: [DESCRIPTOR] };
    },
  });
  const pending = initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  installRuntimeExecutionState(runtime, { mode: "minimal", planEnabled: false });
  release();
  await pending;
  assert.equal(calls().registered.length, 0, "极简期间不注册");
  assert.equal(runtime.mcpToolsRegistered, false, "延迟注册而非误标完成");

  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: false });
  await initializeMcp.call(runtime, { traceId: "t", sessionId: "sess_mcp" });
  assert.equal(calls().connect, 1, "复用启动快照，不二次连接");
  assert.equal(calls().registered.length, 1);
  assert.equal(runtime.mcpToolsRegistered, true);
});

test("startMcpStartup stays recoverable when minimal skipped it", () => {
  const { runtime } = makeRuntime("minimal");
  assert.equal(startMcpStartup.call(runtime, { traceId: "t", sessionId: "sess_mcp" }), undefined);
  installRuntimeExecutionState(runtime, { mode: "build", planEnabled: false });
  assert.ok(
    startMcpStartup.call(runtime, { traceId: "t", sessionId: "sess_mcp" }),
    "退出极简后能启动",
  );
});
