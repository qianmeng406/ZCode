# Upstream Model Picker

## Behavior

In the add-model dialog, the user may request model IDs from the current provider's configured upstream models endpoint. The request uses the provider's existing credentials and endpoint through the provider settings service; the UI never performs network I/O. Results are normalized to unique, non-empty string IDs and populate a searchable picker. Selecting an item changes only the draft model ID; saving remains an explicit user action. Manual model IDs remain supported when the request fails or a provider does not expose a compatible list endpoint.

## Ownership

The provider protocol/service owns endpoint construction, authentication, timeout, cancellation, response validation, and redacted error classification. The dialog owns only picker state and draft selection. The provider config service remains the sole owner of persisted model configuration.

## Compatibility

The request and result are optional additions to the provider settings protocol. Existing providers, manually entered IDs, edit dialogs, and old clients continue to work.

## Acceptance

- Successful OpenAI-compatible `{ data: [{ id }] }` responses produce a deduplicated picker.
- A provider that has not yet saved its first model still fetches: the endpoint resolves from the effective provider config, not from the published model-bearing registry.
- Empty, malformed, unauthorized, timed-out, and unavailable responses produce a safe user-facing error without exposing credentials.
- Selecting a result fills the ID field and does not save automatically.
- The picker is keyboard accessible and the manual input remains usable.

## Non-goals

This feature does not infer model capabilities, change provider configuration, or query a global model catalog.

## Event Order

```text
UI (add-model dialog)
  └─ ProviderUpstreamModelPicker.onFetch(providerId)         [useUpstreamModelFetch: token+1, fetching=true]
       └─ ProviderSettingsService.fetchUpstreamModels        [packages/services, ensureReady → 委托 Agent]
            └─ zcodeAgentService.fetchUpstreamModels         [protocol request, timeout 30s]
                 └─ CLI handler (provider-upstream-models.ts)
                      ├─ refreshProviderRegistry("provider-fetch-upstream-models")   ← 刷新生效配置（含尚无模型的渠道）
                      ├─ resolveProviderEndpoint(providerId)                          ← 只读生效 Provider 配置事实
                      ├─ GET {baseUrl}/models  (Bearer key + extra headers, 20s, 2MiB cap)
                      └─ normalize: unique non-empty ids → { models } | { models: [], error: { code } }
  ← 响应按发起代次回填：token 不匹配的 stale 结果直接丢弃，不覆盖新状态
  └─ 用户在下拉选择 → 仅写入草稿 idValue（不保存）；保存仍走原有显式 commit
```

- 失败语义：`unsupported` / `provider-unavailable` / `unauthorized` / `timeout` / `network` / `malformed-response` / `not-found` / `unknown` 都是**正常返回**（空列表 + code），UI 保持手输入框与既有草稿不变；协议错误只携带分类码，不含 key、headers、URL 或上游响应体。
- 关闭/取消：弹窗关闭只丢弃 UI 状态；进行中的请求由协议 30s 超时与 AbortSignal 收口，Registry 与配置不受影响。
- 旧 CLI 未实现该方法时 client 侧 method-not-found 由 `.catch` 归入 `unknown`，功能退化为纯手输。
