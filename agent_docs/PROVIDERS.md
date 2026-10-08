# PROVIDERS

Owner: Provider integration maintainers
Scope: Execution authority, capability evidence, transport and disclosure boundaries.

Adapters: [code](../lib/server/providers/); execution: [Run contracts](RUN_CONTRACTS.md); credentials/endpoints: [Security](SECURITY.md).

## Authority And Capability

Catalog discovery is availability evidence, never execution authority. Admission binds the exact tested connection/model/revision/credential and role, then rechecks revocation before outbound requests. Personal credential precedence is direct user, identical group grant, then an explicitly configured installation default. Project runs use canonical Project resources and shared authority only. Missing authority never selects another tier, model, endpoint or provider.

Answer, embedding, rerank and Decisions roles are distinct. Internal roles use selected installation credentials, grant no user entitlement and ignore selector visibility. Image generation is instead a published resource on installation credentials: administrators publish verified models with their own parameters and keep one default, without which image generation is off for everyone; each user may choose one published model, otherwise following the default, and Project runs use only the default. An unusable published model is marked, never substituted; only withdrawal or clearing the role resets choices. Unavailable Chat titles preserve heuristic naming; qualification requires structured output. Vision independently requires verified image input, never borrowing another role's assignment; qualification differs from analysis-tool availability. Failed capabilities preserve unrelated roles. [Memory](MEMORY.md) owns independent reads, action authority and ranking.

Optional Decisions require independent disclosure, consumer-specific qualification and verified availability. Adoption, including one-time OpenRouter upgrades, preserves explicit choices; absence preserves ordinary functions. Executions pin served model/provider identities without granting truth, ownership or mutation authority. Claim before upgrade I/O; failures require explicit repair, never automatic replay or startup blocking.

Key replacement tests the active connection and publishes evidence atomically under exact version fences. Endpoint changes require fresh explicit secrets for every retained key, including disabled ones, before contacting the new destination. Stored secrets are never reused to discover or test changed endpoints. Search Save & Check publishes validated configuration/evidence; diagnostic run checks never publish configuration.

Capabilities need successful probes on the exact active connection/model/credential/route, never names, metadata or ordinary access. Structured output, strict Memory actions, image and PDF proofs are independent. PDF also requires runtime opt-in; image proof grants no payload limit. Reverify stale evidence.

Required results may use automatic choice, preserving reasoning and validating calls before effects. Native and automatic modes need independent proofs; Memory checks its effective reasoning mode. Gemini structured-output projections omit descendant-array upper bounds for compatibility; consumers enforce canonical bounds.

Initial Add provider/model and Test & Save authorize all implemented capability probes for that model class, including direct PDF without catalog hints. Publish each successful capability and its enabled flag together on the exact tested model/key revision. Preserve usable models and independent proofs on partial failure; setup retries reuse only current matching proofs and never recreate the saved graph. Later administrator disables remain authoritative: routine discovery and rechecks cannot reactivate them. Setup is complete only after its checks and publications settle; cancellation preserves committed results and fences late writes.

Only deterministic rejection or static adapter restrictions prove incompatibility. Authentication, rate-limit, network, timeout, safety-limit and upstream failures preserve prior evidence. Cancellation neither erases support nor grants capabilities. Discard raw probe content/errors.

Native PDF qualification must read image content through the selected native route; intermediary OCR text is no proof. A refused, incorrect or truncated answer and a generic HTTP error are inconclusive; only explicit unsupported input/route evidence establishes PDF incompatibility.

## Transport And Disclosure

Every accepted transport has bounded input/output, cancellation, exact terminal proof and value-free failures. Retry only explicitly admitted replay-safe work under its adapter/stage-owned failure classification and deadline policy, without changing accepted authority or destinations. Native/background create, accepted streams and crash-ambiguous dispatched work are never blindly replayed. Every physical utility request contributes content-free accounting, including admitted retries or delayed selected-provider attempts. Never retain raw requests, responses, reasoning, tool arguments or provider errors for diagnosis.

Operator exception (2026-10-08; users repeated such rounds by hand, and a round's tools run only after its result): on a Codex LB connection (the accepted snapshot's codex-lb catalog evidence, else a legacy `/backend-api/codex` root), a live tool-loop answer round whose Responses request failed with HTTP 502, or whose stream ended before completion (truncated, error event, `response.failed`, reset), without a deterministic classification, is sent again at most twice: the request it dispatched, same destination, credential and model, after the shared backoff (jitter, Retry-After), under Stop and run deadlines, unless it accepted output other than text. Each request is one operation (a lost one of unknown usage); the retry replaces the round's text; recovery never re-sends. Accepted cost: duplicate gateway quota.

Agent uses admitted Responses without guaranteeing model compatibility. Gateway receipts bind each Search continuation to its model; source budgets survive requests. Guest counters/reservations never justify billing. Unknown usage and late receipts retain their attempt identity.

Custom roots require explicit protocol and canonical base URL; do not guess `/v1`. Public endpoints require HTTPS and bearer authentication. Private/local HTTP and no-auth require their reviewed flags, pinned resolution/redirect checks and immutable tested evidence. No-auth emits no Authorization header.

Gateway routing isolation is compatibility behavior, never identity or retry authority. Automatic detection belongs to validated catalog evidence bound to the tested endpoint and credential; explicit overrides and accepted snapshots remain authoritative. Opaque routing keys isolate physical requests without exposing private identity or acting as idempotency keys. Preserve concurrency; fixed delays cannot guarantee isolation.

