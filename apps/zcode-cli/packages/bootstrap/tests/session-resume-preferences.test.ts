import { describe, expect, it } from "vitest";
import { zcodeWorkspaceUpdateSessionResumePreferencesResultSchema } from "@zcode/shared";
import { updateSessionResumePreferences } from "../src/zcode-protocol/session-resume-preferences.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

describe("session resume runtime preferences", () => {
  it("caches the fast resume switch for subsequent cold subscribes", async () => {
    const context = {
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        fastSessionResumeEnabled: false,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;

    const result = zcodeWorkspaceUpdateSessionResumePreferencesResultSchema.parse(
      await updateSessionResumePreferences(context, {
        workspace,
        preferences: { fastResumeEnabled: true },
      }),
    );

    expect(result).toEqual({ workspace, fastResumeEnabled: true });
    expect(context.appRuntimePreferences.fastSessionResumeEnabled).toBe(true);
  });

  it("rejects unknown preference keys", async () => {
    const context = {
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        fastSessionResumeEnabled: false,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;

    await expect(
      updateSessionResumePreferences(context, {
        workspace,
        preferences: { fastResumeEnabled: true, extra: true },
      }),
    ).rejects.toThrow();
  });
});
