# PROVIDERS

Owner: Provider integration maintainers
Scope: Provider admission, transport, adapter identity, Search/embedding boundaries, and mutable upstream caveats.

## Common Admission And Transport

Provider configuration is mutable draft plus immutable tested/active revision. Catalog rows are untrusted availability evidence, not execution authority. Admission resolves the current user's exact model entitlement and credential precedence, validates answer versus embedding role and capabilities, then atomically binds the non-secret connection/model/revision/credential evidence. Later changes affect future runs; revocation is rechecked under the same lock before every outbound request.

Direct-user credentials precede identical group grants, which precede an explicitly configured installation default. Missing or unusable authority fails closed; no tier, model, endpoint, or provider substitution is allowed. The internal system-model role uses only the selected deployment's installation credential and does not grant entitlement.

Every adapter has an immutable response deadline (`model override ?? connection`), bounded buffered and streaming bytes/events, cancellation, strict terminal proof, and normalized value-free failures. Timeout, cancellation, truncation, malformed wire data, and safety overflow are distinct. Never persist or log raw bodies, reasoning, tool arguments, credentials, custom endpoints, or provider errors merely for diagnosis.

Custom compatible roots require an explicit protocol and canonical base root; do not guess or append `/v1` heuristically. Public endpoints require HTTPS and bearer auth. Private/local HTTP and explicit no-auth require their dedicated reviewed flags, pinned resolution/redirect validation, and immutable tested evidence; no Authorization header is emitted for no-auth.

## Runtime Identities

- **OpenAI:** native execution uses Responses. Background work requires stored provider state, bounded polling/recovery/cancel, and `completed` terminal proof; incomplete is failure. Hosted web Search, prompt caching, reasoning, and PDF input remain Responses-specific. Compatible Responses strips native background/store/cache lifecycle.
- **OpenAI-compatible Chat:** uses the shared Chat Completions core with explicit streaming-usage capability. The simple Custom path is Chat; other protocols are advanced choices. Discovery proves identifiers, not tool or terminal reliability.
- **Anthropic:** uses Messages streaming. `message_stop` plus a reviewed stop reason is terminal; refusal and context-window stop reasons are successful wire terminals even when the product outcome is not a normal answer. Tool/Search continuation preserves required opaque blocks only within the same provider flow.
- **Gemini:** uses native stateless Interactions v1 only, without a compatibility fallback. Streaming requires ordered events, a terminal response, and `[DONE]`; thought signatures are private continuation state. Hosted Google grounding is live-only: validated Suggestions may render live, but grounded answer text, markup, signatures, and citation links are not durable or shareable. Hosted Search and application tools are not combined until the stable protocol supports it.
- **OpenRouter:** uses the shared Chat core with an explicit routing/privacy profile. `[DONE]` is required; citations, reasoning, PDF input, routing, and data-collection controls use OpenRouter shapes. Account-visible models/routes are mutable and never imported blindly. Perplexity integrations are query-only Search engines.
- **Fake:** is deterministic verification only and cannot become a production fallback.

## Search And Embeddings

A user selects logical Search sources; admission alone assigns exact hosted or query-only physical routes. Client Search receives one normalized bounded generated query and server-owned execution controls—never the conversation, prompts, attachments, filenames, bytes, or extracted text. Findings are bounded safe URL/text projections; raw bodies and recursively discovered URLs are not retained. Partial fan-out is explicit and no unselected fallback runs.

Embedding deployments are a separate model class and cannot answer chats or become answer defaults. An accepted embedding request pins exact connection/model/credential, vector-space identity, dimension, and document/query mode. Batched results must match count/model/dimension and contain finite values; configured shortening is local and followed by L2 normalization. Vector spaces never mix and failures never fall back to a different embedding target.

## Mutable Upstream References

Reverify the affected primary source when provider work depends on mutable behavior; update the single marker below rather than adding a chronology. Adapter tests own exact wire mapping and code-owned presets own model lists/defaults.

| Boundary | Last verified | Primary references |
| --- | --- | --- |
| OpenAI Responses | 2026-08-12 | [Responses API](https://platform.openai.com/docs/api-reference/responses), [background mode](https://platform.openai.com/docs/guides/background), [web search](https://developers.openai.com/api/docs/guides/tools-web-search) |
| Compatible OpenAI | 2026-08-12 | [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [codex-lb setup](https://soju06.github.io/codex-lb/client-setup/) |
| Anthropic Messages | 2026-08-12 | [Messages API](https://docs.anthropic.com/en/api/messages), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) |
| Gemini Interactions | 2026-08-12 | [Interactions v1](https://ai.google.dev/api/interactions-api-v1), [function calling](https://ai.google.dev/gemini-api/docs/function-calling), [Google Search](https://ai.google.dev/gemini-api/docs/google-search) |
| OpenRouter | 2026-08-12 | [API overview](https://openrouter.ai/docs/api/reference/overview), [streaming](https://openrouter.ai/docs/api/reference/streaming), [routing](https://openrouter.ai/docs/provider-routing) |
| Embeddings | 2026-08-08 | [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings), [OpenRouter embeddings](https://openrouter.ai/docs/api/reference/embeddings) |
| MCP OAuth | 2026-07-29 | [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) |

Run/recovery semantics are in [Run contracts](RUN_CONTRACTS.md); trust and SSRF rules are in [Security](SECURITY.md).
