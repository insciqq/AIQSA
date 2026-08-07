# PROVIDER-NEUTRAL CLIENT SEARCH

Owner: Provider runtime maintainers
Scope: Current Search route assignment, provider-neutral request/result boundary, tool-loop budgets, typed client adapters, safe evidence, and query-only privacy behavior.
Read when: Changing Search planning, hosted/client route selection, query validation, fan-out, Search limits, SearchRun evidence, or OpenAI, Gemini, and OpenRouter query-only routes.
Code owners: `lib/server/search/`, `lib/server/runs/providerToolLoop.ts`, provider Search adapters, and Search admission in `lib/server/runs/`.
Not owned here: Provider-specific hosted answer serialization, provider-specific upstream facts, general provider admission, or MCP tool execution.

## Provider-Neutral Client Search

OpenAI-style parameter metadata uses temperature `1` as the neutral default;
`0` remains an explicit deterministic/focused choice. Accepted max-output
aliases are canonicalized once before budgeting and serialization. Runtime
preparation consumes the complete assignment admitted under [Search plans](../../run_pipeline/SEARCH_PLANS.md)
and snapshots every logical option, physical revision, typed bounds, technical
model limit, policy, and credential binding; it does not replan or choose a
fallback. The answer adapter receives one fan-out tool for `all_selected` or a
separately named tool per client option for `model_choice`, while hosted Search
remains provider-native. The common loop preserves supported background and
streaming behavior, executes returned batches with bounded concurrency, allows
at most three tool rounds and 16 total calls, enforces each revision's admitted
invocation budget, reapplies context budget after every batch, and forces the
terminal no-tool synthesis round when the tool-round budget is exhausted.

`ProviderSearchRequest` is structurally independent from `ProviderRunRequest`:
it carries the validated query, opaque invocation correlation, and immutable
server policy, with no field for broader answer input or resolved attachments.
Exactly one normalized query is accepted; wrong-shape or over-limit arguments
settle as a bounded tool error before a provider call or `SearchRun`.
`ProviderSearchResult` requires bounded non-empty findings, an explicit flat
safe HTTP(S) source list, allowlisted operations, usage, and redacted previews;
common execution validates those adapter-selected fields and never recursively
discovers URLs in an arbitrary response. The runtime applies revision-owned
controls and starts each provider call with the earlier of the Search revision
deadline and the technical provider model's effective snapshotted response
deadline. Its bounded request preview records the Search, provider, and
effective millisecond values. It merges fan-out in plan/rank order and persists
one canonical settled result for foreground and recovery reuse. The product privacy,
attachment, default-policy, and invocation semantics are owned by [Search plans](../../run_pipeline/SEARCH_PLANS.md);
this boundary makes them unrepresentable or revalidates them before I/O.

`openai-native-web-search` is the official OpenAI connection's canonical logical source id; `openai-provider-web-search` survives only as a migration/request alias. Beneath the one source, a hosted route serializes `web_search` into an answer request on that exact connection, while a configuration-evidenced client route performs a query-only OpenAI call and returns normalized evidence through the common tool loop to another tool-capable answer adapter. OpenAI Quick setup and provider activation create/refresh both routes without a Search probe; an optional diagnostic does not affect publication or availability. Each custom compatible Responses connection with explicitly declared hosted search owns a separate connection-scoped source and follows the same exact-source rule.

The query-only OpenAI Responses route offers only `web_search` with required tool choice and accepts success only after a terminal completed Search call, non-empty bounded findings, and at least one normalized safe HTTP(S) source. The OpenRouter/Perplexity route accepts its current nested `url_citation` annotation records plus bounded explicit legacy citation arrays/flat records. Both fail source-less responses as typed raw-free Search errors with already reported usage; unknown nesting and recursive URL discovery remain forbidden.

For an admitted Gemini client route, the adapter sends a unary non-streaming
`store: false` Interactions request with the query-only projection and
`{ type: "google_search" }`. It requires terminal interaction, actual Search,
Suggestions, grounded-finding, and safe-citation proof, then returns only
canonical findings/citations, bounded operations, usage, and a safe preview.
Suggestions markup, signatures, raw steps, and the provider body remain
transient. Logical-source publication and cross-provider use belong to
[Search plans](../../run_pipeline/SEARCH_PLANS.md).
