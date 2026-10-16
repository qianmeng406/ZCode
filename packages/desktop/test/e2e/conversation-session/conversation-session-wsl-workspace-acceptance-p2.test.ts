import { writeFile } from "node:fs/promises";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  clearAppData,
  getE2EAppDataPaths,
  readModelProvider,
  resolveE2EProviderRuntimeBaseUrl,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { readRemoteTabSnapshot } from "../helpers/ssh-remote-p0.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  switchV4Mode,
} from "../helpers/v4-conversation.js";
import {
  WSL_P2_FILE_MARKER,
  WSL_P2_FINAL_MARKER,
  WSL_P2_ROUND_TIMEOUT_MS,
  buildWSLTarget,
  openWSLRemoteDialogAndFill,
  readWSLFixtureFile,
  readWSLP2RuntimeConfig,
  selectWSLWorkspaceDirectory,
  startWSLLoopbackReplay,
  waitForWSLDirectoryStep,
  isWSLP2SpecEnabled,
  type WSLP2RuntimeConfig,
  WSL_WORKSPACE_READY_TIMEOUT_MS,
} from "../helpers/wsl-workspace-p2.js";

import { seedPersonalProviderConfig } from "../helpers/model-provider-restart-config.js";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "../helpers/upstream-provider.js";

import {
  verifyWSLAgentLifecycle,
  type WSLAgentLifecycleResult,
} from "../helpers/wsl-agent-lifecycle-p2.js";

import {
  verifyWSLConnectionCancellation,
  verifyWSLCloseAndReconnect,
} from "../helpers/wsl-workspace-lifecycle-p2.js";

const CASE_MARKER = "WSL_P2_ACCEPTANCE";
const USER_PROMPT_MARKER_PREFIX = "E2E_WSLP2_";

interface WSLP2StructuredResult {
  case: string;
  runId: string;
  status: "passed" | "failed" | "blocked";
  replayPort: number;
  linuxLoopbackReachable: boolean;
  windowsForwardingReachable: boolean;
  fixturePath: string | null;
  requestLog: string[];
  stage: string;
  error: string | null;
  agentLifecycle?: WSLAgentLifecycleResult;
  connectionCancelled?: boolean;
  closeReconnect?: { identity: string; remoteSessionId: string };
}

