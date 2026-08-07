# PROVIDER TRANSPORT AND LIMITS

Owner: Provider runtime maintainers
Scope: Common provider adapter interface, HTTP/SSE deadlines, response bounds, retention limits, and normalized result boundary.
Read when: Changing provider transport timeouts, response or stream limits, cancellation, overflow behavior, adapter types, previews, usage, or artifacts.
Code owners: `lib/server/providers/types.ts`, provider transport modules, `lib/server/providers/sse.ts`, and `lib/server/providers/streamSafety.ts`.
Not owned here: Admission/credentials, provider-neutral Search planning, provider-specific terminal semantics, or mutable upstream facts.

## Provider Transport And Limits

Provider HTTP transports keep the ordinary `AIQSA_PROVIDER_TIMEOUT_MS` deadline active through bounded success-JSON and non-2xx error-body reads. A validated client-Search execution instead supplies its immutable revision's 5-second to 15-minute timeout to the same transport, so a long search is not silently truncated by the ordinary 30-second default. Those untrusted bodies still share the `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` cap (16 MiB by default), are cancelled on timeout/overflow, and feed only sanitized error previews. A successful SSE response releases the ordinary request deadline after headers and remains governed by caller cancellation plus independent per-read idle, absolute-duration, per-event raw-byte, total raw-byte, and retained-output limits. The configured defaults are 30 seconds idle, 10 minutes absolute, 4 MiB/event, 64 MiB/stream, and 8 Mi retained characters; visible answer text and independently accumulated reasoning, tool-argument, signature, and citation structures are checked before retention. All adapters measure the same bounded streaming contract while preserving immediate valid deltas and provider terminal semantics; they never truncate or automatically retry an overflowed response.

`lib/server/providers/types.ts` is the code owner of the adapter boundary: `NormalizedRunRequest` is the normalized/persistable request shape and `ProviderRunRequest` adds resolved private attachments plus tool/streaming execution controls. Do not copy those interfaces into living prose; update the exported types and their tests together. Each adapter emits normalized events and returns a `ProviderRunResult` with safe provider-specific request/response previews, usage, and artifacts.
