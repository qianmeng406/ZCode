import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";

import type { AgentRuntime } from "../src/runtime.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

describe("foreground subagent stop", () => {
  it("stops a foreground local Agent task by its runtime task id", async () => {
    const sessionId = createSessionId("foreground-subagent-stop");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const stoppedTaskIds: string[] = [];
    runtimeTaskRegistry.register({
      agentId: "agent_fg",
      agentType: "general-purpose",
      description: "foreground research",
      isBackgrounded: false,
      outputFile: "/tmp/agent_fg/output.txt",
      parentToolCallId: "tool_agent_fg",
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_fg",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    const runtime: AgentRuntime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId) {
            stoppedTaskIds.push(taskId);
            return {
              agentId: taskId,
              agentType: "general-purpose",
              description: "foreground research",
              isBackgrounded: false,
              outputFile: "/tmp/agent_fg/output.txt",
              startedAt: new Date(0),
              status: "killed",
              taskId,
            };
          },
        },
      },
    );

    const result = await runtime.cancelBackgroundTask("agent_fg");

    expect(stoppedTaskIds).toEqual(["agent_fg"]);
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "agent_fg",
    });
  });
});
