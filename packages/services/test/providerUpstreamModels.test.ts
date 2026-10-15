import { describe, expect, it, vi } from "vitest";
import {
  createProviderSettingsService,
  type ProviderSettingsFacade,
  type ProviderUpstreamModelsFetcher,
} from "../src/model-provider/providerFacadeServices.js";

function createMinimalFacade(): ProviderSettingsFacade {
  return {
    onDidChange: vi.fn(() => () => {}),
    getView: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    waitForProviderOperations: vi.fn(async () => {}),
  } as unknown as ProviderSettingsFacade;
}

describe("Provider Settings upstream models", () => {
  it("未装配拉取能力时返回 unsupported，不抛断 RPC 面", async () => {
    const service = createProviderSettingsService(createMinimalFacade());
    await expect(
      service.fetchUpstreamModels({ workspacePath: "/w", providerId: "p1" }),
    ).resolves.toEqual({ models: [], error: { code: "unsupported" } });
  });

  it("把 workspacePath/identity/providerId 原样交给拉取器并透传结果", async () => {
    const fetcher = vi.fn<ProviderUpstreamModelsFetcher>(async () => ({
      models: ["glm-5", "glm-5-air"],
    }));
    const service = createProviderSettingsService(
      createMinimalFacade(),
      undefined,
      undefined,
      fetcher,
    );

    await expect(
      service.fetchUpstreamModels({
        workspacePath: "/remote/project",
        workspaceIdentity: "ssh:box:/remote/project",
        providerId: "personal-api",
      }),
    ).resolves.toEqual({ models: ["glm-5", "glm-5-air"] });
    expect(fetcher).toHaveBeenCalledWith({
      workspacePath: "/remote/project",
      workspaceIdentity: "ssh:box:/remote/project",
      providerId: "personal-api",
    });
  });

  it("失败结果（空列表 + 脱敏错误码）原样透传，不生成第二套错误文案", async () => {
    const fetcher = vi.fn<ProviderUpstreamModelsFetcher>(async () => ({
      models: [],
      error: { code: "unauthorized" },
    }));
    const service = createProviderSettingsService(
      createMinimalFacade(),
      undefined,
      undefined,
      fetcher,
    );

    await expect(
      service.fetchUpstreamModels({ workspacePath: "/w", providerId: "p1" }),
    ).resolves.toEqual({ models: [], error: { code: "unauthorized" } });
  });
});
