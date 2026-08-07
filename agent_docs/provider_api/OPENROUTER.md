# OPENROUTER API NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official constraints and verified caveats for OpenRouter models, routing, Responses, Search, and attachments.
Read when: Changing OpenRouter catalogs, downstream routing, reasoning, streaming, Perplexity Search, citations, or PDF mapping.
Code owners: `lib/server/providers/openRouter*.ts` and OpenRouter provider setup.
Not owned here: AIQSA runtime mapping details, normalized Search semantics, or native OpenAI behavior.

## OpenRouter

Last verified: 2026-08-03.

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
- A model result supplies request-facing id, canonical slug, modalities, context/pricing metadata, supported-parameter hints, and optional expiration evidence. Model-specific `GET /api/v1/models/:author/:slug/endpoints` supplies downstream endpoint/provider choices; these remote fields remain mutable and account-dependent.
- Reasoning controls are model/route specific. OpenRouter Claude effort is represented through Claude-compatible effort/verbosity behavior, Gemini thinking uses mapped effort levels, and OpenAI routes use OpenAI-style effort.
- OpenRouter documents Gemini thinking levels through `minimal`, `low`, `medium`, and `high`; documented `xhigh` maps down to `high`, so it is not a distinct Gemini capability.
- Provider routing supports `order`, `only`, `allow_fallbacks`, `require_parameters`, `data_collection`, `sort`, and `zdr`. Sticky `session_id` can improve cache routing; explicit `cache_control` support depends on the downstream provider/model.
- OpenRouter's Responses API is currently labelled beta and stateless: every request supplies its full history and no server-side conversation state is persisted.
- The current catalog uses `google/gemini-3.5-flash` and the live `~google/gemini-pro-latest` alias. `google/gemini-3-pro-preview` can return no endpoints and must not be inferred as available.
- The current `perplexity/sonar-pro-search` route uses denied data collection, Perplexity-only routing, throughput sort, and `require_parameters: false`; do not strengthen that flag without revalidating the selected route.
- OpenRouter exposes web-search server tools, and Perplexity Search is available through selected model routes.
- Chat Completions web-search citations are standardized as `message.annotations[]` records with `type: "url_citation"` and a nested `url_citation` object containing the URL, title, optional content excerpt, and offsets. Older top-level citation arrays and flat citation records still occur on existing routes.
- Native PDF routing is capability-dependent. OpenRouter file content can select its native PDF parser plugin instead of a router-side parser/OCR fallback.
- OpenRouter endpoint tags are canonicalized independently of display casing.

Current answer streaming/non-streaming behavior, routing defaults, query-only Perplexity Search limits, PDF mapping for answer requests, previews, and error normalization live in the [OpenRouter runtime owner](../backend/providers/OPENROUTER.md) and adapter tests.
