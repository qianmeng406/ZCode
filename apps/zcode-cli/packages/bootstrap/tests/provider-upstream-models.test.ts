import { describe, expect, it } from "vitest";
import {
  createRegistryUpstreamEndpointResolver,
  fetchProviderUpstreamModels,
  resolveProviderUpstreamEndpoint,
  type ProviderUpstreamEndpoint,
} from "../src/zcode-protocol/provider-upstream-models.js";
import {
  HttpClientPortError,
  type HttpClientPort,
  type HttpClientResponse,
} from "@zcode/contracts";
import type { ProviderConfig } from "@zcode/provider";

const workspace = { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" };

function stubHttpResponse(body: string, status = 200): HttpClientResponse {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  return {
    url: "https://api.example.com/v1/models",
    status,
    statusText: "OK",
    headers: {},
    body: bytes,
    bytes: bytes.byteLength,
    durationMs: 1,
    egress: { proxied: false },
  };
}

function stubHttpClient(respond: () => Promise<HttpClientResponse>): {
  port: HttpClientPort;
  requests: { url: string; headers?: Record<string, string> }[];
} {
  const requests: { url: string; headers?: Record<string, string> }[] = [];
  return {
    requests,
    port: {
      async request(request) {
        requests.push({ url: request.url, headers: request.headers });
        return respond();
      },
    },
  };
}

function createContext(
  overrides: {
    refreshProviderRegistry?: (reason: string) => Promise<void>;
  } = {},
) {
  return {
    deps: { refreshProviderRegistry: overrides.refreshProviderRegistry },
  } as unknown as Parameters<typeof fetchProviderUpstreamModels>[0];
}

describe("provider/fetchUpstreamModels handler", () => {
  it("OpenAI-compatible provider 用 Registry endpoint/key/headers 请求 {baseUrl}/models 并去重", async () => {
    const endpoint: ProviderUpstreamEndpoint = {
      apiType: "openai-chat-completions",
      baseUrl: "https://api.example.com/v1/",
      apiKey: "sk-test",
      extraHeaders: { "x-custom": "1" },
    };
    const { port, requests } = stubHttpClient(async () =>
      stubHttpResponse(
        JSON.stringify({
          data: [{ id: "glm-5" }, { id: "glm-5" }, { id: "glm-5-air" }, { id: " " }],
        }),
      ),
    );
    const context = createContext({ refreshProviderRegistry: async () => {} });
    const result = await fetchProviderUpstreamModels(
      context,
      { resolveProviderEndpoint: () => endpoint, httpClient: port },
      { workspace, providerId: "p1" },
    );
    expect(result).toEqual({ models: ["glm-5", "glm-5-air"] });
    expect(requests[0]?.url).toBe("https://api.example.com/v1/models");
    expect(requests[0]?.headers?.authorization).toBe("Bearer sk-test");
    expect(requests[0]?.headers?.["x-custom"]).toBe("1");
  });

  it("anthropic-messages 等未支持 api type 显式返回 unsupported", async () => {
    const endpoint: ProviderUpstreamEndpoint = {
      apiType: "anthropic-messages",
      baseUrl: "https://api.example.com",
    };
    const { port, requests } = stubHttpClient(async () => stubHttpResponse("{}", 200));
    const result = await fetchProviderUpstreamModels(
      createContext(),
      { resolveProviderEndpoint: () => endpoint, httpClient: port },
      { workspace, providerId: "p1" },
    );
    expect(result).toEqual({ models: [], error: { code: "unsupported" } });
    expect(requests).toHaveLength(0);
  });

  it("Registry 无该 Provider 时按 provider-unavailable 降级", async () => {
    const { port } = stubHttpClient(async () => stubHttpResponse("{}", 200));
    const result = await fetchProviderUpstreamModels(
      createContext(),
      { resolveProviderEndpoint: () => undefined, httpClient: port },
      { workspace, providerId: "missing" },
    );
    expect(result).toEqual({ models: [], error: { code: "provider-unavailable" } });
  });

  it("401/403 返回 unauthorized，404 返回 not-found，均不携带上游响应体", async () => {
    const endpoint: ProviderUpstreamEndpoint = {
      apiType: "openai-chat-completions",
      baseUrl: "https://api.example.com/v1",
    };
    const { port } = stubHttpClient(async () => stubHttpResponse('{"secret":"leak"}', 401));
    const unauthorized = await fetchProviderUpstreamModels(
      createContext(),
      { resolveProviderEndpoint: () => endpoint, httpClient: port },
      { workspace, providerId: "p1" },
    );
    expect(unauthorized).toEqual({ models: [], error: { code: "unauthorized" } });

    const notFound = await fetchProviderUpstreamModels(
      createContext(),
      {
        resolveProviderEndpoint: () => endpoint,
        httpClient: stubHttpClient(async () => stubHttpResponse("{}", 404)).port,
      },
      { workspace, providerId: "p1" },
    );
    expect(notFound).toEqual({ models: [], error: { code: "not-found" } });
  });

  it("非 JSON/缺 data 的响应返回 malformed-response；HTTP 错误分类为 network/timeout", async () => {
    const endpoint: ProviderUpstreamEndpoint = {
      apiType: "openai-chat-completions",
      baseUrl: "https://api.example.com/v1",
    };
    const malformed = await fetchProviderUpstreamModels(
      createContext(),
      {
        resolveProviderEndpoint: () => endpoint,
        httpClient: stubHttpClient(async () => stubHttpResponse("not-json")).port,
      },
      { workspace, providerId: "p1" },
    );
    expect(malformed).toEqual({ models: [], error: { code: "malformed-response" } });

    const timeout = await fetchProviderUpstreamModels(
      createContext(),
      {
        resolveProviderEndpoint: () => endpoint,
        httpClient: stubHttpClient(async () => {
          throw new HttpClientPortError({ code: "timeout", message: "timed out" });
        }).port,
      },
      { workspace, providerId: "p1" },
    );
    expect(timeout).toEqual({ models: [], error: { code: "timeout" } });
  });

  it("registry resolver 从 Registry Provider 事实提取 endpoint；zhipu-account 返回 undefined", () => {
    const apiKeyProvider = createRegistryProvider();
    expect(resolveProviderUpstreamEndpoint(apiKeyProvider)?.apiKey).toBe("sk-registry");
    const zhipuProvider = createRegistryProvider("zhipu-account");
    expect(resolveProviderUpstreamEndpoint(zhipuProvider)).toBeUndefined();
    const resolver = createRegistryUpstreamEndpointResolver({
      getProvider: (id) => (id === "p1" ? apiKeyProvider : undefined),
    });
    expect(resolver("p1")?.baseUrl).toBe("https://api.example.com/v1");
    expect(resolver("missing")).toBeUndefined();
    expect(createRegistryUpstreamEndpointResolver(undefined)("p1")).toBeUndefined();
  });

  // 回归：Registry 只发布至少有一个可执行模型的 Provider，新渠道在保存第一个模型前查不到；
  // 添加模型弹窗正是要在这个窗口里拉取上游模型，因此 endpoint 必须从生效配置解析。
  it("渠道尚无模型、未发布进 Registry 时，仍从生效配置解析 endpoint", () => {
    const apiKeyProvider = createRegistryProvider();
    const resolver = createRegistryUpstreamEndpointResolver({
      getProvider: () => undefined,
      getSnapshot: () => ({
        resolution: {
          effectiveProviders: {
            get: (id: string) => (id === "p1" ? apiKeyProvider.config : undefined),
          },
        },
      }),
    });
    expect(resolver("p1")).toEqual({
      apiType: "openai-chat-completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-registry",
      extraHeaders: { "x-extra": "v" },
    });
    expect(resolver("missing")).toBeUndefined();
  });

  it("未注入 Registry 快照时回落到 Provider 事实；无 api 的生效配置仍视为不可用", () => {
    const apiKeyProvider = createRegistryProvider();
    const withoutSnapshot = createRegistryUpstreamEndpointResolver({
      getProvider: (id) => (id === "p1" ? apiKeyProvider : undefined),
      getSnapshot: () => null,
    });
    expect(withoutSnapshot("p1")?.baseUrl).toBe("https://api.example.com/v1");

    const draftOnly = createRegistryUpstreamEndpointResolver({
      getProvider: () => undefined,
      getSnapshot: () => ({
        resolution: {
          effectiveProviders: {
            // 刚创建、尚未填写 baseUrl 的渠道：生效配置存在但没有 api。
            get: (id: string) => (id === "p1" ? ({} as unknown as ProviderConfig) : undefined),
          },
        },
      }),
    });
    expect(draftOnly("p1")).toBeUndefined();
  });
});

function createRegistryProvider(accessType: "api-key" | "zhipu-account" = "api-key") {
  const access =
    accessType === "api-key"
      ? { type: "api-key", apiKey: "sk-registry" }
      : { type: "zhipu-account", accountType: "zai", mode: "start-plan", entitled: true };
  return {
    providerId: "p1",
    config: {
      access,
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://api.example.com/v1",
        headers: { "x-extra": "v" },
      },
    },
  } as unknown as Parameters<typeof resolveProviderUpstreamEndpoint>[0];
}
