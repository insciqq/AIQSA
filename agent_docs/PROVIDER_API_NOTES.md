# PROVIDER_API_NOTES

## Ownership

This conditional document owns official provider references, externally mutable constraints, one last-verified marker per boundary, and provider-specific caveats. `BACKEND.md` owns AIQSA adapter behavior/defaults; `QSA_PIPELINE.md` owns product semantics; `ENV_VARIABLES.md` owns configuration names; executable adapter tests own exact request/response mapping.

Reverify the affected primary sources whenever provider-facing work depends on mutable behavior, then replace the section's single marker. Do not append a verification chronology here; durable rationale belongs in ADRs and significant completion evidence belongs in `done_tasks/`.

Provider smokes require the standing permission and limits in `CRITICAL_INVARIANTS.md`. Default automation uses fake providers; never print, inspect, persist, or commit key values, and do not run large-context/deep-research/large-attachment/long-background calls without fresh approval.

## OpenAI Responses API

Last verified: 2026-07-26.

Primary references:

- `https://platform.openai.com/docs/api-reference/responses`
- `https://platform.openai.com/docs/api-reference/models/list`
- `https://developers.openai.com/api/docs/guides/migrate-to-responses`
- `https://platform.openai.com/docs/guides/background`
- `https://developers.openai.com/api/docs/guides/tools-web-search`
- `https://developers.openai.com/api/docs/guides/prompt-caching`
- `https://platform.openai.com/docs/guides/reasoning`
- `https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters`
- `https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode`
- `https://developers.openai.com/api/docs/models/gpt-5.6-sol`
- `https://developers.openai.com/api/docs/models/gpt-5.6-terra`
- `https://developers.openai.com/api/docs/models/gpt-5.6-luna`
- `https://developers.openai.com/api/docs/guides/file-inputs`

Externally constrained facts:

- OpenAI recommends Responses for new projects while Chat Completions remains supported. They have different input/output, streaming, tool, structured-output, and state contracts; OpenAI compatibility alone does not establish which endpoint a third-party service implements.
- Background Responses use `background: true`, are retrieved/cancelled by response id, and require stored provider state. This stored/background path is not Zero Data Retention compatible. OpenAI documents polling storage on roughly a ten-minute horizon, so late recovery must retain the response id and tolerate transient retrieve failures.
- Background creation may also stream. Responses SSE and terminal payloads can expose output deltas, web-search lifecycle/source data, usage, and the response id.
- Reasoning controls live under `reasoning`; `max_output_tokens` includes visible output and reasoning tokens. Reasoning summaries use `reasoning.summary`; older `generate_summary` is deprecated.
- GPT-5.6 has the concrete `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` model ids. Each documents a 1,050,000-token context window and 128,000 maximum output tokens.
- GPT-5.5 likewise documents a 1,050,000-token context window and 128,000 maximum output tokens; `1m` is only shorthand, while catalog and UI limits retain the exact value.
- GPT-5.6 supports efforts `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Its independent `reasoning.mode` is `standard` by default or `pro`; Pro is not a separate model slug and trades additional latency, tokens, and cost for more work.
- Supported direct-model effort metadata for `gpt-5.5` must not infer `minimal`; the reviewed default is `medium`.
- Explicit effort `none` is materially different from omitting the reasoning object for a reasoning-default model. A terminal `status: incomplete` is not a complete answer.
- Authenticated `GET /v1/models` returns the model identifiers available to the key. AIQSA uses that bounded read-only catalog for credential preflight and activation-time model-presence evidence; it does not treat catalog presence as a guarantee that a later generation will succeed.
- Ultra-small generation diagnostics are not portable across current models and routes. AIQSA allows up to 1,000 output tokens for an explicitly confirmed diagnostic; this is a safety cap rather than a provider-wide minimum claim, and diagnostic output is discarded.
- Native `web_search` uses the Responses tool contract and may return call/action sources and/or message annotations. It does not require a backend regex intent gate.
- Native `web_search` and parallel custom functions can coexist. Merely offering native web search must not make AIQSA serialize independent custom or MCP calls sequentially.
- Prompt caching is automatic where eligible; `prompt_cache_key` and retention hints influence routing/retention and must not expose a raw local chat id. GPT-5.6 replaces the older `prompt_cache_retention` field with `prompt_cache_options`; its currently documented TTL is `30m`.
- Image input may use URLs, data URLs, or provider file ids where the model supports vision. Native PDF file input is model-capability dependent, and direct PDF parsing includes both extracted text and page images in context; provider-hosted File Search/vector stores are a separate provider-specific product from direct file input.

Current AIQSA request construction, polling, tool bridging, attachment mapping, redaction, and normalized event/result behavior live only in `BACKEND.md` and adapter tests.

## Compatible OpenAI Gateways And codex-lb

Last verified: 2026-07-29.

Primary references:

- `https://soju06.github.io/codex-lb/client-setup/`
- `https://github.com/Soju06/codex-lb/blob/main/CHANGELOG.md`

