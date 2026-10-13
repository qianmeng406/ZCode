import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSidePaneTab,
  getVisibleSidePaneTabs,
  normalizeWorkspaceSidePaneState,
  openFileExplorerSidePane,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";

function stateWithBrowserTab(): WorkspaceSidePaneTabState {
  return {
    tabs: [
      {
        id: "browser:fixed",
        type: "browser",
        ownerTaskId: "task-1",
        workspaceKey: "ws",
        openedAt: 1,
        faviconUrl: null,
        initialUrl: null,
        title: null,
      },
    ],
    activeTabId: "browser:fixed",
  };
}

type WorkspaceSidePaneTabState = WorkspaceSidePaneState["tabs"][number];

test("openFileExplorerSidePane 新开固定 id 的文件标签并激活", () => {
  const next = openFileExplorerSidePane(stateWithBrowserTab());
  assert.equal(next.tabs.length, 2);
  const tab = next.tabs.find((tab) => tab.type === "file-explorer");
  assert.ok(tab);
  assert.equal(tab.id, "file-explorer");
  assert.equal(next.activeTabId, "file-explorer");
});

test("重复打开幂等：只保留一个文件标签并聚焦它", () => {
  const once = openFileExplorerSidePane(stateWithBrowserTab());
  const twice = openFileExplorerSidePane(once);
  assert.equal(twice.tabs.filter((tab) => tab.type === "file-explorer").length, 1);
  assert.equal(twice.activeTabId, "file-explorer");
});

test("文件标签是 workspace 级：不属于任何对话也始终可见", () => {
  const next = openFileExplorerSidePane(null);
  // ownerTaskId 冻结为其它对话的 tab 场景：scope 收窄后文件标签仍然可见。
  const scoped = getVisibleSidePaneTabs(next, { workspaceKey: "ws", ownerTaskId: "task-2" });
  assert.ok(scoped.some((tab) => tab.type === "file-explorer"));
  const byParent = getVisibleSidePaneTabs(next, "task-2");
  assert.ok(byParent.some((tab) => tab.type === "file-explorer"));
});

test("关闭文件标签后状态干净；空状态归一为 null", () => {
  const opened = openFileExplorerSidePane(null);
  const closed = closeSidePaneTab(opened, "file-explorer");
  assert.equal(closed, null);
  assert.equal(normalizeWorkspaceSidePaneState(opened), opened);
});

test("打开标签页选择器包含文件项，已打开时隐藏（同审查项语义）", () => {
  const base = {
    developerToolsEnabled: false,
    hasReviewTab: true,
    supportsEmbeddedBrowser: false,
  };
  assert.ok(resolveOpenTabLauncherItemIds(base).includes("file-explorer"));
  assert.equal(
    resolveOpenTabLauncherItemIds({ ...base, hasFileExplorerTab: true }).includes("file-explorer"),
    false,
  );
});
