# PROVIDERS

Owner: Provider integration maintainers
Scope: Execution authority, capability evidence, transport and disclosure boundaries.

Exact adapters, supported protocols, terminal events, request shapes and limits belong to [provider code](../lib/server/providers/). [Run contracts](RUN_CONTRACTS.md) owns accepted execution; [Security](SECURITY.md) owns credentials, SSRF and endpoint trust.

## Authority And Capability

Catalog discovery is availability evidence, never execution authority. Admission binds the exact tested connection/model/revision/credential and role, then rechecks revocation before outbound requests. Personal credential precedence is direct user, identical group grant, then an explicitly configured installation default. Project runs use canonical Project resources and shared authority only. Missing authority never selects another tier, model, endpoint or provider.

Answer, embedding and rerank roles are distinct. Internal System Model, Chat titles, chat PDF and Knowledge document assignments use their explicitly selected installation credentials, confer no user entitlement and do not inherit ordinary selector visibility. Chat titles use an independent nullable assignment with verified structured output; the stronger Memory requirements remain independent. An absent or unavailable title assignment keeps the heuristic name without fallback dispatch. A failed capability disables only that capability, preserving unrelated valid roles. Memory read admission is independent of the System Model; [Memory](MEMORY.md) owns action authority and optional ranking policy.

Key replacement tests the active connection and publishes evidence atomically under exact version fences. Endpoint changes require fresh explicit secrets for every retained key, including disabled ones, before contacting the new destination. Stored secrets are never reused to discover or test changed endpoints. Search Save & Check likewise publishes only successfully validated configuration and evidence; a diagnostic run check does not publish configuration.

Capabilities require successful probes on the exact active connection/model/credential and route. Model names, administrator metadata and ordinary model access do not prove structured output, strict Memory actions, image or direct-PDF support. These capabilities are independent: ordinary function calling does not prove strict action support. PDF admission requires runtime opt-in as well as positive evidence; an image probe proves support, not maximum payload size. Stale evidence requires re-verification.

Initial Add provider/model and Test & Save authorize all implemented capability probes for that model class, including direct PDF without catalog hints. Publish each successful capability and its enabled flag together on the exact tested model/key revision. Preserve usable models and independent proofs on partial failure; setup retries reuse only current matching proofs and never recreate the saved graph. Later administrator disables remain authoritative: routine discovery and rechecks cannot reactivate them. Setup is complete only after its checks and publications settle; cancellation preserves committed results and fences late writes.

Only deterministic probe rejection or a statically unsupported adapter proves incompatibility. Authentication, rate limiting, network, timeout, safety-limit and upstream outages fail the check while preserving prior evidence. Cancellation cannot erase earlier support or promote untested capability. Discard raw probe output and errors.

Native PDF qualification must read image content through the selected native route; intermediary OCR text does not prove that capability. A refused, incorrect or truncated answer and a generic HTTP error are inconclusive; only explicit unsupported input/route evidence establishes PDF incompatibility.

## Transport And Disclosure

Every accepted transport has bounded input/output, cancellation, exact terminal proof and value-free failures. Retry only explicitly admitted replay-safe work under its adapter/stage-owned failure classification and deadline policy, without changing accepted authority or destinations. Native/background create, accepted streams and crash-ambiguous dispatched work are never blindly replayed. Every physical utility request contributes content-free accounting, including admitted retries or delayed selected-provider attempts. Never retain raw requests, responses, reasoning, tool arguments or provider errors for diagnosis.

Custom roots require explicit protocol and canonical base URL; do not guess `/v1`. Public endpoints require HTTPS and bearer authentication. Private/local HTTP and no-auth require their reviewed flags, pinned resolution/redirect checks and immutable tested evidence. No-auth emits no Authorization header.

Gateway routing isolation is compatibility behavior, never identity or retry authority. Automatic detection belongs to validated catalog evidence bound to the tested endpoint and credential; explicit overrides and accepted snapshots remain authoritative. Opaque routing keys isolate physical requests without exposing private identity or acting as idempotency keys. Preserve concurrency; fixed delays cannot guarantee isolation.