Externally constrained facts:

- codex-lb's OpenAI-compatible client configuration uses the deployment's `/v1` API root. A root that omits `/v1` may resolve to the web application rather than the JSON catalog/API, so AIQSA keeps protocol and canonical API root explicit instead of guessing from a hostname.
- The codex-lb changelog reports an OpenAI-compatible image API backed by its `image_generation` capability from v1.16.0 and forwarding for standalone web search from v1.22.0. Those project capabilities do not prove that a particular deployment, account, or selected model currently enables either tool.
- A successful `/models` catalog request proves only safe catalog reachability for the supplied authentication candidate. OpenAPI path presence, catalog membership, and administrator capability declarations are not substitutes for an authenticated tool-specific smoke.
- The permitted live deployment smoke returned seven model rows and bounded per-model reasoning metadata, but the shapes are gateway-owned and untrusted. AIQSA retains only allowlisted integer/boolean/short-option hints and never returns arbitrary row metadata to the browser.
- The same deployment accepted `reasoning_effort` through both Chat Completions and Responses. A separate Responses request with the hosted `web_search` tool completed with a `web_search_call`; this proves that exact tested deployment/account path, not codex-lb installations generally. Smoke evidence retained only status and output-type facts, never answer text or credentials.

AIQSA represents that verified Search path as an ordinary `provider_model_client` integration using the typed `openai_responses_web_search` protocol and the existing provider-model credential binding. The product contains no codex-lb hostname, deployment, or upstream model-id branch; another compatible Responses deployment can use the same lifecycle and adapter after its own exact draft test. Search execution/privacy and the future-only image-generation declaration live in `BACKEND.md`; this note does not promote image generation into a runnable chat capability.

## Anthropic Messages API

Last verified: 2026-07-26.

Primary references:

- `https://platform.claude.com/docs/en/about-claude/models/overview`
- `https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5`
- `https://platform.claude.com/docs/en/about-claude/models/migration-guide`
- `https://platform.claude.com/docs/en/build-with-claude/streaming`
- `https://docs.anthropic.com/en/api/messages`
- `https://docs.anthropic.com/en/api/messages-examples`
- `https://docs.anthropic.com/en/api/models-list`
- `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`
- `https://platform.claude.com/docs/en/build-with-claude/pdf-support`

Externally constrained facts:

- Streaming uses events such as `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, and `message_stop`; clients must tolerate ping/error/unknown event types.
- Content deltas may contain text, tool input JSON, or thinking; usage can appear in events and final message data.
- Total Anthropic input usage is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; current thinking usage is reported as `output_tokens_details.thinking_tokens` when available.
- Older manual thinking uses a token budget below `max_tokens`. Claude Opus 4.8+ uses adaptive thinking plus `output_config.effort`; its documented scale includes `low`, `medium`, `high`, `xhigh`, and `max`, with `high` as API default.
- The current explicit Claude 5 API ids are `claude-opus-5` and `claude-sonnet-5`. Both document a 1,000,000-token context window and 128,000 maximum output tokens. AIQSA uses those stable ids rather than a mutable alias.
- Claude 5 uses adaptive thinking with effort. Its migration guidance removes manual extended-thinking budgets and non-default sampling combinations for this path, so AIQSA's Claude 5 templates do not expose temperature and default to adaptive thinking with high effort.
- PDF/document and image support are model capabilities, not provider-wide assumptions. Direct native PDF input uses Messages document content; unsupported routes require the local extracted-text fallback.
- Authenticated `GET /v1/models` uses `x-api-key` plus the Anthropic version header and returns model identifiers suitable for bounded credential validation and catalog-presence evidence.

Current AIQSA defaults and request/event normalization live in `BACKEND.md` and adapter tests.

## Gemini Native Interactions API

Last verified: 2026-07-26.

Primary references:

- `https://ai.google.dev/gemini-api/docs/models`
- `https://ai.google.dev/gemini-api/docs/latest-model`
- `https://ai.google.dev/gemini-api/docs/interactions-overview`
- `https://ai.google.dev/api/interactions-api-v1`
- `https://ai.google.dev/gemini-api/docs/api-versions`
- `https://ai.google.dev/gemini-api/docs/streaming`
- `https://ai.google.dev/gemini-api/docs/function-calling`
- `https://ai.google.dev/gemini-api/docs/google-search`
- `https://ai.google.dev/gemini-api/docs/tool-combination`
- `https://ai.google.dev/gemini-api/terms`

