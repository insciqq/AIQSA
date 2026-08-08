# OPENROUTER RUNTIME

Owner: Provider runtime maintainers
Scope: Current AIQSA runtime behavior for the OpenRouter Chat Completions answer adapter and typed Perplexity Search transport.
Read when: Changing OpenRouter request/response mapping, routing, streaming, attachments, citations, or Perplexity Search execution.
Code owners: `lib/server/providers/openRouter*.ts` and OpenRouter runtime construction.
Not owned here: Upstream OpenRouter facts, shared admission, or provider-neutral Search planning and persistence.

## OpenRouter

OpenRouter is implemented as an OpenAI-compatible Chat Completions answer provider plus the typed Perplexity Search protocol used by query-only client Search integrations.

`openRouterChat.ts` is the stable facade used by runtime construction, tests, and the standalone smoke script. `openRouterChatRequest.ts` owns answer/search bodies and always-redacted previews; `openRouterChatResponse.ts` owns JSON/SSE errors, text, usage, reasoning, citations, tool calls, and normalized results; `openRouterChatTransport.ts` owns the authenticated fetch endpoint, timeout composition, object parsing, and sanitized HTTP errors; `openRouterPerplexitySearch.ts` owns real/fake search-adapter result assembly. Provider-neutral tool definition/execution remains in `lib/server/tools/`, outside these wire modules.

Current behavior:

- fetch-based `/api/v1/chat/completions` requests;
- provider-side prompt-cache routing is always hinted with a hashed per-chat `session_id`; Anthropic-routed OpenRouter requests also include top-level `cache_control: { "type": "ephemeral" }`;
- `Automatic` omits downstream allowlists and permits fallback under fixed privacy defaults; `Only selected providers` sends the administrator's ordered `order`/`only` list and denies fallback outside it;
- Answer-stage runs default to `stream: true`, consume OpenRouter SSE chunks as live token events, collect final usage from the terminal usage chunk, and preserve reasoning/citation artifacts when chunks expose them; the `[DONE]` sentinel is required for success, and prior EOF is `openrouter_stream_truncated` even when text, finish reason, or usage was already received;
- the same per-model Stream control can send `stream: false`; the adapter then uses the non-streaming Chat Completions response path while preserving final answer, usage, reasoning, and citation artifacts;
- redacted provider request preview with route-provider controls;
- An admitted native PDF becomes Chat Completions `file` content with the OpenRouter `file-parser` engine plugin;
- a selected Perplexity client integration is exposed through the plan's provider-neutral Search tool even when the answer input has attachments, sends only the strictly validated generated query through a non-streaming technical Chat Completions request, returns normalized results to the answer transcript, persists one exact `SearchRun` per actual engine call, and rejects both HTTP-200 error envelopes and malformed terminal JSON (`{}`, missing first message, unusable content) instead of completing blank evidence; invalid tool arguments create no provider call/SearchRun, and valid text/content arrays plus answer-round tool-call-only messages remain supported;
- the Perplexity search executor stays non-streaming;
- Search runs are stored in `SearchRun`;
- Search artifacts are emitted as normal model-run artifact events;
- Perplexity route defaults to `data_collection: "deny"`, `order: ["perplexity"]`, `sort: "throughput"`, and `require_parameters: false`.
- Downstream endpoint tags compare case-insensitively while safe evidence preserves the administrator-configured spelling.
