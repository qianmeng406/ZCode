/* eslint-disable max-lines -- 上游模型拉取的 endpoint 构造、请求与脱敏分类集中在本文件。 */
import {
  isHttpClientPortError,
  type HttpClientPort,
  type HttpClientRequest,
  type HttpClientResponse,
} from "@zcode/contracts";
import {
  zcodeProviderFetchUpstreamModelsParamsSchema,
  type ZCodeProviderFetchUpstreamModelsResult,
} from "@zcode/shared";
import type { Provider, ProviderConfig } from "@zcode/provider";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 拉取上游模型列表是一次设置页辅助请求，预算与连通性测试同级。 */
const UPSTREAM_MODELS_TIMEOUT_MS = 20_000;
const UPSTREAM_MODELS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ProviderUpstreamModelsErrorCode =
  | "unsupported"
  | "provider-unavailable"
  | "unauthorized"
  | "timeout"
  | "network"
  | "malformed-response"
  | "not-found"
  | "unknown";

/**
 * 进程 Provider Registry 的只读访问。由 zcode-protocol-entrypoint 注入，
 * handler 只消费 Registry 发布的事实，不另建第二份配置读取路径。
 */
export type ProviderUpstreamEndpointResolver = (
  providerId: string,
) => ProviderUpstreamEndpoint | undefined;

export interface ProviderUpstreamEndpoint {
  readonly apiType: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderUpstreamModelsDependencies {
  readonly resolveProviderEndpoint: ProviderUpstreamEndpointResolver;
  readonly httpClient: HttpClientPort;
}

/**
 * 用已保存 Provider 的 endpoint/key/headers 拉取上游模型 ID。
 * 仅支持 OpenAI-compatible GET {baseUrl}/models；其余 api type 显式返回 unsupported，
 * 不猜测 Anthropic 等协议的列表端点。
 */
export async function fetchProviderUpstreamModels(
  context: ZCodeProtocolAgentServerContext,
  dependencies: ProviderUpstreamModelsDependencies,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodeProviderFetchUpstreamModelsResult> {
  void context;
  const params = parseParams(zcodeProviderFetchUpstreamModelsParamsSchema, rawParams);
  // 与连接测试一致：旧 Personal Config 的跨进程 watcher 可能漏掉原子写事件，
  // 拉取前先主动刷新进程 Registry，避免用户刚保存的 endpoint/key 未发布就被使用。
  await context.deps.refreshProviderRegistry?.("provider-fetch-upstream-models");
  const endpoint = dependencies.resolveProviderEndpoint(params.providerId);
  if (!endpoint) {
    return { models: [], error: { code: "provider-unavailable" } };
  }
  if (endpoint.apiType !== "openai-chat-completions" && endpoint.apiType !== "openai-responses") {
    return { models: [], error: { code: "unsupported" } };
  }
  const url = joinModelsUrl(endpoint.baseUrl);
  if (!url) {
    return { models: [], error: { code: "unsupported" } };
  }
  const request: HttpClientRequest = {
    url,
    method: "GET",
    headers: buildUpstreamModelsHeaders(endpoint),
    timeoutMs: UPSTREAM_MODELS_TIMEOUT_MS,
    maxResponseBytes: UPSTREAM_MODELS_MAX_RESPONSE_BYTES,
    redirect: "follow",
  };
  let response: HttpClientResponse;
  try {
    response = await dependencies.httpClient.request(request, { signal: abortSignal });
  } catch (error) {
    return { models: [], error: { code: classifyUpstreamRequestError(error) } };
  }
  return parseUpstreamModelsResponse(response);
}

function joinModelsUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    // baseUrl 通常带 /v1；models 端点直接挂在其后，不重复拼接版本段。
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function buildUpstreamModelsHeaders(endpoint: ProviderUpstreamEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(endpoint.extraHeaders ? { ...endpoint.extraHeaders } : {}),
  };
  if (endpoint.apiKey) {
    // OpenAI-compatible 的标准鉴权头；Anthropic 类型已在调用前显式拒绝。
    headers.authorization = `Bearer ${endpoint.apiKey}`;
  }
  return headers;
}

function parseUpstreamModelsResponse(
  response: HttpClientResponse,
): ZCodeProviderFetchUpstreamModelsResult {
  if (response.status === 401 || response.status === 403) {
    return { models: [], error: { code: "unauthorized" } };
  }
  if (response.status === 404) {
    return { models: [], error: { code: "not-found" } };
  }
  if (response.status < 200 || response.status >= 300) {
    return { models: [], error: { code: "unknown" } };
  }
  const parsed = parseModelsPayload(response.body);
  if (!parsed.ok) {
    return { models: [], error: { code: "malformed-response" } };
  }
  return { models: parsed.models };
}

function parseModelsPayload(
  body: Uint8Array,
): { ok: true; models: readonly string[] } | { ok: false } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return { ok: false };
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of data) {
    const id = extractModelId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  return { ok: true, models };
}

