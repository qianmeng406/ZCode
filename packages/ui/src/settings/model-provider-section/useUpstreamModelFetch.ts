import { useCallback, useRef, useState } from "react";
import type { ProviderUpstreamModelsResult } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";

/**
 * 上游模型拉取的弹窗内状态 owner：请求代次守卫丢弃 stale 结果，
 * 失败不清空已显示列表；草稿模型 ID 仍由添加模型草稿持有，选择仅写入草稿。
 */
export function useUpstreamModelFetch(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 无本地 cwd 时 fail-closed：不渲染入口、不发请求。 */
  enabled: boolean;
}) {
  const { providerSettingsService } = useServices();
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState<ProviderUpstreamModelsResult | null>(null);
  const latestTokenRef = useRef(0);

  // providerId 由调用点显式传入：同一状态 owner 可服务多个供应商卡片，
  // 切换 Provider 后的首次点击不能依赖尚未提交的 setState。
  const onFetch = useCallback(
    (providerId: string) => {
      if (!target.enabled || !providerId.trim()) return;
      const token = latestTokenRef.current + 1;
      latestTokenRef.current = token;
      setFetching(true);
      void providerSettingsService
        .fetchUpstreamModels({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          providerId,
        })
        .then((next) => {
          // 弹窗期间用户可能再次点击或切换 provider；旧请求结束时不能覆盖新状态。
          if (token === latestTokenRef.current) setResult(next);
        })
        .catch((error: unknown) => {
          if (token === latestTokenRef.current) {
            setResult({
              models: [],
              error: {
                code: "unknown",
                ...(error instanceof Error && error.message ? { message: error.message } : {}),
              },
            });
          }
        })
        .finally(() => {
          if (token === latestTokenRef.current) setFetching(false);
        });
    },
    [providerSettingsService, target.enabled, target.workspaceIdentity, target.workspacePath],
  );

  return { fetching, result, onFetch };
}
