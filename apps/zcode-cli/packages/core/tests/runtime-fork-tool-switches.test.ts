import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import {
  applyForkToolSwitchRegistry,
  updateForkToolSwitches,
} from "../src/runtime/methods/fork-tool-switches.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ForkToolPreferences } from "@zcode/shared";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const ALL_OFF: ForkToolPreferences = {
  monitorTool: false,
  notebookEdit: false,
  applyPatch: false,
};

function createRuntime(forkToolSwitches: ForkToolPreferences = ALL_OFF) {
  const runtime = createTestAgentRuntime(
    createSessionId("runtime-fork-tool-switches"),
    { forkToolSwitches, mode: "build" },
    { eventStore: createTestSessionEventStore() },
  );
  return runtime;
}

function internalOf(runtime: ReturnType<typeof createRuntime>): AgentRuntimeInternal {
  return runtime as unknown as AgentRuntimeInternal;
}

function visibleToolNames(runtime: ReturnType<typeof createRuntime>): string[] {
  return runtime.getTools().map((tool) => tool.name);
}

describe("fork tool switches", () => {
  it("冷启动按 config 注册：默认全关时三个工具都不在工具面上", () => {
    const runtime = createRuntime();
    const names = visibleToolNames(runtime);
    for (const name of ["Monitor", "NotebookEdit", "ApplyPatch"]) {
      expect(names).not.toContain(name);
      expect(runtime.getToolRegistry().has(name)).toBe(false);
    }
  });

  it("冷启动打开开关时对应工具立刻可见", () => {
    const runtime = createRuntime({ ...ALL_OFF, applyPatch: true });
    expect(visibleToolNames(runtime)).toContain("ApplyPatch");
    expect(runtime.getToolRegistry().has("ApplyPatch")).toBe(true);
  });

  it("无 active turn 时开关同时改动可见性与注册表，并推进投影版本", () => {
    const runtime = createRuntime();
    const internal = internalOf(runtime);
    const revisionBefore = internal.contextProjectionRevision;

    updateForkToolSwitches.call(internal, { ...ALL_OFF, monitorTool: true });

    expect(visibleToolNames(runtime)).toContain("Monitor");
    expect(runtime.getToolRegistry().has("Monitor")).toBe(true);
    expect(internal.contextProjectionRevision).toBeGreaterThan(revisionBefore);
    expect(internal.pendingForkToolSwitchApply).toBe(false);

    updateForkToolSwitches.call(internal, ALL_OFF);

    expect(visibleToolNames(runtime)).not.toContain("Monitor");
    expect(runtime.getToolRegistry().has("Monitor")).toBe(false);
  });

  it("turn 进行中关闭：可见性立即消失，注册表延后到 turn 收口", () => {
    const runtime = createRuntime({ ...ALL_OFF, notebookEdit: true });
    const internal = internalOf(runtime);
    expect(visibleToolNames(runtime)).toContain("NotebookEdit");

    // 模拟「本 turn 已经流式声明过调用」：activeTurn 在场时不允许立刻 unregister，
    // 否则 call-runner 在执行阶段会拿到 ToolNotFound。
    internal.activeTurn = {} as AgentRuntimeInternal["activeTurn"];
    updateForkToolSwitches.call(internal, ALL_OFF);

    expect(visibleToolNames(runtime)).not.toContain("NotebookEdit");
    expect(runtime.getToolRegistry().has("NotebookEdit")).toBe(true);
    expect(internal.pendingForkToolSwitchApply).toBe(true);

    internal.activeTurn = undefined;
    applyForkToolSwitchRegistry.call(internal);

    expect(runtime.getToolRegistry().has("NotebookEdit")).toBe(false);
    expect(internal.pendingForkToolSwitchApply).toBe(false);
  });

  it("重复命令式打开不会因重复注册报错，关闭后也不会被重新投影出来", () => {
    const runtime = createRuntime();
    const internal = internalOf(runtime);

    updateForkToolSwitches.call(internal, { ...ALL_OFF, monitorTool: true });
    updateForkToolSwitches.call(internal, { ...ALL_OFF, monitorTool: true });
    expect(runtime.getToolRegistry().has("Monitor")).toBe(true);

    updateForkToolSwitches.call(internal, ALL_OFF);
    expect(runtime.getToolRegistry().has("Monitor")).toBe(false);
    // 清缓存重算后不能复活：refreshBranchAwareBuiltInTools 只做加法，关闭必须显式 unregister。
    internal.cachedTools = null;
    expect(visibleToolNames(runtime)).not.toContain("Monitor");
  });
});
