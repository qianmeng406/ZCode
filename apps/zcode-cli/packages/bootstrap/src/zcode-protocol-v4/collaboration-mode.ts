import type { CollaborationMode } from "@zcode/contracts";
import type { ZCodeSessionMode } from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";

/** 运行时可提交的协作模式：auto 是内部权限态，协议 payload 永不携带。 */
export type SubmittableCollaborationMode = Exclude<CollaborationMode, "auto">;

/**
 * 协议侧模式值 → 运行时协作模式。
 *
 * 协议/持久化枚举（ZCodeSessionMode / SubmissionMode）保留旧测试名 `beta` 做读取兼容，
 * 运行时已改名为 `fusion`（不收旧值）：旧 payload 在进入运行时写路径前在这里归一，
 * 避免类型断裂，也保证旧值不会绕过 shared resolve* 的归一边界。
 */
export function toCollaborationMode(
  mode: ZCodeSessionMode | SubmissionMode,
): SubmittableCollaborationMode;
export function toCollaborationMode(
  mode: ZCodeSessionMode | SubmissionMode | undefined,
): SubmittableCollaborationMode | undefined;
export function toCollaborationMode(
  mode: ZCodeSessionMode | SubmissionMode | undefined,
): SubmittableCollaborationMode | undefined {
  if (mode === undefined) return undefined;
  // "auto" 是运行时内部权限态，协议 payload 永不携带；这里按提交值域收窄。
  return mode === "beta" ? "fusion" : (mode as SubmittableCollaborationMode);
}
