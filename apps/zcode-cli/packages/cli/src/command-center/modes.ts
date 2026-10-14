import type { SwitchableCommandCenterMode } from "./types.js";

const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "guarded",
  "research",
  "minimal",
  "yolo",
] as const satisfies readonly SwitchableCommandCenterMode[];

export function formatAvailableCommandCenterModes(): string {
  // 菜单不再推荐 Edit；显式旧命令仍由完整值域校验，不触发模式迁移。
  return SWITCHABLE_COMMAND_CENTER_MODES.filter((mode) => mode !== "edit").join(", ");
}

export function isSwitchableCommandCenterMode(value: string): value is SwitchableCommandCenterMode {
  return SWITCHABLE_COMMAND_CENTER_MODES.includes(value as SwitchableCommandCenterMode);
}

/**
 * 把已小写的用户输入映射回规范模式字面。
 *
 * 命令中心 handler 里先 `args.toLowerCase()`；当前全部规范 id 都是小写单字，
 * 直接查表即可。返回 undefined 表示不支持。（zcodeUpdate 驼峰 id 的映射已随
 * ZCode 更新模式移除；遗留输入会落回不支持。）
 */
export function resolveSwitchableCommandCenterMode(
  lowercased: string,
): SwitchableCommandCenterMode | undefined {
  return isSwitchableCommandCenterMode(lowercased) ? lowercased : undefined;
}
