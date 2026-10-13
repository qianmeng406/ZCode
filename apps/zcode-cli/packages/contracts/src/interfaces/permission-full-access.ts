import { z } from "zod";

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
            mode: z.literal("yolo"),
            planEnabled: z.boolean(),
            /** 上下文档位；授权只改权限、保留档位。旧 receipt 无此字段。 */
            contextProfile: z.enum(["standard", "minimal"]).optional(),
            previousContextProfile: z.enum(["standard", "minimal"]).optional(),
            previousMode: z.enum([
              "build",
              "edit",
              "yolo",
              "guarded",
              "auto",
              "plan",
              "research",
              "minimal",
              "zcodeUpdate",
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
