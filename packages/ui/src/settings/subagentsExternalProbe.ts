// 设置页外部 CLI 探测结果的模块级缓存（S6）。
//
// 与 v4/composer/externalAgentProbe.ts 的思路一致但独立实现：绑定对话框的缓存
// 按会话 workspaceId 走 session transport；这里按设置页 scope 目标键缓存、经
// subagentsService RPC（本机/远端设备各自的 host），两个消费面的通道不同，
// 不跨模块耦合。
//
// 只读、无状态、超时重发安全：装机状态变化慢，TTL 60s 足够；探测失败不缓存，
// 下次打开表单应当重试，而不是把一次瞬时错误记成"没装"。
import type { ExternalAgentPresetStatus } from "@zcode/shared";

const PROBE_TTL_MS = 60_000;

interface ProbeCacheEntry {
  result: ExternalAgentPresetStatus[];
  probedAt: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();
const inflight = new Map<string, Promise<ExternalAgentPresetStatus[] | null>>();

/**
 * 取探测结果：命中缓存直接返回，否则发一次并缓存。
 *
 * 返回 null = 宿主不支持探测（老 Host / CLI 环境），表单退静态目录 + 自由输入；
 * 不缓存 null，让下次进入表单有机会重试。
 */
export async function loadSubagentsExternalProbe(
  targetKey: string,
  send: () => Promise<ExternalAgentPresetStatus[] | null>,
  options: { force?: boolean } = {},
): Promise<ExternalAgentPresetStatus[] | null> {
  if (!options.force) {
    const hit = probeCache.get(targetKey);
    if (hit && Date.now() - hit.probedAt <= PROBE_TTL_MS) return hit.result;
  }
  const pending = inflight.get(targetKey);
  if (pending) return await pending;
  const request = (async () => {
    try {
      const result = await send();
      if (result) probeCache.set(targetKey, { result, probedAt: Date.now() });
      return result;
    } finally {
      inflight.delete(targetKey);
    }
  })();
  inflight.set(targetKey, request);
  return await request;
}

/** 测试用：清空缓存。 */
export function resetSubagentsExternalProbeCache(): void {
  probeCache.clear();
  inflight.clear();
}
