import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();
const contextProfileChecks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}

/**
 * 显式 contextProfile 是 additive 字段：旧 CLI 的 schema 会静默丢掉它并按标准上下文执行，
 * 用户选的极简档位就无声失效。发送显式 minimal 前确认执行端，缺能力时报不支持而不是降级。
 */
export function ensureContextProfileSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = contextProfileChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.contextProfileState !== true) throw new Error("proto.contextProfileUnsupported");
    })
    .catch((cause: unknown) => {
      contextProfileChecks.delete(client);
      throw new Error("proto.contextProfileUnsupported", { cause });
    });
  contextProfileChecks.set(client, check);
  return check;
}
