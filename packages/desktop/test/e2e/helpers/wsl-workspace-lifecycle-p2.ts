/* eslint-disable max-lines -- WSL P2 生命周期验收 helper：连接取消 / 侧栏关闭重连共用
   真实 UI 驱动与远端只读核验逻辑，集中维护以保持同一条契约边界。 */
// WSL 工作区生命周期第二阶段 helper（docs/research/wsl-workspace-acceptance.spec.md）。
// 与 wsl-workspace-p2.ts 的关系：复用同一 WSL 向导驱动（openWSLRemoteDialogAndFill）、
// 同一 RemoteConnectionDialog / 侧栏 testId 契约与远端只读 ps 观察，不复制连接细节。
// 两个导出函数都只做真实 UI 动作 + 只读核验；不杀远端进程，不引入定时 delay 冒充屏障。
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SSH_DIALOG,
  TID_SSH_SUCCESS,
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, waitForTestIdByDom, waitForWorkspaceApp } from "./desktop-app.js";
import {
  readRemoteTabSnapshot,
  waitForRemoteTab,
  type RemoteTabSnapshot,
} from "./ssh-remote-p0.js";
import { startNewV4Draft } from "./v4-conversation.js";
import {
  openWSLRemoteDialogAndFill,
  runWSLCommand,
  selectWSLWorkspaceDirectory,
  waitForWSLDirectoryStep,
  buildWSLWorkspaceIdentity,
  WSL_WORKSPACE_READY_TIMEOUT_MS,
  type WSLP2RuntimeConfig,
} from "./wsl-workspace-p2.js";

const SERVER_PID_CHECK_TIMEOUT_MS = 30_000;
const SERVER_PS_TIMEOUT_MS = 15_000;
const UI_CLOSE_SETTLE_TIMEOUT_MS = 30_000;

/** WSL distro 内正在运行的 zcode-server PID（只读 ps，不杀）。 */
async function listWSLServerPids(config: WSLP2RuntimeConfig): Promise<number[]> {
  const result = await runWSLCommand(config, 'ps -u "$(id -u)" -o pid=,args=', {
    timeoutMs: SERVER_PS_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `WSL P2 lifecycle: 只读 ps 核验失败 code=${result.code} stderr=${result.stderr.slice(0, 200)}`,
    );
  }
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+.*(?:^|[/\s])zcode-server\.cjs(?:\s|$)/u);
    return match ? [Number.parseInt(match[1]!, 10)] : [];
  });
}

async function readWSLTabSnapshot(identity: string): Promise<RemoteTabSnapshot> {
  return readRemoteTabSnapshot(identity);
}

/**
 * 真实契约：关闭向导 = header 的“关闭”按钮（sr-only 文案 关闭/Close）→
 * connecting 中会弹 confirmDialog（确认按钮 TID_CONFIRM_DIALOG_CONFIRM =
 * “中止连接”）。这里返回是否走到了确认弹窗。
 */
async function clickWizardHeaderCloseAndConfirm(caseMarker: string): Promise<void> {
  let clickedClose = false;
  await browser.waitUntil(
    async () => {
      clickedClose = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector<HTMLElement>(`[data-testid="${dialogTestId}"]`);
        if (!dialog || dialog.getClientRects().length === 0) return false;
        const closeButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => {
            const text = (candidate.textContent ?? "").trim();
            // header 关闭按钮的可访问名来自 sr-only span（zh-CN: 关闭 / en: Close）。
            return text === "关闭" || text === "Close";
          },
        );
        if (!closeButton || closeButton.disabled) return false;
        closeButton.click();
        return true;
      }, TID_SSH_DIALOG);
      return clickedClose;
    },
    {
      timeout: UI_CLOSE_SETTLE_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: `${caseMarker}: WSL 向导没有显示可点击的关闭按钮`,
    },
  );

  // 关闭后两条真实路径：confirmDialog（connecting 中止/已连接放弃）或直接关闭。
  let confirmed = false;
  await browser.waitUntil(
    async () => {
      const state = (await browser.execute(
        (dialogTestId, confirmTestId) => {
          const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
          const confirmButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>("[data-testid]"),
          ).find(
            (candidate) =>
              candidate.dataset.testid === confirmTestId && candidate.getClientRects().length > 0,
          );
          if (confirmButton && !confirmButton.disabled) {
            confirmButton.click();
            return "confirmed";
          }
          if (!dialog || dialog.getClientRects().length === 0) {
            return "closed";
          }
          return "pending";
        },
        TID_SSH_DIALOG,
        TID_CONFIRM_DIALOG_CONFIRM,
      )) as "confirmed" | "closed" | "pending";
      if (state === "confirmed") confirmed = true;
      return state !== "pending";
    },
    {
      timeout: UI_CLOSE_SETTLE_TIMEOUT_MS,
      interval: 200,
      timeoutMsg: `${caseMarker}: 关闭向导后既没有确认弹窗也没有关闭`,
    },
  );
  if (!confirmed) throw new Error(`${caseMarker}: 未确认“中止连接”，不能宣称连接中取消通过`);
}

