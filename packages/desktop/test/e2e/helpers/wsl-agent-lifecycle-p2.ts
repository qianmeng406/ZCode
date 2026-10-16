import {
  clickV4Stop,
  getV4ConversationState,
  getV4PaneSnapshot,
  openV4ComposerRunningBackgroundWorks,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "./v4-conversation.js";
import { readWSLFixtureFile, runWSLCommand, type WSLP2RuntimeConfig } from "./wsl-workspace-p2.js";

export interface WSLAgentLifecycleResult {
  followup: boolean;
  backgroundOutput: boolean;
  backgroundStatus: boolean;
  cancellation: boolean;
  childPids: number[];
}

export async function verifyWSLAgentLifecycle(
  config: WSLP2RuntimeConfig,
  runId: string,
  fixturePath: string,
  checkpoint: (result: WSLAgentLifecycleResult) => Promise<void>,
): Promise<WSLAgentLifecycleResult> {
  const result: WSLAgentLifecycleResult = {
    followup: false,
    backgroundOutput: false,
    backgroundStatus: false,
    cancellation: false,
    childPids: [],
  };
  const initial = await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "WSL first turn did not settle",
    60_000,
  );
  const root = fixturePath.slice(0, -"/marker.txt".length);
  const prompt = async (mode: string) => {
    const marker = `E2E_WSLP2_${runId}_${mode}`;
    await sendV4PromptAndWaitAccepted(marker, marker, `WSL ${mode} not accepted`, 60_000);
  };
  await prompt("FOLLOW");
  await waitForV4AssistantMessageContaining("E2E_WSLP2_FOLLOW_DONE", 60_000);
  const follow = await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    "WSL followup did not settle",
    60_000,
  );
  expect(follow.taskId).toBe(initial.taskId);
  expect(follow.sessionId).toBe(initial.sessionId);
  result.followup = true;
  await checkpoint(result);

  const waitPid = async (name: string) => {
    let pid = 0;
    await browser.waitUntil(
      async () => {
        const output = await runWSLCommand(
          config,
          `test -f '${root}/${name}.pid' && cat '${root}/${name}.pid'`,
        );
        if (output.code !== 0) return false;
        pid = Number(output.stdout.trim());
        return Number.isSafeInteger(pid) && pid > 1;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: `WSL ${name} PID missing` },
    );
    result.childPids.push(pid);
    return pid;
  };
  const waitGone = async (pid: number) => {
    await browser.waitUntil(
      async () => {
        const probe = await runWSLCommand(config, `kill -0 ${pid} 2>/dev/null`);
        return probe.code === 1;
      },
      { timeout: 15_000, interval: 250, timeoutMsg: `WSL child ${pid} survived` },
    );
  };

  await prompt("BACKGROUND");
  await waitForV4AssistantMessageContaining("E2E_WSLP2_BACKGROUND_DONE", 60_000);
  const backgroundPid = await waitPid("background");
  await openV4ComposerRunningBackgroundWorks(30_000);
  const open = $('[data-testid="background-bash-open"]');
  await open.waitForClickable({ timeout: 15_000 });
  await open.click();
  const details = $(
    '[role="tabpanel"][data-state="active"] [data-testid="background-bash-details"]',
  );
  await details.waitForDisplayed({ timeout: 15_000 });
  await browser.waitUntil(async () => (await details.getAttribute("data-status")) === "running", {
    timeout: 15_000,
    timeoutMsg: "WSL background details did not load running state",
  });
  await browser.waitUntil(async () => (await details.getText()).includes("WSL_BACKGROUND_STDERR"), {
    timeout: 15_000,
    timeoutMsg: "WSL background stderr missing in UI",
  });
  const release = await runWSLCommand(config, `printf release > '${root}/background.release'`);
  expect(release.code).toBe(0);
  await browser.waitUntil(async () => (await details.getAttribute("data-status")) === "completed", {
    timeout: 30_000,
    timeoutMsg: "WSL background work did not complete",
  });
  await browser.waitUntil(async () => (await details.getText()).includes("WSL_BACKGROUND_FINAL"), {
    timeout: 15_000,
    timeoutMsg: "WSL background final output missing",
  });
  expect(await readWSLFixtureFile(config, `${root}/background.done`)).toBe("completed");
  // Adapter-owned stdout log is independent of the fixture's own completion file.
  const pane = await getV4PaneSnapshot();
  expect(pane.sessionId).toMatch(/^[a-zA-Z0-9_-]+$/u);
  const output = await runWSLCommand(
    config,
    `find "$HOME/.zcode" -path '*/${pane.sessionId}/toolu_wslp2_background-stdout.log' -type f -exec cat {} \\;`,
  );
  expect(output.code).toBe(0);
  expect(output.stdout).toContain("WSL_BACKGROUND_FIRST");
  expect(output.stdout).toContain("WSL_BACKGROUND_FINAL");
  await waitGone(backgroundPid);
  result.backgroundOutput = true;
  result.backgroundStatus = true;
  await checkpoint(result);

  await prompt("CANCEL");
  const cancelPid = await waitPid("cancel");
  expect((await getV4PaneSnapshot()).canStop).toBe(true);
  await clickV4Stop();
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && !snapshot.stopRequested,
    "WSL cancelled turn did not settle",
    30_000,
  );
  await waitGone(cancelPid);
  expect((await getV4ConversationState()).queueCount).toBe(0);
  result.cancellation = true;
  await checkpoint(result);
  return result;
}
