# QSA_PIPELINE

## Product Thesis

The core product is a transparent QSA workflow:

```text
Question -> Search -> Answer
```

The common conversation path stays calm while giving the operator precise control over API request shape, model parameters, search strategy, streamed events, response artifacts, branch state, and provider-reported usage.

Streaming is a provider-neutral run capability. Catalog `capabilities.streaming` says a model/adapter can stream normalized run events; catalog `parameterControls.stream.supported` says the composer exposes a per-run Stream toggle for that model. OpenAI, Gemini, and OpenRouter currently expose the toggle, while other streaming providers can keep adapter-owned defaults until their user-facing control is deliberately enabled.

## Pipeline Stages

1. Question
   - user message;
   - a first-message chat title is derived locally and transactionally from bounded normalized text; it is not another provider request and creates no provider usage;
   - active branch conversation context from a recursive same-chat ancestor query that materializes only the selected root-to-leaf path;
   - editable system/developer prompt;
   - selected provider and model;
   - explicit request parameters;
   - optional PDF/image attachments where selected model and user entitlements allow them, plus text-like document attachments that are included as extracted provider text. PDFs route as provider-native files for `nativePdfInput` models and as extracted text for fallback PDF-capable models.
   - context budgeting uses the conservative Unicode estimate from ADR 0017 and counts provider-bound attachment payload estimates. Native PDFs include both extracted-text and page-image proxies, so oversized extracted text, native PDFs, or images can reject before provider dispatch instead of leaking past the budget as small references.

2. Search
   - optional but first-class;
   - one explicit strategy is selected from the backend-filtered current-user/model catalog, prepared with server-owned strategy/model/routing policy, and revalidated with fresh entitlements immediately before provider execution;
   - unsupported or removed ids are rejected; the product behavior of each current strategy is owned by `Search Strategy` below;
   - live activity never guesses a provider's internal stage: the active tail and application rail say `Working…` while the exact stage is unknown, `Searching…` only after an already-consumed search/citation event proves it, and `Answering…` only after answer tokens arrive. Completed search activity becomes a count-first collapsed thread disclosure, with detailed event/artifact records available on demand.

3. Answer
   - streamed visible answer through the normalized SSE contract;
   - provider EOF is not success: OpenAI Responses requires a completed `response.completed`; native Gemini Interactions requires its valid terminal interaction followed by the native `done` proof; generic compatible Chat and OpenRouter streaming require `[DONE]`; compatible/OpenRouter non-streaming requires a usable first choice/message; and Anthropic requires `message_stop`. Accepted ordinary partial text remains inspectable with error status when terminal proof never arrives, while grounded Gemini text is live-only and cannot become partial durable history;
   - final foreground stream update carries the canonical changed chat/message snapshot needed by the UI, without reloading chat detail;
   - reasoning/thinking summaries or blocks when available, hidden in the thread by default and shown through a user toggle;
   - citations/search artifacts when available, with citations optionally visible in the thread;
   - provider response preview available for inspection under the storage/logging limits in `agent_docs/CRITICAL_INVARIANTS.md`.

MCP extends the middle of this pipeline with model-requested tools rather than adding a separate run mode. Every accepted run receives the complete immutable namespaced inventory from all of that user's enabled, entitled, ready MCP servers; granting a server grants all of its valid tools, and no enabled-but-unready server is silently omitted. The model may request zero, one, or several calls over multiple rounds, including calls whose arguments use conversation data or a prior enabled server's result. Requested batches are persisted before bounded parallel execution, results return in provider order, and provisional streamed text is reset before the tool round. Foreground, Stream, and provider-native Background remain available whenever the selected adapter/model capabilities advertise the combination. Durable recovery reuses settled calls and native provider handles, reloads provider attachment payloads, and replays the same persisted provider transcript and accepted chat context under the same budget; it never retries a crash-ambiguous external side effect.

Model selection carries opaque database deployment IDs, not trusted provider/upstream strings. The run-creation transaction resolves current grants plus one effective administrator-owned default/group credential, rechecks exact deployment compatibility, and persists immutable answer/search provider bindings before any network call. Later ordinary provider/RBAC changes affect future runs only; continuation, cancellation, and recovery retain the accepted endpoint, protocol, routing, model, and credential version.

## Transparency Contract

For every model run, the app can show:

- provider;
- model;
- exact normalized request;
- branch-context replay summary;
- context-window truncation summary when oldest prior turns were omitted;
- provider-specific request preview;
- selected API parameters;
- selected concrete search strategy;
- attachment references and preprocessing summaries;
- streamed event log;
- final response preview;
- normalized token usage metadata, including cached/total token fields when providers report them; tool-search `ModelRun` and chat counters keep end-to-end aggregate usage while `UsageEvent` attribution separates answer-model usage from OpenRouter/Perplexity usage; provider-reported usage already observed before a later failure remains operationally attributable; estimated-cost compatibility data stays out of the user-facing shell and is not billing truth;
- tool-call and tool-result artifacts when an answer model actually invokes a backend tool;
- accepted MCP server/revision/tool snapshots, runtime-generation fingerprints, safe credential-source tags, and optional external account/workspace labels without endpoints or credential values;
- errors and retry/cancel state.

