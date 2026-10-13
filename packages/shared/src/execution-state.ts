import { z } from "zod";

/** auto 保留为内部权限；plan 仅在旧格式读取边界接受；research 为只读资料查询模式；
 * minimal 是旧「极简模式」的兼容值：历史会话继续按旧组合语义执行（上下文极简 +
 * 命令与修改免逐项确认）。新任务用独立 contextProfile 表达极简上下文，不再产生 mode=minimal；
 * zcodeUpdate 为 ZCode 更新模式（跟进官方发版：取 diff → 分析 → 本地实现 → 验收，权限同 yolo 自动执行）。 */
export const executionPermissionModeSchema = z.enum([
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
  "research",
  "minimal",
  "zcodeUpdate",
]);

/**
 * 上下文档位，与权限正交：
 * - standard：完整上下文（身份行为段、技能清单、记忆、项目指令等）；
 * - minimal：只留身份行、环境与短护栏，去掉技能/记忆/项目指令并隐藏 MCP/Skill 可见工具。
 * 它只影响未来请求的前缀与工具投影，不改变权限，也不删除已有历史。
 */
export const contextProfileSchema = z.enum(["standard", "minimal"]);
export type ContextProfile = z.infer<typeof contextProfileSchema>;

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
