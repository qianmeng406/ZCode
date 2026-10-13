import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { contextProfileSchema } from "../execution-state.js";

export const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // Bugfix：createSession.config 表达“请求覆盖字段”，不能复用 snapshot 的
  // sessionConfigStateSchema.partial()；snapshot 为兼容旧快照给 mode 设了 default("build")，
  // 会把“没传 mode”误变成“请求切回 build”，覆盖 workspace 默认 yolo。
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
  // 上下文档位：请求覆盖字段，缺省不覆盖（同 mode 的语义）。
  contextProfile: contextProfileSchema.optional(),
});
