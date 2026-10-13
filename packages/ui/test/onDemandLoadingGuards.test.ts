// 按需加载/展示暂停的纯资格裁决回归（见 packages/ui/specs/on-demand-panel-loading.md、
// hidden-presentation-pause.md、assistant-auto-file-preview.md、task-menu-path-loading.md）。
// 组件生命周期（watcher 释放、迟到回包、菜单开关）属宿主行为，由 GUI 验收覆盖。
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAssistantPreviewLoadAction,
  resolveFileTreeWatchedDirectories,
  shouldCommitDeferredRequest,
  shouldLoadTaskMenuPaths,
  shouldRunPresentationClock,
} from "../src/lib/onDemandLoadingGuards.js";

test("shouldLoadTaskMenuPaths：菜单关闭或无稳定 taskId 均不查询", () => {
  assert.equal(shouldLoadTaskMenuPaths({ menuOpen: true, taskId: "task-1" }), true);
  assert.equal(shouldLoadTaskMenuPaths({ menuOpen: false, taskId: "task-1" }), false);
  assert.equal(shouldLoadTaskMenuPaths({ menuOpen: true, taskId: null }), false);
  assert.equal(shouldLoadTaskMenuPaths({ menuOpen: true, taskId: "" }), false);
  assert.equal(shouldLoadTaskMenuPaths({ menuOpen: true, taskId: undefined }), false);
});

test("shouldRunPresentationClock：不可见或无运行中回合都不跑 tick", () => {
  assert.equal(shouldRunPresentationClock({ presentationVisible: true, hasRunningUnit: true }), true);
  assert.equal(
    shouldRunPresentationClock({ presentationVisible: false, hasRunningUnit: true }),
    false,
    "隐藏（设置覆盖/收起 transcript）时必须停表",
  );
  assert.equal(
    shouldRunPresentationClock({ presentationVisible: true, hasRunningUnit: false }),
    false,
  );
  // 分屏未聚焦但可见：presentationVisible 仍为 true，时钟照常。
  assert.equal(shouldRunPresentationClock({ presentationVisible: true, hasRunningUnit: true }), true);
});

test("shouldCommitDeferredRequest：暂停后代际失效，迟到结果不得提交", () => {
  assert.equal(shouldCommitDeferredRequest({ active: true, generation: 3, expectedGeneration: 3 }), true);
  assert.equal(
    shouldCommitDeferredRequest({ active: false, generation: 3, expectedGeneration: 3 }),
    false,
  );
  assert.equal(
    shouldCommitDeferredRequest({ active: true, generation: 3, expectedGeneration: 4 }),
    false,
    "隐藏期间递增代际后，旧结果即使恢复 active 也不得提交",
  );
});

test("resolveFileTreeWatchedDirectories：隐藏时监听目标为空，恢复保留集合内容", () => {
  const dirs = new Set(["/ws", "/ws/src"]);
  assert.deepEqual([...resolveFileTreeWatchedDirectories({ active: true, watchedDirectoryPaths: dirs })].sort(), [
    "/ws",
    "/ws/src",
  ]);
  assert.equal(resolveFileTreeWatchedDirectories({ active: false, watchedDirectoryPaths: dirs }).size, 0);
});

test("resolveAssistantPreviewLoadAction：自动/手动/无三态", () => {
  const base = {
    visible: true,
    hasMarkdownOrHtmlReference: true,
    hasTarget: true,
    fileChangesState: "clean" as string | undefined,
    isLatestCompleteTurn: true,
    requestState: "none" as "none" | "loaded" | "failed",
  };
  assert.equal(
    resolveAssistantPreviewLoadAction({ ...base, autoPreviewEnabled: true }),
    "auto",
    "默认开启保持旧体验",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({ ...base, autoPreviewEnabled: false }),
    "manual",
    "关闭后改为用户点击加载，而不是伪造卡片",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: false,
      hasMarkdownOrHtmlReference: false,
    }),
    "none",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: true,
      hasTarget: false,
    }),
    "none",
    "无 turnHeader target 时无权威明细可查",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: true,
      fileChangesState: "reverted",
    }),
    "none",
    "reverted 是权威投影：不自动查也不手动查",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: false,
      requestState: "loaded",
    }),
    "none",
    "已加载回合不再显示手动入口",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: false,
      isLatestCompleteTurn: false,
    }),
    "none",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({ ...base, autoPreviewEnabled: true, visible: false }),
    "none",
    "隐藏视图不发起自动查询，恢复可见后重新裁决",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: false,
      requestState: "failed",
    }),
    "manual",
    "手动模式失败保留按钮作为重试入口",
  );
  assert.equal(
    resolveAssistantPreviewLoadAction({
      ...base,
      autoPreviewEnabled: true,
      requestState: "failed",
    }),
    "none",
    "自动加载失败保持抑制（旧行为），不循环重试",
  );
});