Externally constrained facts:

- Stable native v1 Interactions uses `POST https://generativelanguage.googleapis.com/v1/interactions`; the Gemini API key is sent through `x-goog-api-key`. AIQSA uses `store: false`, supplies complete local context, and does not depend on provider-side interaction history.
- Models catalog entries use identifiers such as `models/gemini-...`. AIQSA strips only that leading wrapper before exact reviewed-policy comparison; it does not normalize arbitrary names or import every result.
- The reviewed explicit model ids are `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-pro-preview`. Their reviewed catalog controls use a 1,000,000-token context window and at most 65,536 output tokens, with model-specific `minimal`/`low`/`medium`/`high` reasoning-effort choices. Explicit ids are preferred to hot-swapping latest aliases.
- Interactions expresses generation controls under `generation_config`, accepts native typed input/step arrays, returns step types such as model output, thought and function calls/results, and exposes cumulative token fields including cached and thought totals. Streaming uses named SSE events and a final done proof; stream EOF alone is not successful completion.
- Native function continuations require the provider-returned thought/signature steps. Dropping, merging, or fabricating them can invalidate the next request. They are request-critical private state, not display or logging metadata.
- Native Google Search is a hosted `{ "type": "google_search" }` tool. It can produce search call/result steps, URL citation annotations, and exact `search_suggestions` markup. The documentation requires Suggestions to accompany the grounded content; current terms constrain storage/use of Search Suggestions and citation Links. AIQSA chooses the stricter permitted product boundary: the complete grounded answer, Suggestions, Links, and search result/signature data are live-only and are never durable chat context.
- The Search-plus-function/MCP combination is deliberately rejected even where some native tool combinations may be documented. This keeps exact provider search results/Suggestions out of the recoverable client-tool checkpoint; broadening it requires a new persistence/privacy proof.
- Authenticated catalogs contain non-chat image, audio, embedding, and media identifiers. Blind import is unsafe; Quick setup intersects only the reviewed chat candidates above.
- Search Suggestions are untrusted provider markup and pass a closed allowlist. Newly observed tags or attributes require explicit review rather than automatic acceptance.

Current catalog intersection, native request mapping, stream parser, tool bridge, signature replay, live-only grounding fence, and safe smoke behavior live in `BACKEND.md`, `SECURITY.md`, and focused tests.

## OpenRouter

Last verified: 2026-07-24.

Primary references:

- `https://openrouter.ai/docs/api/reference/overview`
- `https://openrouter.ai/openapi.json`
- `https://openrouter.ai/docs/api/reference/streaming`
- `https://openrouter.ai/docs/cookbook/administration/usage-accounting`
- `https://openrouter.ai/docs/provider-routing`
- `https://openrouter.ai/docs/api/api-reference/models/list-models-user`
- `https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints`
- `https://openrouter.ai/docs/api/reference/responses/overview`
- `https://openrouter.ai/docs/use-cases/reasoning-tokens`
- `https://openrouter.ai/docs/guides/features/server-tools/web-search`
- `https://openrouter.ai/docs/guides/overview/multimodal/pdfs`
- `https://openrouter.ai/perplexity`

Externally constrained facts:

- Chat Completions is OpenAI-compatible but accepts additional provider-routing and model-specific fields. Streaming uses SSE data chunks plus possible comment keepalives; current usage accounting places usage in the final streaming chunk without the deprecated include-usage knobs.
- Authenticated `GET /api/v1/models/user` filters model results through that OpenRouter account's provider preferences, privacy settings, and guardrails. A catalog observed with one API key is therefore not availability proof for another key.
- A model result supplies request-facing id, canonical slug, modalities, context/pricing metadata, supported-parameter hints, and optional expiration evidence. Model-specific `GET /api/v1/models/:author/:slug/endpoints` supplies the downstream endpoint/provider choices used for explicit routing. These remote fields remain mutable operational metadata rather than AIQSA entitlement or billing authority.
- Reasoning controls are model/route specific. OpenRouter Claude effort is represented through Claude-compatible effort/verbosity behavior, Gemini thinking uses mapped effort levels, and OpenAI routes use OpenAI-style effort. Do not expose one global effort list.
- OpenRouter documents Gemini thinking levels through `minimal`, `low`, `medium`, and `high`; documented `xhigh` maps down to `high`, so it is not a distinct Gemini capability.
- Provider routing supports `order`, `only`, `allow_fallbacks`, `require_parameters`, `data_collection`, `sort`, and `zdr`. Sticky `session_id` can improve cache routing; explicit `cache_control` support depends on the downstream provider/model.
- OpenRouter's Responses API is currently labelled beta and stateless: every request supplies its full history and no server-side conversation state is persisted. AIQSA must not reuse native OpenAI stored-background/retrieve/cancel assumptions for that endpoint merely because its request surface is Responses-compatible.
- The current catalog uses `google/gemini-3.5-flash` and the live `~google/gemini-pro-latest` alias. `google/gemini-3-pro-preview` can return no endpoints and must not be inferred as available.
- The current `perplexity/sonar-pro-search` route uses denied data collection, Perplexity-only routing, throughput sort, and `require_parameters: false`; do not strengthen that flag without revalidating the selected route.
- OpenRouter web-search server tools exist, but AIQSA integrates Perplexity only through an explicit selected typed client Search integration. The answer model receives the provider-neutral Search-plan tool; the technical OpenRouter request receives only its generated bounded query.
- Native PDF routing is capability-dependent. OpenRouter file content plus its native PDF parser plugin avoids silently selecting a router-side parser/OCR fallback; unknown custom models must not be assumed native-capable.
- OpenRouter endpoint tags are canonicalized independently of display casing, so AIQSA compares route tags case-insensitively while preserving the configured value in safe evidence.

