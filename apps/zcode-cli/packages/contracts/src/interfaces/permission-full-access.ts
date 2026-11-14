import { z } from "zod";
import { contextProfileValues } from "@zcode/shared";

// 约束：shared(zod4) 与本包(zod3) 的 schema 不可直接组合，只能从公开值重建枚举。
const contextProfileSchema = z.enum(contextProfileValues);

export const PERMISSION_FULL_ACCESS_ENTRY = "runtime/permission_full_access";

/** 持久化 receipt 是授权重试事实源；损坏时拒绝重试，不能按当前队列重新扩大授权范围。 */
export const permissionFullAccessReceiptSchema = z
  .object({
    interactionId: z.string().min(1),
    event: z
      .object({
        id: z.string().min(1),
        sessionId: z.string().min(1),
        traceId: z.string().min(1),
        turnId: z.string().optional(),
        type: z.literal("session_mode_changed"),
        timestamp: z.coerce.date(),
        sequenceNumber: z.number().int().nonnegative(),
        payload: z
          .object({
            // 授权目标是完全访问；融合模式本身已复用完全访问，写 fusion 以免丢失融合提示词。
            // beta 是旧 receipt（原测试名）持久化值，保留做读取兼容。
            mode: z.enum(["yolo", "fusion", "beta"]),
            planEnabled: z.boolean(),
            /** 上下文档位；授权只改权限、保留档位。旧 receipt 无此字段。schema 复用 shared 契约源。 */
            contextProfile: contextProfileSchema.optional(),
            previousContextProfile: contextProfileSchema.optional(),
            previousMode: z.enum([
              "build",
              "edit",
              "yolo",
              "guarded",
              "auto",
              "plan",
              "research",
              "minimal",
              // 融合模式：additive；授权时保留本模式（事件与持久化同样写 fusion）。
              // beta 是旧值（原测试名），保留做旧 receipt 的读取兼容。
              "fusion",
              "beta",
            ]),
            previousPlanEnabled: z.boolean(),
            source: z.literal("command"),
            permissionGrant: z
              .object({
                interactionId: z.string().min(1),
                queueItemIds: z.array(z.string().min(1)),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (receipt) => receipt.interactionId === receipt.event.payload.permissionGrant.interactionId,
    {
      message: "Permission grant identity mismatch",
    },
  );
