import type { ForkToolPreferences } from "@zcode/shared";
import { builtInTools } from "../../tool/handlers/index.js";
import type { ToolEntry } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * fork 工具开关 → 运行中注册表的两段式应用。
 *
 * 为什么不是一步到位：工具调用在流式过程中就可能已经声明，若在 turn 进行中直接
 * `unregister`，`call-runner` 会在执行阶段拿到 `ToolNotFound`，用户看到的是一个
 * 莫名其妙的工具错误。因此拆成：
 *   1) 可见性立即生效——清 `cachedTools` 并推进 `contextProjectionRevision`，下一个 model
 *      step 的工具表与 ToolSearch 目录就不再有它；
 *   2) 注册表增删延后到没有 active turn 时（`finishActiveTurn` 调用 apply）。
 *
 * 关闭时必须显式 `unregister`：`registerBuiltInTools` 只做加法，重复注册不会移除旧工具，
 * 清缓存后它还会被重新投影出来。
 */
const FORK_TOOL_NAMES = {
  monitorTool: "Monitor",
  notebookEdit: "NotebookEdit",
  applyPatch: "ApplyPatch",
} as const satisfies Record<keyof ForkToolPreferences, string>;

function findForkToolEntry(toolName: string): ToolEntry | undefined {
  return builtInTools.find((entry) => entry.metadata.name === toolName);
}

export function updateForkToolSwitches(
  this: AgentRuntimeInternal,
  preferences: ForkToolPreferences,
): void {
  this.config.forkToolSwitches = { ...preferences };
  // 可见性即时生效：即使注册表稍后才动，本 turn 的下一次模型请求也看不到旧工具面。
  this.cachedTools = null;
  this.contextProjectionRevision += 1;
  if (this.activeTurn !== undefined) {
    this.pendingForkToolSwitchApply = true;
    return;
  }
  applyForkToolSwitchRegistry.call(this);
}

export function applyForkToolSwitchRegistry(this: AgentRuntimeInternal): void {
  this.pendingForkToolSwitchApply = false;
  const preferences = this.config.forkToolSwitches;
  if (!preferences) return;
  for (const key of Object.keys(FORK_TOOL_NAMES) as Array<keyof ForkToolPreferences>) {
    const toolName = FORK_TOOL_NAMES[key];
    const entry = findForkToolEntry(toolName);
    // 工具实现随独立提交引入；接线先行的窗口里查不到就跳过，不影响其余开关。
    if (!entry) continue;
    if (preferences[key]) {
      this.registry.register(entry, { silentDuplicateWarning: true });
    } else {
      this.registry.unregister(toolName);
    }
  }
  this.cachedTools = null;
}
