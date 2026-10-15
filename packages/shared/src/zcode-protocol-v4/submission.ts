import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。 */
export const submissionModeSchema = z.enum([
  "build",
  "edit",
  "plan",
  "yolo",
  "guarded",
  "research",
  "minimal",
  // Beta 独立工作模式（提示词融合模式测试版本）：additive；发送前须协商 betaMode 能力位。
  "beta",
]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
