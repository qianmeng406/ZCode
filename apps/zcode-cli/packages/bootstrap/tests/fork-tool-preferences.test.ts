import { describe, expect, it, vi } from "vitest";
import { zcodeWorkspaceUpdateForkToolPreferencesResultSchema } from "@zcode/shared";
import { updateForkToolPreferences } from "../src/zcode-protocol/fork-tool-preferences.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

describe("fork tool preferences", () => {
  it("pushes switches into every resident session and caches them for future ones", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const context = {
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        forkToolPreferences: { monitorTool: false, notebookEdit: false, applyPatch: false },
      },
      sessions: new Map([
        [
          "sess_a",
          {
            app: createFakeApp(undefined, {
              runtime: { updateForkToolSwitches: first } as never,
            }),
          },
        ],
        [
          "sess_b",
          {
            app: createFakeApp(undefined, {
              runtime: { updateForkToolSwitches: second } as never,
            }),
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext;

    const preferences = { monitorTool: true, notebookEdit: false, applyPatch: true };
    const result = zcodeWorkspaceUpdateForkToolPreferencesResultSchema.parse(
      await updateForkToolPreferences(context, { workspace, preferences }),
    );

    expect(result).toEqual({ workspace, preferences, updatedSessionCount: 2 });
    // 冷恢复/新建会话读缓存值，活跃会话读推送值，两边必须一致。
    expect(context.appRuntimePreferences.forkToolPreferences).toEqual(preferences);
    expect(first).toHaveBeenCalledWith(preferences);
    expect(second).toHaveBeenCalledWith(preferences);
  });

  it("rejects malformed preferences instead of silently defaulting", async () => {
    const context = {
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        forkToolPreferences: { monitorTool: false, notebookEdit: false, applyPatch: false },
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;

    await expect(
      updateForkToolPreferences(context, {
        workspace,
        preferences: { monitorTool: true },
      }),
    ).rejects.toThrow();
  });
});
