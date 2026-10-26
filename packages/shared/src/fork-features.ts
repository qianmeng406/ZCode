import { z } from "zod";

/**
 * fork 定制功能开关集合。
 *
 * 每个开关都遵循「关闭即原型」：关闭时不注册工具、不渲染入口、服务端方法直接拒绝，
 * 行为回到这个 fork 引入该功能之前的状态。除 `promptOptimizer` 外一律默认 false——
 * 那个功能在本 fork 已经存在，原型语义是「有」，默认关闭会等同于删功能。
 *
 * 为什么这些开关不放进 `AppSettings` 的一堆顶层字段：它们生命周期一致（都要下发到
 * runtime、都要在设置页同一分区开关），嵌套成对象后，patch/广播/冷恢复各自只需要
 * 一个字段，新增开关不再散落改六处 schema。
 */
export const FORK_FEATURE_KEYS = [
  "monitorTool",
  "notebookEdit",
  "applyPatch",
  "promptOptimizer",
  "memoryFileEditing",
  "memoryCapture",
  "memoryDreamManual",
] as const;

export type ForkFeatureKey = (typeof FORK_FEATURE_KEYS)[number];
export type ForkFeatures = Record<ForkFeatureKey, boolean>;

export const DEFAULT_FORK_FEATURES: ForkFeatures = {
  monitorTool: false,
  notebookEdit: false,
  applyPatch: false,
  promptOptimizer: true,
  memoryFileEditing: false,
  memoryCapture: false,
  memoryDreamManual: false,
};

/**
 * 对象本身（不含整对象缺省）。广播 payload 用它 + `.optional()`：旧窗口发出的广播不带
 * 这个键，解析结果必须仍然是"没有这个键"，不能凭空补一份默认值。
 */
export const forkFeaturesObjectSchema = z
  .object({
    monitorTool: z.boolean().default(false),
    notebookEdit: z.boolean().default(false),
    applyPatch: z.boolean().default(false),
    promptOptimizer: z.boolean().default(true),
    memoryFileEditing: z.boolean().default(false),
    memoryCapture: z.boolean().default(false),
    memoryDreamManual: z.boolean().default(false),
  })
  .strict();

/** 读取侧：整对象缺席时回落到 DEFAULT_FORK_FEATURES（旧 setting.json / 旧 Host）。 */
export const forkFeaturesSchema = forkFeaturesObjectSchema.default(() => ({
  ...DEFAULT_FORK_FEATURES,
}));

/**
 * 写路径（AppSettings patch）用的 schema：**七个字段全部必填**。
 *
 * SettingService 的 patch 合并是浅合并，`{ forkFeatures: { monitorTool: true } }` 会把其余
 * 开关整体替换掉。这里用必填字段把这种调用在 schema 边界直接打回，避免运行期静默重置。
 */
export const forkFeaturesPatchSchema = z
  .object({
    monitorTool: z.boolean(),
    notebookEdit: z.boolean(),
    applyPatch: z.boolean(),
    promptOptimizer: z.boolean(),
    memoryFileEditing: z.boolean(),
    memoryCapture: z.boolean(),
    memoryDreamManual: z.boolean(),
  })
  .strict();

/**
 * 需要改动运行时工具注册表的三个开关。单独成 schema 是因为它们走一条独立的
 * workspace/updateForkToolPreferences 协议方法即时下发，其余四个只在读取侧判断。
 */
export const forkToolPreferencesSchema = z
  .object({
    monitorTool: z.boolean(),
    notebookEdit: z.boolean(),
    applyPatch: z.boolean(),
  })
  .strict();

export type ForkToolPreferences = z.infer<typeof forkToolPreferencesSchema>;

export const FORK_TOOL_FEATURE_KEYS = [
  "monitorTool",
  "notebookEdit",
  "applyPatch",
] as const satisfies readonly ForkFeatureKey[];

export function pickForkToolPreferences(features: ForkFeatures): ForkToolPreferences {
  return {
    monitorTool: features.monitorTool,
    notebookEdit: features.notebookEdit,
    applyPatch: features.applyPatch,
  };
}

/** patch 里出现 forkFeatures 时必须是完整对象；调用方用这个 helper 从当前设置构造。 */
export function resolveForkFeatures(current: Partial<ForkFeatures> | undefined): ForkFeatures {
  return { ...DEFAULT_FORK_FEATURES, ...current };
}
