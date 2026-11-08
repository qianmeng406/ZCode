// 外部 coding agent 的探测结果查询。
//
// 探测要在「真正执行的那台机器」上跑（远程会话的 CLI 在远端），所以这是一个 RPC
// 而不是 Host 本地 spawn。查询本身只读、无状态，因此按 workspace 缓存一次结果即可——
// 对话框重开不该每次再等三个 `--version`。

import type { V4ExternalAgentProbeResult } from "@zcode/shared/zcode-protocol-v4";

/** 一次探测结果 + 时间戳；null = 宿主不支持探测（UI 退回手填表单）。 */
export interface ExternalAgentProbeSnapshot {
  result: V4ExternalAgentProbeResult;
  probedAt: number;
}

const probeCache = new Map<string, ExternalAgentProbeSnapshot>();
const inflight = new Map<string, Promise<ExternalAgentProbeSnapshot | null>>();

/** 缓存有效期：安装状态变化很慢，但用户可能刚装完就回来点绑定。 */
const PROBE_TTL_MS = 60_000;

/** 单次探测的发送函数（由 SessionPane 注入，含命令通道与超时）。 */
export type ExternalAgentProbeSender = (
  workspaceId: string,
) => Promise<V4ExternalAgentProbeResult | null>;

export function getCachedExternalAgentProbe(
  workspaceId: string,
): ExternalAgentProbeSnapshot | null {
  const cached = probeCache.get(workspaceId);
  if (!cached) return null;
  if (Date.now() - cached.probedAt > PROBE_TTL_MS) return null;
  return cached;
}

/**
 * 取探测结果：命中缓存直接返回，否则发一次并缓存。
 *
 * 并发去重：对话框打开动画期间可能重渲染多次，不该并发打三条 `--version`。
 * 失败不缓存——下次打开应当重试，而不是把一次瞬时错误记成"没装"。
 */
export async function loadExternalAgentProbe(
  workspaceId: string,
  send: ExternalAgentProbeSender,
  options: { force?: boolean } = {},
): Promise<ExternalAgentProbeSnapshot | null> {
  if (!options.force) {
    const cached = getCachedExternalAgentProbe(workspaceId);
    if (cached) return cached;
  }
  const pending = inflight.get(workspaceId);
  if (pending) return await pending;

  const request = (async () => {
    try {
      const result = await send(workspaceId);
      if (!result) return null;
      const snapshot = { result, probedAt: Date.now() };
      // 全失败（每条都带 probeError）不写缓存：这是"问不到"，不是"问到了没装"。
      // 写进去会让后续重试命中缓存直接返回同一份失败结果，重试形同虚设。
      if (!result.agents.every((agent) => agent.probeError)) {
        probeCache.set(workspaceId, snapshot);
      }
      return snapshot;
    } catch {
      return null;
    } finally {
      inflight.delete(workspaceId);
    }
  })();
  inflight.set(workspaceId, request);
  return await request;
}

/** 测试用：清空缓存。 */
export function resetExternalAgentProbeCache(): void {
  probeCache.clear();
  inflight.clear();
}