function extractModelId(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed || undefined;
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed || undefined;
}

/** 错误只回传分类码；HTTP 状态、URL、headers 与响应体一律不进协议错误消息。 */
function classifyUpstreamRequestError(error: unknown): ProviderUpstreamModelsErrorCode {
  if (isHttpClientPortError(error)) {
    switch (error.code) {
      case "timeout":
        return "timeout";
      default:
        return "network";
    }
  }
  return "unknown";
}

/** 从 Registry Provider 事实提取上游 endpoint；zhipu-account 不持有静态 key，返回 undefined。 */
export function resolveProviderUpstreamEndpoint(
  provider: Provider | undefined,
): ProviderUpstreamEndpoint | undefined {
  return resolveProviderUpstreamEndpointFromConfig(provider?.config);
}

/**
 * 从生效 Provider 配置提取上游 endpoint。
 * 与 Registry Provider 的区别：生效配置包含尚未保存第一个模型、因而还没发布进 Registry
 * 的渠道；添加模型弹窗正是在这一步需要拉取上游模型，不能要求模型先存在。
 */
export function resolveProviderUpstreamEndpointFromConfig(
  config: ProviderConfig | undefined,
): ProviderUpstreamEndpoint | undefined {
  const api = config?.api;
  if (!config || !api?.baseUrl || !api.type) return undefined;
  if (config.access?.type === "zhipu-account") return undefined;
  return {
    apiType: api.type,
    baseUrl: api.baseUrl,
    ...(config.access?.type === "api-key" && config.access.apiKey
      ? { apiKey: config.access.apiKey }
      : {}),
    ...(api.headers ? { extraHeaders: api.headers } : {}),
  };
}

/**
 * endpoint 解析所需的 Registry 只读面。getSnapshot 提供生效配置（含未发布渠道），
 * getProvider 提供已发布 Provider；两者都缺席时 handler 按 provider-unavailable 降级。
 */
export interface ProviderUpstreamRegistryAccess {
  getProvider(providerId: string): Provider | undefined;
  getSnapshot?(): {
    readonly resolution: {
      readonly effectiveProviders: { get(providerId: string): ProviderConfig | undefined };
    };
  } | null;
}

/**
 * 以进程 Registry Service 为唯一 endpoint 事实源构造只读 resolver。
 * registryService 缺席（未注入）时整体返回 undefined，handler 按 provider-unavailable 降级。
 */
export function createRegistryUpstreamEndpointResolver(
  registryService: ProviderUpstreamRegistryAccess | undefined,
): ProviderUpstreamEndpointResolver {
  return (providerId) => {
    if (!registryService) return undefined;
    // Registry 只发布至少有一个可执行模型的 Provider（resolver 的 validModels 过滤），
    // 新渠道在保存第一个模型前查不到 endpoint。这里优先读生效配置，覆盖该窗口；
    // 生效配置仍是 baseUrl/key/headers 的唯一事实源，不另建配置读取路径。
    const config = registryService.getSnapshot?.()?.resolution.effectiveProviders.get(providerId);
    if (config) return resolveProviderUpstreamEndpointFromConfig(config);
    // 未注入快照（旧调用点/测试替身）时保持原有 Provider 事实路径。
    return resolveProviderUpstreamEndpoint(registryService.getProvider(providerId));
  };
}