Native and compatible protocols have distinct runtime identities; wire similarity grants no fallback authority. Native OpenAI background work requires stored provider state; compatible Responses inherits no store/background/cache lifecycle. DeepSeek and Gemini use native paths without compatible fallback. Gemini thought signatures remain private continuation state; combining hosted Search and application tools requires stable protocol support. Forced Gemini rounds narrow `allowed_tools` to their named tool; `any` compiles every advertised schema. OpenRouter defaults to a discovered native provider without outside fallback; operator Automatic/custom choices remain authoritative. A changed provider restriction on a deployment an installation role pins is refused before activation when the catalog shows no selected endpoint listing a parameter set that role sends with `require_parameters`, or cannot be read; catalog parameters cannot prove image or PDF input, so those roles rely on their checks. One-time adoption preserves routing until fresh capability proofs for all usable keys publish together. Unresolved or crash-ambiguous checks require explicit Test & Save. Data collection defaults to `deny`; per-model `allow` requires administrator choice, revalidated at admission and dispatch. Fakes are verification-only.

Client Search receives only a bounded generated query and server-owned controls, never conversation, prompts, attachment identity, filenames, bytes or extracted text. Findings are bounded safe URL/text projections; raw bodies and recursively discovered URLs are not retained. Partial fan-out is explicit and no unselected fallback runs. Only the dedicated native DeepSeek Responses Search path may publish explicit `provider_unavailable` attribution with an empty source list.

## Documents, Embeddings And Reranking

Chat PDF and Knowledge document work freeze their separately admitted destinations and capability evidence. Transcription has no tools or Search, cannot mutate Memory and needs no structured output. A model-route failure never silently selects local extraction or another provider. The versioned native-text augmentation boundary is in [Run contracts](RUN_CONTRACTS.md); it is not an alternate provider route.

Knowledge Profiles authorize exact document/query embedding destinations through tested installation credentials. Ordinary request fields cannot choose that authority. Legacy Profile revisions retain their accepted user-authority identity until explicitly reprocessed; new profiles do not inherit compatibility authority. Embedding eligibility requires both document and query protocol proof at the target dimension. Requests pin vector-space identity and mode; invalid count/model/dimension or non-finite output rejects the batch. Vector spaces never mix and failures do not substitute a deployment.

Memory standing admission performs no external reads. Model-invoked search retains exact accepted embedding/reranking destinations and bounded cancellation. Memory owns its versioned query transform independently of provider query templates. Routing order, deadline or credential changes alone do not redefine document-vector identity. Reusing an older generation requires immutable successful execution proof of the same canonical vector space, not a model-name match.

A reranker receives a sanitized query and bounded opaque-handle documents, returning scores only. Complete one-to-one handle coverage and governed model/provider identity are mandatory; one malformed or missing result invalidates the batch. Scores confer no ownership, lifecycle, safety, currentness or mutation authority. A selected-but-broken deployment never falls through to an unselected deployment or the generative System Model. Any configured Memory route fallback remains subject to [Memory](MEMORY.md)'s whole-pool atomicity. Internal Knowledge reasoning overrides may change only the admitted answer deployment's supported reasoning effort, never its destination or credential.

Speech to text is an installation role on a connection and upstream model id, without a ProviderModel row or model class. Discovery only offers candidates; a passing Test with the bundled synthetic sample saves the role and binds the tested default-key version, so a replaced key needs a new Test, and nothing falls back to another connection or model. OpenRouter receives its JSON form, which alone carries `data_collection: deny`. Dictation audio and transcripts exist only within the request.

Forward migrations never replace an administrator's token price: they update `catalog` rows, or unknown prices no administrator could have set, matched by `providerModelCatalogKey` (a tariff of the row's own model class: template key, else codex-lb or Quick Setup upstream); never synchronize at startup.

Every paid call, answers included, takes the provider-reported cost (OpenRouter BYOK adds the upstream cost), else its model's class prices, else stays unknown; reported search counts add a per-search price only when one is set. A run's rewrites and recovery keep a reported answer cost. Every paid call that returned usage is recorded once with its purpose, failed and administrator check calls included.

## Upstream References

Reverify primary documentation when changing provider behavior. Adapter tests own exact wire support.

- OpenAI: [Responses](https://platform.openai.com/docs/api-reference/responses), [background mode](https://platform.openai.com/docs/guides/background), [SDK retries](https://github.com/openai/openai-node/blob/main/docs/configuration.md#retries-and-timeouts).
- Anthropic: [Messages](https://docs.anthropic.com/en/api/messages), [streaming and terminals](https://platform.claude.com/docs/en/build-with-claude/streaming).
- DeepSeek: [Responses](https://api-docs.deepseek.com/api/create-response/).
- Gemini: [Interactions](https://ai.google.dev/api/interactions-api-v1), [Google Search](https://ai.google.dev/gemini-api/docs/google-search).
- OpenRouter: [routing](https://openrouter.ai/docs/guides/routing/provider-selection), [structured output](https://openrouter.ai/docs/guides/features/structured-outputs), [embeddings](https://openrouter.ai/docs/api/reference/embeddings), [reranking](https://openrouter.ai/docs/api/api-reference/rerank/create-rerank), [speech to text](https://openrouter.ai/docs/guides/overview/multimodal/stt).
- MCP: [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
