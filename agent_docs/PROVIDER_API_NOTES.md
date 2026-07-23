# PROVIDER_API_NOTES

## Ownership

This conditional document owns externally verified provider constraints, documentation links, dated smoke observations, and provider-specific caveats. `BACKEND.md` owns AIQSA adapter behavior/defaults; `QSA_PIPELINE.md` owns product semantics; `ENV_VARIABLES.md` owns configuration names; executable adapter tests own exact request/response mapping.

Provider documentation was checked on 2026-04-26 and the current search/upload/routing constraints were rechecked on 2026-06-14. GPT-5.5/GPT-5.6 context, OpenAI PDF token, and Anthropic usage contracts were rechecked on 2026-07-18. Reverify the affected source and update that date when a provider-facing change depends on mutable external behavior.

Provider smokes require the standing permission and limits in `CRITICAL_INVARIANTS.md`. Default automation uses fake providers; never print, inspect, persist, or commit key values, and do not run large-context/deep-research/large-attachment/long-background calls without fresh approval.

## OpenAI Responses API

Primary references:

- `https://platform.openai.com/docs/api-reference/responses`
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

- Background Responses use `background: true`, are retrieved/cancelled by response id, and require stored provider state. This stored/background path is not Zero Data Retention compatible. OpenAI documents polling storage on roughly a ten-minute horizon, so late recovery must retain the response id and tolerate transient retrieve failures.
- Background creation may also stream. Responses SSE and terminal payloads can expose output deltas, web-search lifecycle/source data, usage, and the response id.
- Reasoning controls live under `reasoning`; `max_output_tokens` includes visible output and reasoning tokens. Reasoning summaries use `reasoning.summary`; older `generate_summary` is deprecated.
- GPT-5.6 has the concrete `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` model ids. Each documents a 1,050,000-token context window and 128,000 maximum output tokens.
- GPT-5.5 likewise documents a 1,050,000-token context window and 128,000 maximum output tokens; `1m` is only shorthand, while catalog and UI limits retain the exact value.
- GPT-5.6 supports efforts `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Its independent `reasoning.mode` is `standard` by default or `pro`; Pro is not a separate model slug and trades additional latency, tokens, and cost for more work.
- The 2026-06-06 low-token `gpt-5.5` smoke rejected effort `minimal`. Current supported direct-model effort metadata must therefore not infer that value; the guide's default is `medium`.
- Explicit effort `none` is materially different from omitting the reasoning object for a reasoning-default model. A terminal `status: incomplete` is not a complete answer.
- Native `web_search` uses the Responses tool contract and may return call/action sources and/or message annotations. It does not require a backend regex intent gate.
- A 2026-07-23 low-token Responses smoke combined native `web_search` with two custom functions and `parallel_tool_calls: true`; the API returned HTTP 200 and both function calls in one response. Merely offering native web search therefore must not make AIQSA serialize independent custom or MCP calls sequentially.
- Prompt caching is automatic where eligible; `prompt_cache_key` and retention hints influence routing/retention and must not expose a raw local chat id. GPT-5.6 replaces the older `prompt_cache_retention` field with `prompt_cache_options`; its currently documented TTL is `30m`.
- Image input may use URLs, data URLs, or provider file ids where the model supports vision. Native PDF file input is model-capability dependent, and direct PDF parsing includes both extracted text and page images in context; provider-hosted File Search/vector stores are a separate provider-specific product from direct file input.

Current AIQSA request construction, polling, tool bridging, attachment mapping, redaction, and normalized event/result behavior live only in `BACKEND.md` and adapter tests.

## Anthropic Messages API

Primary references:

- `https://platform.claude.com/docs/en/build-with-claude/streaming`
- `https://docs.anthropic.com/en/api/messages`
- `https://docs.anthropic.com/en/api/messages-examples`
- `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`
- `https://platform.claude.com/docs/en/build-with-claude/pdf-support`

Externally constrained facts:

- Streaming uses events such as `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, and `message_stop`; clients must tolerate ping/error/unknown event types.
- Content deltas may contain text, tool input JSON, or thinking; usage can appear in events and final message data.
- Total Anthropic input usage is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; current thinking usage is reported as `output_tokens_details.thinking_tokens` when available.
- Older manual thinking uses a token budget below `max_tokens`. Claude Opus 4.8+ uses adaptive thinking plus `output_config.effort`; its documented scale includes `low`, `medium`, `high`, `xhigh`, and `max`, with `high` as API default.
- PDF/document and image support are model capabilities, not provider-wide assumptions. Direct native PDF input uses Messages document content; unsupported routes require the local extracted-text fallback.

Current AIQSA defaults and request/event normalization live in `BACKEND.md` and adapter tests.

## OpenRouter

Primary references:

- `https://openrouter.ai/docs/api/reference/overview`
- `https://openrouter.ai/openapi.json`
- `https://openrouter.ai/docs/api/reference/streaming`
- `https://openrouter.ai/docs/cookbook/administration/usage-accounting`
- `https://openrouter.ai/docs/provider-routing`
- `https://openrouter.ai/docs/use-cases/reasoning-tokens`
- `https://openrouter.ai/docs/guides/features/server-tools/web-search`
- `https://openrouter.ai/docs/guides/overview/multimodal/pdfs`
- `https://openrouter.ai/perplexity`