/**
 * 验收 UI“连接中取消”路径（在首连接之前、由主测试调用）：
 * 1. 新建草稿 → WSL 向导填配置并点连接（openWSLRemoteDialogAndFill）；
 * 2. 屏障：确认仍处于 connecting（目录步骤未出现、identity tab 未建立），
 *    若连接已抢先完成则显式失败，不静默通过；
 * 3. 走真实 header 关闭 → confirmDialog“中止连接”；
 * 4. 核验：identity tab 不建立 + distro 内没有新增 zcode-server 进程
 *    （只读 ps 对比 before/after，不杀任何进程）。
 *
 * 局限：取消与部署完成天然存在竞态；连接在取消前完成会被显式报错而非伪通过。
 * 调用方需在调用前已启动 replay/完成 provider seed（本函数不管理 replay 生命周期）。
 */
export async function verifyWSLConnectionCancellation(
  config: WSLP2RuntimeConfig,
  caseMarker: string,
): Promise<void> {
  const identity = buildWSLWorkspaceIdentity(config);
  const beforePids = await listWSLServerPids(config);

  await startNewV4Draft();
  await openWSLRemoteDialogAndFill(config, caseMarker);

  // 屏障（非 delay）：轮询直到“仍在连接”可证伪的两条信号出现。
  // 目录步骤容器（TID_SSH_SUCCESS）出现或 identity tab 建立即为连接已完成。
  await browser.waitUntil(
    async () => {
      const snapshot = await readWSLTabSnapshot(identity);
      if (snapshot.workspaceIdentity !== null || snapshot.remoteSessionId !== null) {
        throw new Error(
          `${caseMarker}: 连接在取消前已完成（identity tab 已建立），无法验证取消路径`,
        );
      }
      const directoryStepShown = await browser.execute((successTestId) => {
        const success = document.querySelector(`[data-testid="${successTestId}"]`);
        return Boolean(success?.getClientRects().length);
      }, TID_SSH_SUCCESS);
      if (directoryStepShown) {
        throw new Error(`${caseMarker}: 连接在取消前已完成（已进入目录步骤），无法验证取消路径`);
      }
      // dialog 仍在且未成功 = 仍在 connecting。
      const dialogAlive = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
        return Boolean(dialog?.getClientRects().length);
      }, TID_SSH_DIALOG);
      return dialogAlive;
    },
    {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `${caseMarker}: WSL 连接既没有进入 connecting 稳态也没有报错`,
    },
  );

  await clickWizardHeaderCloseAndConfirm(caseMarker);

  // 向导必须关闭（确认中止/直接关闭都会回 kind 步骤或整个关闭；这里等容器消失）。
  await browser.waitUntil(
    async () =>
      browser.execute((dialogTestId) => {
        const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
        return !dialog || dialog.getClientRects().length === 0;
      }, TID_SSH_DIALOG),
    {
      timeout: UI_CLOSE_SETTLE_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${caseMarker}: 取消连接后 WSL 向导没有关闭`,
    },
  );

  // 核验 1：identity tab 不建立（连接被真实取消，而非仅 UI 关闭）。
  await browser.waitUntil(
    async () => {
      const snapshot = await readWSLTabSnapshot(identity);
      return snapshot.workspaceIdentity === null && snapshot.remoteSessionId === null;
    },
    {
      timeout: SERVER_PID_CHECK_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: 取消连接后仍存在 identity tab ${identity}`,
    },
  );

  // 核验 2：distro 内没有新增 zcode-server（只读对比，绝不 kill）。
  await browser.waitUntil(
    async () => {
      const currentPids = await listWSLServerPids(config);
      return currentPids.every((pid) => beforePids.includes(pid));
    },
    {
      timeout: SERVER_PID_CHECK_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${caseMarker}: 取消连接后 distro 内出现新增 zcode-server 进程残留`,
    },
  );
}

/**
 * 验收“侧栏关闭移除 → 同一 identity 重新连接”路径（在首发/续发完成后调用）：
 * 1. 走真实侧栏 more 菜单 → workspace-close 移除（如出现运行中确认弹窗则确认），
 *    等待 sidebar item 真实消失；注意真实契约是“移除入口/连接历史”，
 *    不是 disconnected 保留态，因此这里断言 tab 彻底消失而非 remoteSessionId=null；
 * 2. startNewV4Draft → WSL 向导重新连接同一 distro/user/workspace；
 * 3. 断言 identity 相同、remoteKind=wsl、无 secret 持久化、
 *    remoteSessionId 为新值（≠ previousSessionId）。
 *
 * 局限：重连要求 replay/loopback provider 仍存活（由主测试持有 handle）；
 * fixture 文件是否仍在由主测试用 readWSLFixtureFile 读回，本函数不读文件。
 * 移除后不清理远端（远端 server 由产品侧 releaseWorkspaceRuntimeAfterProjectRemoval 负责）。
 */
export async function verifyWSLCloseAndReconnect(
  config: WSLP2RuntimeConfig,
  caseMarker: string,
  previousSessionId: string,
): Promise<{ identity: string; remoteSessionId: string }> {
  const identity = buildWSLWorkspaceIdentity(config);
  const workspaceItemId = testId(TID_WORKSPACE_ITEM, config.workspacePath);
  const workspaceCloseId = testId(TID_WORKSPACE_CLOSE, config.workspacePath);

  // 行操作只在 hover/focus 时挂载；先走真实指针 hover，再点击 Radix trigger。
  const row = $(`[data-testid="${workspaceItemId}"]`);
  await row.waitForDisplayed({ timeout: UI_CLOSE_SETTLE_TIMEOUT_MS });
  await row.moveTo();
  const more = row.$('button[aria-label="More"],button[aria-label="更多"]');
  await more.waitForClickable({ timeout: UI_CLOSE_SETTLE_TIMEOUT_MS });
  await more.click();
  await clickTestIdByDom(workspaceCloseId, {
    timeout: 15_000,
    timeoutMsg: `${caseMarker}: workspace ${config.workspacePath} 没有显示移除入口`,
  });
  // 可选确认弹窗（运行中 workspace 会有；idle 下无）。出现即确认。
  await browser.waitUntil(
    async () => {
      const state = (await browser.execute(
        (itemId, confirmTestId) => {
          const confirmButton = Array.from(
            document.querySelectorAll<HTMLButtonElement>("[data-testid]"),
          ).find(
            (candidate) =>
              candidate.dataset.testid === confirmTestId && candidate.getClientRects().length > 0,
          );
          if (confirmButton && !confirmButton.disabled) {
            confirmButton.click();
            return "confirmed";
          }
          const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (candidate) => candidate.dataset.testid === itemId,
          );
          return item ? "pending" : "removed";
        },
        workspaceItemId,
        TID_CONFIRM_DIALOG_CONFIRM,
      )) as "confirmed" | "pending" | "removed";
      return state !== "pending";
    },
    {
      timeout: UI_CLOSE_SETTLE_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${caseMarker}: workspace ${config.workspacePath} 移除没有收敛（确认弹窗未处理或 item 未消失）`,
    },
  );
  await browser.waitUntil(
    async () =>
      browser.execute((itemId) => {
        return !Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (candidate) => candidate.dataset.testid === itemId,
        );
      }, workspaceItemId),
    {
      timeout: UI_CLOSE_SETTLE_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${caseMarker}: workspace ${config.workspacePath} 移除后仍在侧栏`,
    },
  );

  // 真实契约：移除后 tab 消失（不是 disconnected 保留态）。
  await browser.waitUntil(
    async () => {
      const snapshot = await readWSLTabSnapshot(identity);
      return snapshot.workspaceIdentity === null && snapshot.remoteSessionId === null;
    },
    {
      timeout: WSL_WORKSPACE_READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: workspace 移除后 identity tab 仍存在（契约与预期不符）`,
    },
  );

  // 2) 重新连接（同一 distro/user/workspace，走完整 WSL 向导）。
  await startNewV4Draft();
  await openWSLRemoteDialogAndFill(config, caseMarker);
  await waitForWSLDirectoryStep(caseMarker);
  await selectWSLWorkspaceDirectory(config, caseMarker);
  await waitForWorkspaceApp(config.workspacePath, WSL_WORKSPACE_READY_TIMEOUT_MS);

  // 3) identity 相同、session 全新。
  const tab = await waitForRemoteTab({
    caseMarker,
    expectedIdentity: identity,
    expectedPath: config.workspacePath,
  });
  if (tab.remoteKind !== "wsl") {
    throw new Error(`${caseMarker}: 重连后 remoteKind=${tab.remoteKind}，期望 wsl`);
  }
  if (tab.secretPersistedInTab) {
    throw new Error(`${caseMarker}: 重连后 tab 持久化了 secret（kind=wsl 不应有 password 字段）`);
  }
  if (!tab.remoteSessionId) {
    throw new Error(`${caseMarker}: 重连后缺少 remoteSessionId`);
  }
  if (tab.remoteSessionId === previousSessionId) {
    throw new Error(
      `${caseMarker}: 重连后 remoteSessionId 与关闭前相同（${previousSessionId}），不是全新 session`,
    );
  }
  await waitForTestIdByDom(workspaceItemId, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 重连后侧栏没有恢复 workspace item`,
  });
  return { identity, remoteSessionId: tab.remoteSessionId };
}
