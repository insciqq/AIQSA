# PROVIDER TRANSPORT AND LIMITS

Owner: Provider runtime maintainers
Scope: Common provider adapter interface, HTTP/SSE deadlines, response bounds, retention limits, and normalized result boundary.
Read when: Changing provider transport timeouts, response or stream limits, cancellation, overflow behavior, adapter types, previews, usage, or artifacts.
Code owners: `lib/server/providers/types.ts`, provider transport modules, `lib/server/providers/sse.ts`, and `lib/server/providers/streamSafety.ts`.
Not owned here: Admission/credentials, provider-neutral Search planning, provider-specific terminal semantics, or mutable upstream facts.

## Provider Transport And Limits

Each accepted provider runtime resolves one immutable response deadline from its versioned binding: the optional model override wins over the required connection default. Admin supplies whole seconds from 5 through 900 and initializes a new connection to 300 seconds; storage/runtime use integer milliseconds. A missing or invalid stored deadline fails closed. The runtime starts one absolute model-round timer and passes the same effective value through each provider HTTP client, buffered success/error body read, and SSE idle/absolute guards. A streaming transport may release its header/body exchange timer after returning the SSE response, but the enclosing model-round timer and stream parser retain the same ceiling. Cancellation remains a distinct parent abort. External provider, reverse-proxy, and platform deadlines remain outside AIQSA's guarantee.

Native OpenAI non-streaming background execution is the one lifecycle exception: each create/retrieve exchange retains the immutable response deadline, while the sequence of waits and retrieves uses the independently bounded installation polling window owned by [environment configuration](../../ENV_VARIABLES.md). The runtime never substitutes that longer lifecycle value for an individual HTTP exchange, and an explicit caller deadline still wins as a shorter total-operation cap.

A validated client-Search call supplies the earlier of its immutable revision-owned 5-second to 15-minute invocation budget and its technical provider model's effective deadline. Both budgets and the result remain available to their operational owners; neither is silently undercut by a transport default. Untrusted buffered bodies still share the `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` cap (16 MiB by default), are cancelled on timeout/overflow, and feed only stable sanitized error facts. Streaming retains independent size limits of 4 MiB/event, 64 MiB total raw wire, and 8 Mi retained characters by default; visible answer text and independently accumulated reasoning, tool-argument, signature, and citation structures are checked before retention. All adapters measure the same bounded streaming contract while preserving immediate valid deltas and provider terminal semantics; they never truncate or automatically retry an overflowed response.

`lib/server/providers/types.ts` is the code owner of the adapter boundary: `NormalizedRunRequest` is the normalized/persistable request shape and `ProviderRunRequest` adds resolved private attachments plus tool/streaming execution controls. Do not copy those interfaces into living prose; update the exported types and their tests together. Each adapter emits normalized live events and returns a `ProviderRunResult` containing only the private continuation/terminal data consumed by recovery plus normalized usage, citations, generated artifacts, and stable errors. Provider request/response previews are not required adapter outputs solely for inspection.

Normalized required custom-tool choice maps to `required` on OpenAI-shaped
transports and OpenRouter, and to the equivalent `any` mode on Anthropic and
Gemini. Adapter tests own the exact wire shapes.