Current answer streaming/non-streaming behavior, routing defaults, query-only Perplexity Search limits, PDF mapping for answer requests, previews, and error normalization live in `BACKEND.md` and adapter tests.

## MCP OAuth, Hosted Notion, And Brokered SaaS

Last verified: 2026-07-29.

Primary references:

- `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- `https://developers.notion.com/docs/mcp`
- `https://mcp.notion.com/mcp`
- `https://yandex.ru/dev/id/doc/en/codes/code-url`
- `https://yandex.ru/dev/id/doc/en/tokens/refresh-client`
- `https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate`
- `https://yandex.ru/support/tracker/ru/api-ref/users/get-user-info`
- `https://yandex.ru/support/tracker/en/user/query-filter`

Externally constrained facts:

- Remote MCP authorization is a protected-resource OAuth flow, not AI-provider sign-in. AIQSA uses Authorization Code with S256 PKCE plus protected-resource/authorization-server discovery, dynamic client registration or Client ID Metadata Documents, refresh, and revocation when advertised; the administrator owns the allowed resource, authorization-server origins, scopes, and callback policy.
- The hosted Notion endpoint returned the expected protected-resource challenge. Its public metadata advertised the canonical MCP resource, authorization code and refresh grants, S256 PKCE, dynamic registration, Client ID Metadata Documents, introspection, and revocation.
- Same-origin MCP endpoints may publish a canonical resource with a different path from the Streamable HTTP URL: verified services included both an endpoint-path resource and an origin-root resource. Path equality is therefore not portable, while accepting a discovered resource outside the configured endpoint origin would broaden trust.
- Hosted Notion consent or public metadata does not prove post-consent tool discovery and execution. Automation and operator reports must distinguish those boundaries from a successful end-to-end tool call.
- ToolHive v0.40.1's interactive remote OAuth flow is not used for this path because it owns a local loopback/browser lifecycle rather than AIQSA's user-bound web callback. AIQSA's official MCP SDK wrapper owns remote sessions and OAuth; ToolHive owns only local stdio workload lifecycle.
- A standards-conforming remote MCP may redirect its own authorization endpoint
  through a second upstream OAuth code flow. The MCP resource must issue and
  validate its own tokens; upstream token passthrough remains forbidden. AIQSA
  never adds the upstream identity-provider origin merely because the MCP later
  redirects a browser there.
- Yandex supports authorization-code PKCE, refresh, and device-bound token
  invalidation. Tracker's current-user endpoint is suitable for binding a
  server-side grant to the authorized subject, and Tracker query syntax supports
  an unresolved current-assignee filter. These are properties of the external
  MCP conformance target, not AIQSA provider branches or configuration.

Current MCP policy, persistence, source matrix, readiness, and tool-loop behavior live in `BACKEND.md`, `SECURITY.md`, and ADR 0021 rather than this mutable external-facts note.

## Cross-Provider Boundaries

AIQSA owns conversation memory server-side and translates one normalized provider-neutral run request into provider-specific input. Provider continuation ids support refresh/cancel, not primary chat memory. Text documents use bounded extracted text; original PDF/image bytes are resolved privately only for an explicitly capable selected model and are redacted from inspectable payloads.

Those are implementation/security boundaries owned by `BACKEND.md` and `SECURITY.md`; this file changes only when an external provider constraint changes or its last-verified marker is refreshed.