Externally constrained facts:

- Chat Completions is OpenAI-compatible but accepts additional provider-routing and model-specific fields. Streaming uses SSE data chunks plus possible comment keepalives; current usage accounting places usage in the final streaming chunk without the deprecated include-usage knobs.
- Reasoning controls are model/route specific. OpenRouter Claude effort is represented through Claude-compatible effort/verbosity behavior, Gemini thinking uses mapped effort levels, and OpenAI routes use OpenAI-style effort. Do not expose one global effort list.
- OpenRouter documents Gemini thinking levels through `minimal`, `low`, `medium`, and `high`; documented `xhigh` maps down to `high`, so it is not a distinct Gemini capability.
- Provider routing supports `order`, `only`, `allow_fallbacks`, `require_parameters`, `data_collection`, `sort`, and `zdr`. Sticky `session_id` can improve cache routing; explicit `cache_control` support depends on the downstream provider/model.
- The current catalog uses `google/gemini-3.5-flash` and the live `~google/gemini-pro-latest` alias. The removed `google/gemini-3-pro-preview` can return no endpoints and must not be inferred as available.
- The 2026-06-06 tiny `perplexity/sonar-pro-search` smoke succeeded with denied data collection, Perplexity-only routing, throughput sort, and `require_parameters: false`; forcing `require_parameters: true` failed. This is a dated observation, not a provider-wide guarantee.
- OpenRouter web-search server tools exist, but AIQSA's current Perplexity integration is an explicit provider-neutral tool executor rather than the removed regex pre-search path.
- Native PDF routing is capability-dependent. OpenRouter file content plus its native PDF parser plugin avoids silently selecting a router-side parser/OCR fallback; unknown custom models must not be assumed native-capable.

Current answer streaming/non-streaming behavior, routing defaults, Perplexity tool transcript/limits, PDF mapping, previews, and error normalization live in `BACKEND.md` and adapter tests.

## MCP And Hosted Notion

Primary references checked on 2026-07-22:

- `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- `https://developers.notion.com/docs/mcp`
- `https://mcp.notion.com/mcp`

Externally constrained facts and verification:

- Remote MCP authorization is a protected-resource OAuth flow, not AI-provider sign-in. AIQSA uses Authorization Code with S256 PKCE plus protected-resource/authorization-server discovery, dynamic client registration or Client ID Metadata Documents, refresh, and revocation when advertised; the administrator owns the allowed resource, authorization-server origins, scopes, and callback policy.
- The hosted Notion endpoint returned the expected protected-resource challenge. Its public metadata advertised the canonical MCP resource, authorization code and refresh grants, S256 PKCE, dynamic registration, Client ID Metadata Documents, introspection, and revocation.
- A deterministic in-process official-SDK Streamable HTTP/OAuth fixture verifies AIQSA discovery, callback, encrypted token settlement, refresh/retry, inventory, and tool-call behavior without external credentials.
- On 2026-07-23 an operator completed real hosted-Notion validation consent and AIQSA accepted the callback/token settlement. That run did not complete post-consent tool discovery/call before its disposable development state was reset, so full hosted-Notion end-to-end interoperability remains unverified. Automation must distinguish the observed consent callback from a successful tool call and must not treat metadata-only checks as either one.
- ToolHive v0.40.1's interactive remote OAuth flow is not used for this path because it owns a local loopback/browser lifecycle rather than AIQSA's user-bound web callback. AIQSA's official MCP SDK wrapper owns remote sessions and OAuth; ToolHive owns only local stdio workload lifecycle.

Current MCP policy, persistence, source matrix, readiness, and tool-loop behavior live in `BACKEND.md`, `SECURITY.md`, and ADR 0021 rather than this mutable external-facts note.

## Cross-Provider Boundaries

AIQSA owns conversation memory server-side and translates one normalized provider-neutral run request into provider-specific input. Provider continuation ids support refresh/cancel, not primary chat memory. Text documents use bounded extracted text; original PDF/image bytes are resolved privately only for an explicitly capable selected model and are redacted from inspectable payloads.

Those are implementation/security boundaries owned by `BACKEND.md` and `SECURITY.md`; this file should change only when external provider constraints or dated observations change.
