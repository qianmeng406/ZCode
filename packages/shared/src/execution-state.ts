import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；research 为只读资料查询模式；
 * minimal 是旧「极简模式」的兼容值：历史会话继续按旧组合语义执行（上下文极简 +
 * 命令与修改免逐项确认）。新任务用独立 contextProfile 表达极简上下文，不再产生 mode=minimal。
 * fusion 是独立工作模式（原测试名 Beta，2026-11-15 定名「融合模式」）：权限明确复用
 * 完全访问（yolo）策略，上下文走完整档位、主代理注入融合行为提示词；与权限/Plan 正交的
 * fusion 档位不再承担本模式的表达（本模式只允许 standard 上下文）。
 * beta 不保留在枚举里（zcodeUpdate 同款先例）：旧持久化/协议值由下方 LEGACY_MODE_ALIASES
 * 在解析边界归一为 fusion。zcodeUpdate 已移除，见 docs/upstream-sync.md。 */
export const executionPermissionModeSchema = z.enum([
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
  "research",
  "minimal",
  "fusion",
]);

/** 旧工作模式值 → 现值。只在解析边界归一，不进枚举：新代码不得再产生旧值。 */
const LEGACY_MODE_ALIASES: Record<string, string> = { beta: "fusion" };

/** 可提交的工作模式值域：auto 是运行时内部权限态，用户提交永不携带。 */
export type SubmittableWorkMode = Exclude<ExecutionState["mode"], "auto">;

/**
 * 把旧协议/持久化里的工作模式值归一为现值（beta → fusion）。
 *
 * 协议层枚举（ZCodeSessionMode / SubmissionMode）保留旧值做读取兼容，而运行时入口
 * 不接受旧值；任何把协议值送进运行时的边界都应先过一次这里，否则会要么类型断裂、
 * 要么让旧值绕过本文件的 resolve* 归一。
 */
export function normalizeLegacyWorkMode(mode: string | undefined): SubmittableWorkMode | undefined {
  if (mode === undefined) return undefined;
  return (LEGACY_MODE_ALIASES[mode] ?? mode) as SubmittableWorkMode;
}

function normalizeLegacyMode(mode: unknown): unknown {
  return typeof mode === "string" ? (LEGACY_MODE_ALIASES[mode] ?? mode) : mode;
}

/**
 * 上下文档位，与权限正交：
 * - standard：完整上下文（身份行为段、技能清单、记忆、项目指令等）；
 * - minimal：只留身份行、环境与短护栏，去掉技能/记忆/项目指令并隐藏 MCP/Skill 可见工具。
 * - fusion：融合档位，保持身份、权限、安全边界、桌面能力、技能、项目指令、记忆与工具集，
 *   只替换默认动态行为与上下文管理规则；权限与 Plan 语义不变。
 *   融合模式（mode=fusion）发布后 fusion 转为历史读取兼容档位：新 UI 用 mode=fusion
 *   选择融合模式；旧权限+fusion 组合（含 build+fusion）保持原语义直到显式切模式，不升级
 *   为融合模式（它拥有完全访问权限，自动升级会静默改变历史会话的确认策略）。
 * 它只影响未来请求的前缀与工具投影，不改变权限，也不删除已有历史。
 */
export const contextProfileSchema = z.enum(["standard", "minimal", "fusion"]);
export type ContextProfile = z.infer<typeof contextProfileSchema>;
/** 约束：跨 Zod 版本的包经此元组重建枚举，值源唯一。 */
export const contextProfileValues = contextProfileSchema.options as [
  "standard",
  "minimal",
  "fusion",
];

