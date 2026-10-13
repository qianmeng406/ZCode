// 按需加载/展示暂停的纯资格裁决。集中在一处，避免各组件自行拼接条件；
// 全部为纯函数，无 IO、无 React 依赖，配套测试见 packages/ui/test/onDemandLoadingGuards.test.ts。

/** 任务菜单路径查询资格：菜单打开且目标 task 已落库（有稳定 taskId）。 */
export function shouldLoadTaskMenuPaths(params: {
  menuOpen: boolean;
  taskId: string | null | undefined;
}): boolean {
  return params.menuOpen && Boolean(params.taskId);
}

/** 运行中每秒展示时钟资格：视图真实可见且存在运行中回合。 */
export function shouldRunPresentationClock(params: {
  presentationVisible: boolean;
  hasRunningUnit: boolean;
}): boolean {
  return params.presentationVisible && params.hasRunningUnit;
}

/**
 * 迟到异步结果能否提交：展示工作暂停后旧代际结果一律弃用。
 * active=false 或代际不一致（隐藏期间 generation 已递增 / 恢复后新开一代）均拒绝。
 */
export function shouldCommitDeferredRequest(params: {
  active: boolean;
  generation: number;
  expectedGeneration: number;
}): boolean {
  return params.active && params.generation === params.expectedGeneration;
}

/** 文件树 watcher 目标集合：隐藏时不保留任何监听目标（由 watcher hook 释放注册）。 */
export function resolveFileTreeWatchedDirectories(params: {
  active: boolean;
  watchedDirectoryPaths: ReadonlySet<string>;
}): Set<string> {
  return params.active ? new Set(params.watchedDirectoryPaths) : new Set();
}

export type AssistantPreviewLoadAction = "auto" | "manual" | "none";

/**
 * 消息文件预览的加载动作：
 * - "auto"：自动查权威 fileChanges（现状行为）；
 * - "manual"：自动关闭但本回合具备自动资格，展示「加载预览」由用户触发
 *   （手动加载失败后保留按钮作为重试入口）；
 * - "none"：不需要或不可见（无 md/html 引用、无 target、reverted、非最新回合、
 *   已加载、视图隐藏）。自动加载失败保持抑制不重试（旧行为）。
 */
export function resolveAssistantPreviewLoadAction(params: {
  autoPreviewEnabled: boolean;
  visible: boolean;
  hasMarkdownOrHtmlReference: boolean;
  hasTarget: boolean;
  fileChangesState: string | undefined;
  isLatestCompleteTurn: boolean;
  requestState: "none" | "loaded" | "failed";
}): AssistantPreviewLoadAction {
  const eligible =
    params.isLatestCompleteTurn &&
    params.hasMarkdownOrHtmlReference &&
    params.hasTarget &&
    // rewind 后 header 的 reverted 状态是权威投影：既不自动查，也不提供手动入口。
    params.fileChangesState !== "reverted";
  if (!eligible) return "none";
  if (params.requestState === "loaded") return "none";
  if (!params.visible) return "none";
  if (params.requestState === "failed") {
    return params.autoPreviewEnabled ? "none" : "manual";
  }
  return params.autoPreviewEnabled ? "auto" : "manual";
}
