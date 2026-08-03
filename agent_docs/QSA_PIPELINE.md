# QSA_PIPELINE

Owner: QSA pipeline maintainers
Scope: Current product-level Question, Search, Answer, tool, evidence, transparency, and sharing semantics across provider-neutral runs.

## Product Thesis

The core product is a transparent QSA workflow:

```text
Question -> Search -> Answer
```

The common conversation path stays calm while giving the operator precise control over API request shape, model parameters, the Search plan, streamed events, response artifacts, branch state, and provider-reported usage.

Streaming is a provider-neutral run capability. Catalog `capabilities.streaming` says a model/adapter can stream normalized run events; catalog `parameterControls.stream.supported` says the composer exposes a per-run Stream toggle for that model. OpenAI, Gemini, and OpenRouter currently expose the toggle, while other streaming providers can keep adapter-owned defaults until their user-facing control is deliberately enabled.

## Pipeline Stages

1. Question
   - user message;
   - a first-message chat title is derived locally and transactionally from bounded normalized text, ending at a whole-word boundary when one exists and storing no display ellipsis; it is not another provider request and creates no provider usage;
   - active branch conversation context from a recursive same-chat ancestor query that materializes only the selected root-to-leaf path;
   - editable system/developer prompt;
   - selected provider and model;
   - explicit request parameters;
   - optional PDF/image attachments where selected model and user entitlements allow them, plus text-like document attachments that are included as extracted provider text. PDFs route as provider-native files for `nativePdfInput` models and as extracted text for fallback PDF-capable models.
   - context budgeting uses the conservative Unicode estimate defined in `backend/RUNS_AND_STREAMING.md` and counts provider-bound attachment payload estimates. Native PDFs include both extracted-text and page-image proxies, so oversized extracted text, native PDFs, or images can reject before provider dispatch instead of leaking past the budget as small references.

2. Search
   - optional but first-class;
   - the user keeps one ordered preferred plan of zero to three entitled options and, for a multi-option plan, chooses `all_selected` or `model_choice`; the current model derives the compatible effective subset used by this run without overwriting that preference;
   - each logical option resolves to one active physical route and immutable Search-integration revision and, where needed, an exact technical provider-model credential binding; run admission revalidates readiness, compatibility, entitlement, exact source identity, and the complete combination immediately before provider execution;
   - unsupported, archived, stale, duplicate, over-limit, or incompatible ids and combinations are rejected without substituting another engine; the product behavior is owned by `Search Plans And Integrations` below;
   - live activity never guesses a provider's internal stage: the active tail and application rail say `Working…` while the exact stage is unknown, `Searching…` only after an already-consumed search/citation event proves it, and `Answering…` only after answer tokens arrive. Completed search activity becomes a source/status-first collapsed thread disclosure, with bounded counts and detailed normalized evidence available on demand.

3. Answer
   - streamed visible answer through the normalized SSE contract;
   - provider EOF is not success: OpenAI Responses requires a completed `response.completed`; native Gemini Interactions requires its valid terminal interaction followed by the native `done` proof; generic compatible Chat and OpenRouter streaming require `[DONE]`; compatible/OpenRouter non-streaming requires a usable first choice/message; and Anthropic requires `message_stop`. Accepted ordinary partial text remains inspectable with error status when terminal proof never arrives, while grounded Gemini text is live-only and cannot become partial durable history;
   - final foreground stream update carries the canonical changed chat/message snapshot needed by the UI, without reloading chat detail;
   - reasoning/thinking summaries or blocks when available, hidden in the thread by default and shown through a user toggle;
   - citations/search artifacts when available, with citations optionally visible in the thread;
   - provider response preview available for inspection under the storage/logging limits in `agent_docs/CRITICAL_INVARIANTS.md`.

