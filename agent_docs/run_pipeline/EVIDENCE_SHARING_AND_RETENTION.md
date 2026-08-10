# RUN PIPELINE — EVIDENCE, SHARING, AND RETENTION

Owner: Run pipeline maintainers
Scope: Transparency, provider strategy, inspection evidence, anonymous sharing, logging, and retention semantics.
Read when: Changing receipts/inspection meaning, provider strategy, share snapshots, logs, evidence retention, or privacy projections.
Code owners: Run inspection/evidence owners, sharing handlers, event projections, and retention integration.
Not owned here: Core dispatch/tool-loop stages, Search route planning, frontend composition, or provider wire mapping.

## Transparency Contract

For every model run, the app can show:

- the exact accepted Assistant identity and revision when one was used (`ModelRun.assistantId`/`assistantRevisionId`), with snapshot-bound name/avatar identity on the answer and receipt; later edits, archives, renames, or access changes never alter accepted runs, their receipts, or recovery, which read only accepted-run evidence;
- provider;
- model;
- exact normalized request;
- branch-context replay summary;
- context-window truncation summary when oldest prior turns were omitted;
- provider-specific request preview;
- selected API parameters;
- the accepted compatible-provider reasoning effort/mode request mapping, when applicable;
- selected ordered Search plan and orchestration mode, with accepted bindings
  and actual engine/provider operations remaining separately attributable;
- the ordered accepted Knowledge plan/bindings and every actual retrieval
  receipt, including generated query, revision/generation fence, explicit
  negative outcome, candidate/threshold facts, real scores, exact private
  source mapping, included-text truncation, embedding usage, and duration;
- the exact accepted Memory binding and immutable item projection for that run,
  including outcome/degradation, admitted text and version/source/scope
  snapshots, plus a later lifecycle annotation; current Memory may label old
  evidence forgotten or source-deleted but never rewrites it;
- a committed explicit Memory action only when its `APPLIED` operation receipt
  rejoins the exact same run and persisted first-party tool call;
- attachment references and preprocessing summaries;
- streamed event log;
- final response preview;
- normalized token usage metadata, including cached/total token fields when providers report them; tool-search/Knowledge `ModelRun` and chat counters keep end-to-end aggregate usage while `UsageEvent` attribution separates answer-model usage from Search and Knowledge embedding usage; provider-reported usage already observed before a later failure remains operationally attributable; estimated-cost compatibility data stays out of the user-facing shell and is not billing truth;
- tool-call and tool-result artifacts when an answer model actually invokes a backend tool, with client Search evidence nested under that exact originating call rather than inferred from opaque invocation ids;
- accepted MCP server/revision/tool snapshots, runtime-generation fingerprints, safe credential-source tags, and optional external account/workspace labels without endpoints or credential values;
- errors and retry/cancel state.

The UI can keep the common path clean, but the API surface must remain
inspectable. [Search plans and integrations](SEARCH_PLANS.md) owns the exact
execution and evidence records behind its Search projection.
Knowledge provider text contains only opaque citation handles, pages, and
bounded passages; private base/document labels and database/storage identities
remain authenticated inspection evidence.

Details Events reduces the already-consumed normalized event stream into a chronological digest without changing the event schema or persistence contract. Repeated provider/search/tool/artifact/token/usage categories update the row created at their first occurrence; raw token deltas and internal message ids stay hidden, while counts, latest meaningful status, long failures, cancellation, and successful completion remain inspectable. Memory contributes a passage-free outcome, included-item count/types, retrieval lanes and pipeline/planner versions, plus any degradation code; its exact text remains only in the answer-bound private receipt. Historical request/response payloads continue to live in the model-run APIs.

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
- Provider-neutral run-tool contracts for web search, with native or explicitly declared compatible OpenAI Responses, Gemini Interactions, and OpenRouter Chat Completions bridge boundaries. Custom image-generation declarations remain future configuration evidence and do not create a runnable image-generation capability.

Adapter defaults and cache/wire details are routed by `BACKEND.md`; externally verified constraints are routed by `PROVIDER_API_NOTES.md`.

## Sharing

`Share (anonymously)` creates a sanitized public snapshot of the active visible branch. It must not expose raw provider payloads, private attachments, API keys, internal run ids, private folder metadata, auth data, structured Knowledge evidence, or any Memory personal context, attempt, execution, binding, item, event, operation/tool receipt, identifier, source, or lifecycle metadata. Creation and every anonymous read both apply the same positive public schema: only user/assistant text blocks and the public title/version survive, preserving visible answer prose exactly while dropping unknown legacy fields. Knowledge- or Memory-bearing branches remain shareable because their private evidence is omitted. A branch containing hosted-answer Gemini grounded live-only provenance is rejected rather than publishing its placeholder or reconstructing content. Ordinary normalized client-Search findings are governed by the existing sanitized snapshot projection. The public snapshot does not mutate when the private chat changes.

Publishing requires an explicit confirmation: the Share action opens a dialog that explains the sanitized-snapshot semantics, and a link exists only after the confirming create action. Each snapshot records its source chat, and the chat's live links remain listed in that dialog with per-link revocation, so links are not immortal once the creation notice is dismissed. Stored tokens remain hashes; the full URL is visible only immediately after creation. Legacy snapshots created before the chat link existed are not listed and can be revoked only by their original id.

## Logging And Retention

`CRITICAL_INVARIANTS.md` owns the durable privacy rule and [persistence and retention](../backend/PERSISTENCE_AND_RETENTION.md) owns the exact storage/retention mechanics. Run transparency never authorizes duplicated raw request logs or broader provider-payload retention.
