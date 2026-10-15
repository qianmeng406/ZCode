import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；research 为只读资料查询模式；
 * minimal 是旧「极简模式」的兼容值：历史会话继续按旧组合语义执行（上下文极简 +
 * 命令与修改免逐项确认）。新任务用独立 contextProfile 表达极简上下文，不再产生 mode=minimal。
 * zcodeUpdate（ZCode 更新模式）已移除：fork 版本改为按 docs/upstream-sync.md 的常规上游合并流程更新。 */
export const executionPermissionModeSchema = z.enum([
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
  "research",
  "minimal",
]);

/**
 * 上下文档位，与权限正交：
 * - standard：完整上下文（身份行为段、技能清单、记忆、项目指令等）；
 * - minimal：只留身份行、环境与短护栏，去掉技能/记忆/项目指令并隐藏 MCP/Skill 可见工具。
 * - fusion：融合档位，保持身份、权限、安全边界、桌面能力、技能、项目指令、记忆与工具集，
 *   只替换默认动态行为与上下文管理规则；权限与 Plan 语义不变。
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

/** 在接纳边界固定旧请求语义，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean; contextProfile?: string },
  current: ExecutionState = { mode: "build", planEnabled: false, contextProfile: "standard" },
): ResolvedExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  const profile = contextProfileSchema.safeParse(input.contextProfile);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
    // 档位只在显式给出时改变（改权限/Plan/授权都保留档位）；input.mode === "minimal"
    // 是旧组合语义，补出极简档位，历史会话行为不变。
    contextProfile: profile.success
      ? profile.data
      : input.mode === "minimal"
        ? "minimal"
        : resolveContextProfile(current),
  };
}