Native and compatible protocols are separate runtime identities; wire similarity grants no fallback authority. Native OpenAI background work requires stored provider state; compatible Responses does not inherit its store/background/cache lifecycle. DeepSeek and Gemini use their dedicated native paths without compatible fallback. Gemini thought signatures remain private continuation state; hosted Search and application tools are not combined until the stable protocol supports it. OpenRouter preserves the selected routing/privacy profile and defaults data collection to `deny`; an administrator may explicitly opt an individual model into `allow`, revalidated at admission and dispatch. Fakes are verification-only.

Client Search receives only a bounded generated query and server-owned controls, never conversation, prompts, attachment identity, filenames, bytes or extracted text. Findings are bounded safe URL/text projections; raw bodies and recursively discovered URLs are not retained. Partial fan-out is explicit and no unselected fallback runs. Only the dedicated native DeepSeek Responses Search path may publish explicit `provider_unavailable` attribution with an empty source list; do not generalize that exception to other providers.

## Documents, Embeddings And Reranking

Chat PDF and Knowledge document work freeze their separately admitted destinations and capability evidence. Transcription has no tools or Search, cannot mutate Memory and does not require structured output. A model-route failure never silently selects local extraction or another provider. The versioned native-text augmentation boundary is in [Run contracts](RUN_CONTRACTS.md); it is not an alternate provider route.

Knowledge Profiles authorize exact document/query embedding destinations through tested installation credentials. Ordinary request fields cannot choose that authority. Legacy Profile revisions retain their accepted user-authority identity until explicitly reprocessed; new profiles do not inherit compatibility authority. Embedding eligibility requires both document and query protocol proof at the target dimension. Requests pin vector-space identity and mode; invalid count/model/dimension or non-finite output rejects the batch. Vector spaces never mix and failures do not substitute a deployment.

Memory owns its versioned query transform independently of provider query templates. Routing order, deadline or credential changes alone do not redefine document-vector identity. Reusing an older generation requires immutable successful execution proof of the same canonical vector space, not a model-name match.

A reranker receives a sanitized query and bounded opaque-handle documents, returning scores only. Complete one-to-one handle coverage and governed model/provider identity are mandatory; one malformed or missing result invalidates the batch. Scores confer no ownership, lifecycle, safety, currentness or mutation authority. A selected-but-broken deployment never falls through to an unselected deployment or the generative System Model. Any configured Memory route fallback remains subject to [Memory](MEMORY.md)'s whole-pool atomicity. Internal Knowledge reasoning overrides may change only the admitted answer deployment's supported reasoning effort, never its destination or credential.

## Upstream References

Reverify affected primary documentation when changing provider behavior; this file is not evidence of a current upstream check. Adapter tests own AIQSA's exact wire support.

- OpenAI: [Responses](https://platform.openai.com/docs/api-reference/responses), [background mode](https://platform.openai.com/docs/guides/background), [SDK retries](https://github.com/openai/openai-node/blob/main/docs/configuration.md#retries-and-timeouts).
- Anthropic: [Messages](https://docs.anthropic.com/en/api/messages), [streaming and terminals](https://platform.claude.com/docs/en/build-with-claude/streaming).
- DeepSeek: [Responses](https://api-docs.deepseek.com/api/create-response/).
- Gemini: [Interactions](https://ai.google.dev/api/interactions-api-v1), [Google Search](https://ai.google.dev/gemini-api/docs/google-search).
- OpenRouter: [routing](https://openrouter.ai/docs/guides/routing/provider-selection), [structured output](https://openrouter.ai/docs/guides/features/structured-outputs), [embeddings](https://openrouter.ai/docs/api/reference/embeddings), [reranking](https://openrouter.ai/docs/api/api-reference/rerank/create-rerank).
- MCP: [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
