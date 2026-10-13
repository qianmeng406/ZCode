import type { SwitchableCommandCenterMode } from "./types.js";

const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "guarded",
  "research",
  "minimal",
  "zcodeUpdate",
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
 * 命令中心 handler 里先 `args.toLowerCase()`，而 `zcodeUpdate` 是驼峰 id，
 * 小写后与规范字面不等——直接查表会把它误判成不支持。这里显式映射回来，
 * 调用方拿到的永远是可直接交给 setMode 的规范 id；返回 undefined 表示不支持。
 */
export function resolveSwitchableCommandCenterMode(
  lowercased: string,
): SwitchableCommandCenterMode | undefined {
  if (lowercased === "zcodeupdate") return "zcodeUpdate";
  return isSwitchableCommandCenterMode(lowercased) ? lowercased : undefined;
}