/** 持久化/协议形态：contextProfile 允许缺省（旧值/旧发送端）；权威结果由 resolveExecutionState 补齐。 */
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
  contextProfile: contextProfileSchema.optional(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** 解析上下文档位：显式值优先；旧 mode=minimal 补出极简档位以保持历史行为。 */
export function resolveContextProfile(state: {
  mode?: string;
  contextProfile?: string;
}): ContextProfile {
  const profile = contextProfileSchema.safeParse(state.contextProfile);
  if (profile.success) return profile.data;
  return state.mode === "minimal" ? "minimal" : "standard";
}

/** 解析结果始终携带档位（缺省由兼容映射补齐）；输入/持久化形态允许缺省。 */
export type ResolvedExecutionState = ExecutionState & { contextProfile: ContextProfile };

/**
 * 融合模式与上下文档位的互斥归一（见 fusion-context-profile.md「历史兼容与能力协商」）。
 * `modeChanged=false` 表示 mode 缺省或重申 current（权限/Plan patch、同模式提交），档位原样保留；
 * `modeChanged=true` 表示用户显式选择了不同的工作模式，是权威的切换信号。
 *
 * - 本模式必须拿到完整上下文与完整工具表：强制 standard，覆盖遗留 fusion/minimal；
 * - 显式变更为非本模式时清掉遗留 fusion（退出融合提示词），且不反迁移回本模式；
 * - 其余权限（yolo/guarded/edit/research…）与 fusion 的历史组合不得静默改变权限，
 *   原样保留直到用户显式选择工作模式（提交正文、同模式重申都不算切换）。
 */
function reconcileBetaAndContextProfile(
  mode: ExecutionState["mode"],
  contextProfile: ContextProfile,
  /** mode 是否相对 current 发生显式变更：重申现状不改档位。 */
  modeChanged: boolean,
): { mode: ExecutionState["mode"]; contextProfile: ContextProfile } {
  if (mode === "fusion") return { mode, contextProfile: "standard" };
  if (contextProfile === "fusion" && modeChanged) {
    // 显式变更到非融合模式的工作模式：清掉遗留融合提示词；UI 菜单的规范档位选择
    // 在草稿切换层完成，这里只负责变更归一，不误伤同模式重交的历史组合。
    return { mode, contextProfile: "standard" };
  }
  return { mode, contextProfile };
}

/**
 * 恢复/读取边界专用：把旧持久化的完整执行状态归一为当前语义。
 * - fusion（含旧值 beta）+fusion 档位任何来源都归一为 fusion+standard（必须完整上下文）；
 * - build+fusion 等其余权限+fusion 的历史组合原样保留：本模式拥有完全访问权限，
 *   把 build+fusion 升级成它（yolo 权限）会静默改变旧会话的确认策略，因此不做该迁移；
 * - 恢复不是用户切换，不在此清除遗留 fusion；显式切模式的清理由 resolveExecutionState 负责。
 */
export function resolveRestoredExecutionState(
  state: { mode?: string; planEnabled?: boolean; contextProfile?: string },
  current: ExecutionState = { mode: "build", planEnabled: false, contextProfile: "standard" },
): ResolvedExecutionState {
  // 读取边界只做无损归一：
  // - fusion+fusion 归一 fusion+standard（本模式强制完整上下文；旧值 beta 先归一）；
  // - 其余权限与 fusion 的历史组合原样保留（含 build+fusion）；
  // - 其余状态走常规解析（含旧 mode=minimal 兼容映射）。
  const normalizedMode = normalizeLegacyMode(state.mode);
  const profile = contextProfileSchema.safeParse(state.contextProfile);
  if (profile.success && profile.data === "fusion") {
    const mode = executionPermissionModeSchema.safeParse(normalizedMode);
    if (mode.success) {
      return {
        mode: mode.data,
        planEnabled: state.planEnabled ?? current.planEnabled,
        contextProfile: mode.data === "fusion" ? "standard" : "fusion",
      };
    }
  }
  return resolveExecutionState({ ...state, mode: normalizedMode as string | undefined }, current);
}

/** 在接纳边界固定旧请求语义，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean; contextProfile?: string },
  current: ExecutionState = { mode: "build", planEnabled: false, contextProfile: "standard" },
): ResolvedExecutionState {
  const mode = executionPermissionModeSchema.safeParse(normalizeLegacyMode(input.mode));
  const profile = contextProfileSchema.safeParse(input.contextProfile);
  // 解析出的 mode 权威值；显式非本模式同时是「退出融合模式」的信号。
  const parsedMode: ExecutionState["mode"] = mode.success ? mode.data : current.mode;
  // 档位只在显式给出时改变（改权限/Plan/授权都保留档位）；input.mode === "minimal"
  // 是旧组合语义，补出极简档位，历史会话行为不变。
  const parsedProfile: ContextProfile = profile.success
    ? profile.data
    : input.mode === "minimal"
      ? "minimal"
      : resolveContextProfile(current);
  const { mode: resolvedMode, contextProfile } = reconcileBetaAndContextProfile(
    parsedMode,
    parsedProfile,
    // 显式「变更」而非显式「给出」：同模式重申（含带 mode 字段的常规提交）不是切换，
    // 只有相对 current 真正改了工作模式才清遗留融合档位。
    mode.success && parsedMode !== current.mode,
  );
  return {
    mode: resolvedMode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
    contextProfile,
  };
}