MCP extends the middle of this pipeline with model-requested tools rather than adding a separate run mode. Every accepted tool-capable run receives the complete immutable namespaced inventory from all of that user's enabled, entitled, ready MCP servers; granting a server grants all of its valid tools, and no enabled-but-unready server is silently omitted. For a catalog model that cannot call tools, the composer explicitly sends `tools: "none"`, so preparation skips the MCP plan for that run without changing persistent server enablement; omission of this override retains the server-side capability/backstop checks. The model may request zero, one, or several calls over multiple rounds, including calls whose arguments use conversation data or a prior enabled server's result. Requested batches are persisted before bounded parallel execution, results return in provider order, and provisional streamed text is reset before the tool round. Foreground, Stream, and provider-native Background remain available whenever the selected adapter/model capabilities advertise the combination. Durable recovery reuses settled calls and native provider handles, reloads provider attachment payloads, and replays the same persisted provider transcript and accepted chat context under the same budget; it never retries a crash-ambiguous external side effect.

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
- the accepted compatible-provider reasoning effort/mode request mapping, when applicable;
- selected ordered Search plan and orchestration mode;
- exact Search option/revision bindings plus separately attributable actual engine invocations and bounded provider-native search/open/find operations when the provider reports them;
- attachment references and preprocessing summaries;
- streamed event log;
- final response preview;
- normalized token usage metadata, including cached/total token fields when providers report them; tool-search `ModelRun` and chat counters keep end-to-end aggregate usage while `UsageEvent` attribution separates answer-model usage from OpenRouter/Perplexity usage; provider-reported usage already observed before a later failure remains operationally attributable; estimated-cost compatibility data stays out of the user-facing shell and is not billing truth;
- tool-call and tool-result artifacts when an answer model actually invokes a backend tool, with client Search evidence nested under that exact originating call rather than inferred from opaque invocation ids;
- accepted MCP server/revision/tool snapshots, runtime-generation fingerprints, safe credential-source tags, and optional external account/workspace labels without endpoints or credential values;
- errors and retry/cancel state.

The UI can keep the common path clean, but the API surface must remain inspectable.

Details Events reduces the already-consumed normalized event stream into a chronological digest without changing the event schema or persistence contract. Repeated provider/search/tool/artifact/token/usage categories update the row created at their first occurrence; raw token deltas and internal message ids stay hidden, while counts, latest meaningful status, long failures, cancellation, and successful completion remain inspectable. Historical request/response payloads continue to live in the model-run APIs.

## Provider Strategy

Current providers:

- fake provider for deterministic tests;
- native OpenAI Responses as the first-class OpenAI path;
- custom OpenAI-compatible Responses and Chat Completions as explicit protocols in the direct endpoint/key/discovered-or-manual-model setup;
- Anthropic Messages API;
- Gemini through Google's native stateless Interactions v1 API, including native SSE, custom-function continuation, and optional hosted Google Search, with no compatibility fallback;
- OpenRouter Chat Completions-compatible API;
- explicitly configured Search-capable OpenAI Responses deployments as exact-source query-only Search clients for tool-capable answer models;
- administrator-selected OpenRouter search deployments for provider-neutral search tools;
- Provider-neutral run-tool contracts for web search, with native or explicitly declared compatible OpenAI Responses, Gemini Interactions, and OpenRouter Chat Completions bridge boundaries. Custom image-generation declarations remain future configuration evidence and do not create a runnable QSA capability.

Adapter defaults and cache/wire details live in `BACKEND.md`; externally verified constraints live in `PROVIDER_API_NOTES.md`.

## Search Plans And Integrations

