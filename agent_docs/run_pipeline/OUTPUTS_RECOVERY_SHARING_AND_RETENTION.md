# RUN PIPELINE — OUTPUTS, RECOVERY, SHARING, AND RETENTION

Owner: Run pipeline maintainers
Scope: User-visible run outputs, operational recovery records, provider strategy, anonymous sharing, logging, and retention semantics.
Read when: Changing answer outputs, run-outcome reads, recovery checkpoints, provider strategy, share snapshots, logs, or run-data retention.
Code owners: Run outcome serializers, recovery/checkpoint owners, sharing handlers, usage/accounting projections, and retention integration.
Not owned here: Core dispatch/tool-loop stages, Search route planning, frontend composition, or provider wire mapping.

## User-Visible Output Contract

A model run may produce the following authenticated user-visible outputs:

- the final or partial assistant answer and its terminal state;
- inline citations and a bounded safe Sources projection when sources exist;
- generated files or other explicitly supported output artifacts;
- optional provider-supplied Reasoning when the selected presentation setting permits it;
- concise live progress and actionable Stop, Retry, Refresh, or recovery state;
- concise confirmations for an explicitly approved MCP side effect or committed Memory mutation.

The ordinary product does not expose a post-hoc run inspector. The client contract does not include normalized requests, provider request/response previews, accepted-parameter receipts, internal event timelines, Search attempt traces, generated queries, provider operations, Knowledge scores/thresholds/candidate facts, private Memory retrieval records, post-hoc tool arguments/results, or per-answer usage receipts.

Branches are conversation history and are served by the compact branch projection, not by a run-inspection model.

## Operational Run Records

Durable internal data is allowed only for a demonstrated operational purpose:

- admission and immutable accepted bindings;
- foreground/background continuation and outcome reconciliation;
- deterministic recovery after process or transport loss;
- prevention of repeated crash-ambiguous external side effects;
- provider-native background handles and bounded checkpoints;
- citation and generated-output reconstruction;
- security, retention, and deletion obligations;
- provider-reported usage and aggregate accounting.

Internal persistence is not automatically a browser contract. Repository methods may return broad internal objects to server callers, but route handlers must serialize an explicit allowlisted client DTO. TypeScript structural compatibility such as `satisfies` does not remove extra properties at runtime and must never be relied on as a privacy boundary.

Authenticated run reads serve only the operational outcome needed by the current client workflow. They remain owner-private and `no-store`, reconcile stale/background state according to the run lifecycle contract, and omit every field that is not required for terminal message reconciliation, citations/output delivery, actionable error state, cancellation, or bounded resume polling.

Recovery checkpoints and user-visible answer projections are separate concepts. Before deleting a persisted field or table, prove whether foreground/background continuation, tool-loop replay, Knowledge rehydration, citation reconstruction, or accounting still consumes it. Remove presentation-only projectors first; narrow or replace recovery snapshots before schema deletion.

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
- provider-neutral run-tool contracts for web search, with native or explicitly declared compatible OpenAI Responses, Gemini Interactions, and OpenRouter Chat Completions bridge boundaries.

Custom image-generation declarations remain future configuration data and do not create a runnable image-generation capability. Adapter defaults and cache/wire behavior are routed by `BACKEND.md`; externally verified constraints are routed by `PROVIDER_API_NOTES.md`.

## Sharing

`Share (anonymously)` creates a sanitized immutable snapshot of the active visible branch. It must not expose raw provider payloads, private attachments, API keys, internal run ids, private folder metadata, auth data, structured Knowledge data, Memory personal context, internal recovery/checkpoint records, tool arguments/results, or lifecycle metadata. Creation and every anonymous read both apply the same positive public schema: only approved user/assistant text blocks, safe public citations when the existing share contract permits them, and the public title/version survive. Unknown fields are dropped.

Knowledge- or Memory-bearing branches remain shareable because private retrieval/context data is omitted. A branch containing hosted-answer Gemini grounded live-only provenance is rejected rather than publishing its placeholder or reconstructing content. The public snapshot does not mutate when the private chat changes.

Publishing requires explicit confirmation. The Share action opens a dialog that explains the sanitized-snapshot semantics, and a link exists only after the confirming create action. Each linked snapshot records its source chat, and the chat's live links remain listed in that dialog with per-link revocation. Detached snapshots are not listed and can be revoked only by their original id.

## Logging And Retention

`CRITICAL_INVARIANTS.md` owns the durable privacy rule and [persistence and retention](../backend/PERSISTENCE_AND_RETENTION.md) owns exact storage mechanics.

Removing the inspector does not authorize moving its payloads into debug logs. Ordinary application logs remain structured and content-free. When a real diagnostic need exists, log only reviewed fields such as event name, correlation/run id, stage, adapter family, status, duration, attempt count, HTTP status, stable error code, and bounded counts/limits. Do not log prompts, answers, generated Search queries, tool arguments/results, Memory text, attachment names, custom endpoints, credentials, or raw provider payloads.

Retention must be purpose-based. Stop writing data that has no remaining execution, recovery, side-effect-safety, security, deletion, citation/output, or aggregate-accounting consumer. Remove unused rows and columns from the schema and migration contract after recovery tests prove they are no longer needed.
