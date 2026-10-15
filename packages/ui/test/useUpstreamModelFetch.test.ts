// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { IProviderSettingsService, ProviderUpstreamModelsResult } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useUpstreamModelFetch } from "@/settings/model-provider-section/useUpstreamModelFetch.js";

function createWrapper(service: Partial<IProviderSettingsService>) {
  return ({ children }: { children: ReactNode }) =>
    ServiceProvider({
      services: { providerSettingsService: service } as never,
      children,
    });
}

describe("useUpstreamModelFetch", () => {
  it("拉取成功把结果写入状态，并携带显式 providerId", async () => {
    const fetchUpstreamModels = vi.fn(async () => ({
      models: ["glm-5", "glm-5-air"] as const,
    }));
    const hook = renderHook(() => useUpstreamModelFetch({ workspacePath: "/w", enabled: true }), {
      wrapper: createWrapper({ fetchUpstreamModels }),
    });
    expect(hook.result.current.fetching).toBe(false);

    await act(async () => {
      hook.result.current.onFetch("provider-a");
    });
    await waitFor(() => expect(hook.result.current.fetching).toBe(false));
    expect(hook.result.current.result).toEqual({ models: ["glm-5", "glm-5-air"] });
    expect(fetchUpstreamModels).toHaveBeenCalledWith({
      workspacePath: "/w",
      providerId: "provider-a",
    });
  });

  it("stale 请求结束时不覆盖新请求的结果", async () => {
    let resolveFirst: (value: ProviderUpstreamModelsResult) => void = () => {};
    const first = new Promise<ProviderUpstreamModelsResult>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchUpstreamModels = vi
      .fn<
        (input: {
          workspacePath: string;
          providerId: string;
        }) => Promise<ProviderUpstreamModelsResult>
      >()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ models: ["new-model"] });
    const hook = renderHook(() => useUpstreamModelFetch({ workspacePath: "/w", enabled: true }), {
      wrapper: createWrapper({ fetchUpstreamModels }),
    });

    await act(async () => {
      hook.result.current.onFetch("provider-a");
    });
    await act(async () => {
      hook.result.current.onFetch("provider-b");
    });
    await waitFor(() => expect(hook.result.current.fetching).toBe(false));
    // 旧请求晚到：不得把新代次的结果顶掉。
    await act(async () => {
      resolveFirst({ models: ["stale-model"] });
      await first;
    });
    expect(hook.result.current.result).toEqual({ models: ["new-model"] });
  });

  it("rejected 请求降级为 unknown 错误码，不清空已有结果列表", async () => {
    const fetchUpstreamModels = vi
      .fn<() => Promise<ProviderUpstreamModelsResult>>()
      .mockResolvedValueOnce({ models: ["glm-5"] })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const hook = renderHook(() => useUpstreamModelFetch({ workspacePath: "/w", enabled: true }), {
      wrapper: createWrapper({ fetchUpstreamModels }),
    });

    await act(async () => {
      hook.result.current.onFetch("provider-a");
    });
    await waitFor(() => expect(hook.result.current.result?.models).toEqual(["glm-5"]));

    await act(async () => {
      hook.result.current.onFetch("provider-a");
    });
    await waitFor(() => expect(hook.result.current.fetching).toBe(false));
    expect(hook.result.current.result?.error?.code).toBe("unknown");
  });

  it("disabled（远程无本地 cwd）时不发请求", async () => {
    const fetchUpstreamModels = vi.fn(async () => ({ models: ["glm-5"] }));
    const hook = renderHook(() => useUpstreamModelFetch({ workspacePath: "", enabled: false }), {
      wrapper: createWrapper({ fetchUpstreamModels }),
    });
    await act(async () => {
      hook.result.current.onFetch("provider-a");
    });
    expect(fetchUpstreamModels).not.toHaveBeenCalled();
  });
});