- Search is an explicit per-run plan. Its ordered `optionIds` contain zero to three current Search options and its mode is `all_selected` or `model_choice`. An empty plan is Off; `search-disabled` remains only the compatibility/default representation of Off and is never treated as an engine invocation.
- Send/regenerate requests carry the effective `searchPlan`, a separate preferred Search plan/source intent, and the per-model `controlDefaults` snapshot. The bounded compatibility decoder still accepts an old singleton `searchStrategy` and normalizes it to one option. Admission validates the effective plan against the selected model and the personal preference against readiness/entitlement independently. After validation, the backend commits the full preference and guarded run graph together before provider execution; it never persists a model-clamped subset, and a rejected run changes neither graph nor defaults.
- One optimistic-versioned installation `SearchPolicy` recommends an ordered plan for users whose `UserSettings.defaultSearchPlan` is null. The accessible portion is inherited dynamically and grants no entitlement. A non-null empty user plan is explicit Off, a non-empty plan is personal, and `Use organization default` returns to inheritance without copying the current recommendation.
- Every non-Off `SearchOption` is one user-visible source owned by exactly one provider connection; the connectionless `search-disabled` compatibility sentinel continues to represent Off without invoking an engine. The official OpenAI connection and every custom OpenAI-like connection therefore remain distinct sources. Physical hosted/query-only `SearchStrategy` routes are control-plane implementation details and never separate Composer or administrator choices. Eligible provider setup publishes configuration-evidenced immutable route revisions without a provider Search request; an optional diagnostic may record current connectivity but never unlock or disable the route. Archive removes the logical option and its routes from future catalogs without rewriting grants, defaults, accepted bindings, executions, or history.
- For a selected OpenAI Search source, admission prefers that source's hosted route only when the answer model uses the same exact provider connection. For any other compatible tool-capable answer model it uses that source's active query-only route. Catalog exposure and admission resolve the current user's effective technical model, credential, active versions, and current availability check rather than comparing them with credential proof stored in a global Search revision. Credential rotation and different personal/group/default credentials therefore need no global re-probe, while every accepted run still pins its exact authority. It never substitutes a different OpenAI connection, key, endpoint, Search option, or provider when the exact source lacks a ready route. The ordinary catalog, Composer, preferences, policy, and grants use the logical option id as the user-choice identity; no physical route or revision id crosses those choice surfaces. Immutable run bindings additionally retain the admitted physical route, revision, and technical provider binding.
- `all_selected` exposes one provider-neutral search action and concurrently invokes every selected client engine with the same bounded generated query. It is available only when every option supports fan-out. `model_choice` exposes each compatible client engine separately and may also combine at most one supported provider-hosted option; the answer model can invoke none, one, or several within the common tool-loop limits.
- Every client-search invocation receives only one strictly validated bounded generated query plus reviewed server-owned result/timeout/routing/execution parameters. It never receives branch messages, original user content, system/developer prompts, provider tool messages, attachment ids, filenames, bytes, or extracted document text. Its query-only adapter does not inherit Composer or answer-model defaults: each immutable Search revision owns that source's output budget, reasoning policy, and per-answer invocation cap, while legacy revisions normalize to 4,096 output tokens, the lowest explicitly advertised reasoning effort, and two invocations without a migration or provider probe. Model-choice usage tracks each source independently; a fan-out invocation consumes one allowance from every participating source. Empty, malformed, extra-property, oversized, and over-budget calls fail closed without an engine call or Search execution row. Until a separate informed per-run disclosure-consent contract exists, a message with attachments cannot use any client Search option; the composer marks retained client choices unavailable and stale/legacy execution rechecks the boundary. Provider-hosted Search remains available because it runs inside the already selected answer-provider request and retains that answer request's controls.
- Fan-out runs concurrently with per-engine timeouts and caller cancellation. The immutable Search revision owns a 5-second to 15-minute engine deadline; new integrations default to 5 minutes, and client adapters pass that same deadline through to the actual provider transport rather than inheriting the ordinary 30-second provider exchange default. Successful evidence is merged deterministically by plan order and engine-local rank, safe normalized URLs are deduplicated while retaining every contributing option/rank, and no semantic relevance score is invented. Partial success keeps successful sources plus per-engine warnings; total failure returns an explicit search/tool error and never calls an unselected fallback.
- Each actual client-engine call creates a separately attributable `SearchRun` with exact option/revision/invocation identity, bounded query and request preview, normalized sources/errors, duration, reported usage, and the allowlisted provider-native operation trace when available. A Responses trace retains at most 32 merged `search | open_page | find_in_page | unknown` operations and 16 KiB per engine, with bounded status/query/URL/pattern facts plus an honest truncation marker; an incomplete response may additionally retain only its allowlisted status/reason and already reported usage, never the raw provider event or body. Merely selecting an option or rejecting an over-budget call creates no execution. Hosted provider activity retains its existing normalized event/artifact provenance.
- `openai-native-web-search` is the canonical logical id for the official OpenAI Search source; the legacy `openai-provider-web-search` id is accepted only at bounded compatibility/migration boundaries and canonicalized to it. Official OpenAI Quick setup creates the parent plus same-source hosted and cross-provider query-only routes directly from the reviewed Responses `nativeSearch` declaration. It performs no paid Search request and creates no second user-visible option.
- A custom OpenAI-like Responses connection with explicitly declared `web_search` creates its own connection-scoped logical OpenAI Search source and configuration-evidenced hosted/query-only routes, including explicitly tested private/local no-auth Responses connections. A query-only request receives only the validated generated query under the ordinary client-Search privacy, timeout, evidence, current-credential, and binding rules, whether the selected answer is OpenAI, Anthropic, Gemini, or another tool-capable model.
- `gemini-google-search` remains one exclusive native option. Once an actual native search begins, the adapter withholds answer text until non-empty Search Suggestions pass the strict parser; the grounded answer, Suggestions, Links, search result/signature data, and provider markup remain live-only, non-shareable, and non-replayable. Gemini Search cannot be combined with another Search option or MCP/client functions.
- Perplexity search runs only through an explicit selected client integration using the reviewed OpenRouter/Perplexity protocol. Its provider model may be explicitly technical-only: it then remains valid for Search credential/check resolution and immutable Search bindings without answer entitlement, but is absent from answer-model catalogs and rejected by answer admission. The technical model, credential precedence, routing/privacy defaults, output bounds, and active revision are server-authoritative; no hostname, display-name, or upstream model-id special case exists.
- Expose enabled, dependency-ready, entitled options once through the backend catalog and list compatibility separately on each answer model. A hosted option with no entitled available compatible answer model and a client option with no available compatible technical model are absent even when a stale active revision exists. A model switch marks retained incompatible preferences unavailable and excludes them only from the effective run plan; direct stale requests fail closed.
- Store ordinary citations/annotations/search result metadata as response artifacts. Citation URLs pass through the shared link-safety helper before persistence/read-back/rendering; unsafe schemes render inertly. Native Gemini grounded citations are the deliberate transient exception.
- Show live Search state only when current events prove it and distinguish selected-off from backend-skipped. Every observed hosted or client Search remains available after completion/reload as one direct default-collapsed Search disclosure below the answer, independently of the generic tool-activity preference. Its summary states the exact completed/attempted count when several attempts exist; one expansion keeps every attempt separately expandable with its generated query, friendly failure reason, normalized sources/citations, and bounded provider-reported operation detail when available. Client Search is excluded from generic `Used tools` presentation so it is not duplicated; MCP and other tools retain that separate preference. Missing historical/provider detail remains explicitly unavailable rather than an inferred zero.

## Sharing

`Share (anonymously)` creates a sanitized public snapshot of the active visible branch. It must not expose raw provider payloads, private attachments, API keys, internal run ids, private folder metadata, or auth data. A branch containing native Gemini grounded live-only provenance is rejected rather than publishing its placeholder or reconstructing content. The public snapshot does not mutate when the private chat changes.

Publishing requires an explicit confirmation: the Share action opens a dialog that explains the sanitized-snapshot semantics, and a link exists only after the confirming create action. Each snapshot records its source chat, and the chat's live links remain listed in that dialog with per-link revocation, so links are not immortal once the creation notice is dismissed. Stored tokens remain hashes; the full URL is visible only immediately after creation. Legacy snapshots created before the chat link existed are not listed and can be revoked only by their original id.

## Logging And Retention

`CRITICAL_INVARIANTS.md` owns the durable privacy rule and `BACKEND.md` owns the exact persistence/retention contract. QSA transparency never authorizes duplicated raw request logs or broader provider-payload retention.