The UI can keep the common path clean, but the API surface must remain inspectable.

Details Events reduces the already-consumed normalized event stream into a chronological digest without changing the event schema or persistence contract. Repeated provider/search/tool/artifact/token/usage categories update the row created at their first occurrence; raw token deltas and internal message ids stay hidden, while counts, latest meaningful status, long failures, cancellation, and successful completion remain inspectable. Historical request/response payloads continue to live in the model-run APIs.

## Provider Strategy

Current providers:

- fake provider for deterministic tests;
- native OpenAI Responses as the first-class OpenAI path;
- custom OpenAI-compatible Responses and Chat Completions as separate explicit Advanced protocols, with a direct simple Chat endpoint/model/key setup;
- Anthropic Messages API;
- Gemini through Google's native stateless Interactions v1 API, including native SSE, custom-function continuation, and optional hosted Google Search, with no compatibility fallback;
- OpenRouter Chat Completions-compatible API;
- administrator-selected OpenRouter search deployments for provider-neutral search tools;
- Provider-neutral run-tool contracts for web search, with OpenAI Responses and OpenRouter Chat Completions bridge boundaries.

Adapter defaults and cache/wire details live in `BACKEND.md`; externally verified constraints live in `PROVIDER_API_NOTES.md`.

## Search Strategy

- Treat Search as an explicit strategy selected per run.
- Send/regenerate requests carry the selected strategy in the run body and a `controlDefaults` snapshot. After validation, the backend commits that snapshot to current-user defaults inside the same transaction as the guarded run graph; provider execution starts only after this complete commit. The visible composer state therefore survives immediate reloads even if a separate settings autosave was still in flight, while pre-create rejection, insert-time active-run conflict, or defaults failure leaves both the graph and defaults unchanged.
- Explicit `search-disabled` is preserved as No Search and survives model/chat switching.
- Selected `openai-native-web-search` sends OpenAI Responses the hosted `web_search` tool with `tool_choice: "auto"`; the model decides whether to search.
- Selected `gemini-google-search` offers the native Gemini hosted Search tool only to an eligible native deployment. If the model does not call it, the answer remains an ordinary durable run. Once an actual native search call begins, the adapter emits a persistence fence and withholds all answer text until non-empty Search Suggestions pass the strict parser; the live result then shows the exact isolated Suggestions plus transient sanitized citation Links. The grounded answer, Suggestions, Links, search result/signature data, and provider markup are never persisted, logged, replayed as context, or publicly shared. Reload shows explicit provenance and a neutral placeholder. Gemini Search cannot be combined with MCP/client functions in the same run.
- Selected `perplexity-tool-search` lets an entitled OpenAI, Gemini, or OpenRouter answer model decide whether to call the provider-neutral `search_via_perplexity` tool against full branch context. The enabled strategy and search-model policy are server-authoritative; posted search params may change only bounded canonical output-token and temperature controls, never provider routing/privacy. No call creates no `SearchRun`; each actual call records search/citation/usage/error artifacts, and failures are returned to the answer model so it can still synthesize a useful answer. Execution is bounded and ends with a no-tool synthesis round. Current implementation also forwards bounded extracted PDF/document text to OpenRouter/Perplexity without a separate attachment confirmation; this is a known privacy limitation awaiting query-only, fail-closed remediation, so do not describe the current path as sending only the generated query. Exact bridge/transcript/streaming mechanics live in `BACKEND.md`.
- Perplexity search runs only through the explicit provider-neutral `perplexity-tool-search` strategy. Settings store concrete strategy ids, and entitlement/model validation rejects unknown or unavailable values before execution.
- Expose only search strategies allowed for the current user/model through the backend catalog.
- Store ordinary citations/annotations/search result metadata as response artifacts. Citation URLs are sanitized through the shared link-safety helper before persistence/read-back/rendering; unsafe schemes render inertly. Native Gemini grounded citations are the deliberate exception: their Links and associated answer remain transient under ADR 0031.
- Show live Search state only when current events prove it, distinguish selected-off from backend-skipped, and turn completed activity into a count-first collapsed thread disclosure while keeping detailed artifacts in model-run events and APIs.

## Sharing

`Share (anonymously)` creates a sanitized public snapshot of the active visible branch. It must not expose raw provider payloads, private attachments, API keys, internal run ids, private folder metadata, or auth data. A branch containing native Gemini grounded live-only provenance is rejected rather than publishing its placeholder or reconstructing content. The public snapshot does not mutate when the private chat changes.

## Logging And Retention

`CRITICAL_INVARIANTS.md` owns the durable privacy rule and `BACKEND.md` owns the exact persistence/retention contract. QSA transparency never authorizes duplicated raw request logs or broader provider-payload retention.