describe(`${CASE_MARKER}: WSL 工作区第二阶段验收`, () => {
  let config: WSLP2RuntimeConfig | null = null;

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("WSL-P2-01 独立桌面 UI 选 WSL、标准连接并完成本地模型真实工具轮次", async function () {
    // opt-in 双闸门：非 Windows 或未显式启用时显式 skip（结构化 blocked，不伪通过）。
    if (!isWSLP2SpecEnabled()) {
      this.skip();
    }
    this.timeout(25 * 60_000);

    config = readWSLP2RuntimeConfig(CASE_MARKER);
    const runId = `r${Date.now().toString(36)}`;
    // 1) Linux loopback replay 先于连接启动：provider baseURL 指向 Linux 127.0.0.1。
    const replay = await startWSLLoopbackReplay(config, runId);
    const structuredResult: WSLP2StructuredResult = {
      case: CASE_MARKER,
      runId,
      status: "failed",
      replayPort: replay.port,
      linuxLoopbackReachable: replay.linuxLoopbackReachable,
      windowsForwardingReachable: replay.windowsForwardingReachable,
      fixturePath: null,
      requestLog: replay.requestLog,
      stage: "replay-started",
      error: null,
    };
    // 结构化结果文件（失败也写）：不记录 env 全集/凭据/完整模型请求。
    const writeReport = async () => {
      // 结构化结果写到 e2e HOME 内（appDataDir 上层），失败也写；不含 env 全集/凭据。
      const reportPath =
        process.env.ZCODE_E2E_WSL_RESULT_FILE ||
        `${getE2EAppDataPaths().appDataDir}/../wsl-p2-acceptance-${runId}.json`;
      try {
        await writeFile(
          reportPath,
          JSON.stringify({ ...structuredResult, requestLog: replay.requestLog }, null, 2),
        );
      } catch {
        // 报告写盘失败不掩盖主流程结果。
      }
    };
    try {
      // replay 在 Linux loopback 不可达 = 本轮 blocked，不能伪装成模型会话通过。
      if (!replay.linuxLoopbackReachable) {
        structuredResult.status = "blocked";
        structuredResult.stage = "linux-loopback-probe";
        structuredResult.error = "linux loopback replay unreachable";
        await writeReport();
        console.warn(`[WSL_P2] blocked`, JSON.stringify(structuredResult));
        this.skip();
        return;
      }
      console.info(`[WSL_P2] replay ready`, JSON.stringify(structuredResult));

      // 2) Windows 侧准备 default e2e provider（anthropic-messages，与 replay 协议一致）：
      //    baseURL 显式指向 Linux loopback replay；API key 为固定 e2e dummy（非真实凭据）。
      structuredResult.stage = "provider-setup";
      process.env.E2E_PROVIDER_HTTP_MODE = "replay";
      const linuxBaseUrl = `http://127.0.0.1:${replay.port}`;
      process.env.E2E_PROVIDER_RUNTIME_BASE_URL = linuxBaseUrl;
      // 启动器已 seed Windows replay；只修改 worker env 不会更新该配置。
      // 复用正式 Personal Config 测试入口，在首发前改为 Agent 所在 Linux 的回放端点。
      await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
        id: UPSTREAM_PROVIDER_ID,
        label: "WSL loopback replay",
        apiFormat: "anthropic-messages",
        apiKey: "e2e-fixture-key",
        baseURL: linuxBaseUrl,
        models: [{ id: UPSTREAM_MODEL, supportsToolCall: true }],
      });
      const provider = await readModelProvider(UPSTREAM_PROVIDER_ID);
      expect(provider && resolveE2EProviderRuntimeBaseUrl(provider)).toBe(linuxBaseUrl);
      await prepareV4ConversationE2E({ skipProvider: false });

      structuredResult.stage = "ui-connect-cancellation";
      await verifyWSLConnectionCancellation(config, CASE_MARKER);
      structuredResult.connectionCancelled = true;
      await writeReport();
      // 3) 独立桌面 UI 显式选 WSL（distro/user），标准 connectRemote（skipDeploy=false）。
      structuredResult.stage = "wsl-connect";
      await openWSLRemoteDialogAndFill(config, CASE_MARKER);
      await waitForWSLDirectoryStep(CASE_MARKER);
      await selectWSLWorkspaceDirectory(config, CASE_MARKER);

      const expectedIdentity = buildRemoteWorkspaceIdentity(
        config.workspacePath,
        buildWSLTarget(config),
      );
      await waitForWorkspaceApp(config.workspacePath, WSL_WORKSPACE_READY_TIMEOUT_MS);
      // 窗口工作区 identity/session 断言：remote tab 必须绑定 WSL identity 与
      // session，且无 secret 持久化（kind=wsl 无 password 字段）。
      structuredResult.stage = "workspace-identity";
      const tabSnapshot = await readRemoteTabSnapshot(expectedIdentity);
      expect(tabSnapshot.workspaceIdentity).toBe(expectedIdentity);
      expect(tabSnapshot.workspacePath).toBe(config.workspacePath);
      expect(tabSnapshot.remoteKind).toBe("wsl");
      expect(tabSnapshot.remoteSessionId).not.toBeNull();
      expect(tabSnapshot.activeWorkspaceIdentity).toBe(expectedIdentity);
      expect(tabSnapshot.secretPersistedInTab).toBe(false);

      // 4) 发送 prompt → 真实工具轮次：Write → Bash(cat 校验+append+输出) → Read → final。
      //    user marker 携带 runId，保证本轮 fixture 路径唯一；终局断言 FINAL_MARKER
      //    必须出现在助手回复（replay 只有在真实 Read tool_result 命中双 marker 才发）。
      structuredResult.stage = "agent-round";
      await switchV4Mode("yolo");
      const userMarker = `${USER_PROMPT_MARKER_PREFIX}${runId}`;
      await sendV4PromptAndWaitAccepted(
        `${userMarker} write the fixture file, read it with bash, then read it back and tell me the content`,
        userMarker,
        `${CASE_MARKER}: WSL 会话没有接受首发消息`,
        120_000,
      );
      try {
        await waitForV4AssistantMessageContaining(WSL_P2_FINAL_MARKER, WSL_P2_ROUND_TIMEOUT_MS);
      } catch (error) {
        throw new Error(
          `${CASE_MARKER}: 模型回合没有完成（未收到含 ${WSL_P2_FINAL_MARKER} 的助手回复；replay requestLog=${JSON.stringify(replay.requestLog.slice(-8))}）`,
          { cause: error },
        );
      }

      // 5) 同一 ext4 路径真实读回：文件工具写入 + Bash 修改都必须落在
      //    workspace/.zcode-e2e/wsl-p2-<runId>/marker.txt，且包含两段 marker。
      structuredResult.stage = "fixture-readback";
      const fixtureContent = await readWSLFixtureFile(config, replay.fixturePath);
      expect(fixtureContent).toContain(WSL_P2_FILE_MARKER);
      // Bash 轮真实 append 的第二行：FILE_MARKER-seen。
      expect(fixtureContent).toContain(`${WSL_P2_FILE_MARKER}-seen`);

      structuredResult.fixturePath = replay.fixturePath;
      structuredResult.stage = "agent-lifecycle";
      await writeReport();
      structuredResult.agentLifecycle = await verifyWSLAgentLifecycle(
        config,
        runId,
        replay.fixturePath,
        async (progress) => {
          structuredResult.agentLifecycle = progress;
          await writeReport();
        },
      );
      structuredResult.stage = "ui-close-reconnect";
      await writeReport();
      structuredResult.closeReconnect = await verifyWSLCloseAndReconnect(
        config,
        CASE_MARKER,
        tabSnapshot.remoteSessionId!,
      );
      expect(await readWSLFixtureFile(config, replay.fixturePath)).toBe(fixtureContent);
      structuredResult.status = "passed";
      await writeReport();
      console.info(`[WSL_P2] round complete`, JSON.stringify(structuredResult));
    } catch (error) {
      structuredResult.status = "failed";
      structuredResult.error = error instanceof Error ? error.message : String(error);
      await writeReport();
      throw error;
    } finally {
      // finally 只释放本轮资源：replay 进程/远端脚本目录；失败自然抛出退出非零。
      await replay.close();
    }
  });
});
