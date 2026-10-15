import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();
const contextProfileChecks = new WeakMap<object, Promise<void>>();
const fusionContextProfileChecks = new WeakMap<object, Promise<void>>();
const betaModeChecks = new WeakMap<object, Promise<void>>();

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

/**
 * 融合档位（contextProfile=fusion）是 additive 能力：现有 contextProfileState 只证明
 * standard/minimal，不能放行 fusion。发送显式 fusion 前确认执行端的独立能力位，
 * 缺能力时报不支持而不是静默按 standard 降级；standard/minimal 不做额外拒绝。
 */
export function ensureFusionContextProfileSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = fusionContextProfileChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.fusionContextProfile !== true)
        throw new Error("proto.fusionContextProfileUnsupported");
    })
    .catch((cause: unknown) => {
      fusionContextProfileChecks.delete(client);
      throw new Error("proto.fusionContextProfileUnsupported", { cause });
    });
  fusionContextProfileChecks.set(client, check);
  return check;
}

/**
 * Beta 独立工作模式（mode=beta）是 additive 能力：现有 fusionContextProfile 只证明
 * 历史融合档位支持，不能放行 Beta（旧端两者支持集不同）。创建会话、改状态或提交输入
 * 携带显式 mode=beta 前确认执行端的独立 betaMode 能力位，缺能力时报
 * proto.betaModeUnsupported 而不是静默降级到其他模式或继承当前权限。
 */
export function ensureBetaModeSupport(client: Pick<ZCodeProtocolClient, "request">): Promise<void> {
  const cached = betaModeChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.betaMode !== true) throw new Error("proto.betaModeUnsupported");
    })
    .catch((cause: unknown) => {
      betaModeChecks.delete(client);
      throw new Error("proto.betaModeUnsupported", { cause });
    });
  betaModeChecks.set(client, check);
  return check;
}
