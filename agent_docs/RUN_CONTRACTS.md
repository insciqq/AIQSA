# RUN CONTRACTS

Owner: Run pipeline maintainers
Scope: Provider-neutral admission, context, tools, Search/Knowledge, streaming, recovery, output, usage, sharing, and retention.

## Meaning And Admission

A run starts from one user message on a message-DAG branch, may use Memory, Knowledge, Search, and MCP, and produces a visible answer plus safe citations or generated outputs. Search is optional; internal execution evidence is not the product. Provider/model, Assistant, Search/Knowledge plans, tools, attachments, and controls come from the current server-filtered catalog and are revalidated before acceptance.

Ordinary runs receive the server-rendered standard-chat baseline and visible-answer developer rule. Assistant runs resolve one currently authorized immutable revision and reject client-expanded controls. Assistants grant no dependency entitlement and unavailable governed dependencies fail closed. Accepted requests freeze exact non-secret configuration and dependency bindings; later edits affect future messages only.

The server, never the browser, builds ordered context from the active ancestor path. Siblings are excluded. Empty terminal-error pairs are omitted from later provider replay so retry does not duplicate an unanswered question; accepted partial-answer questions remain. Attachment-only turns use neutral private-data-free markers in replay. Project memory, personal Memory, prompts, attachments, tool transcripts, and current content all count toward one model-specific budget; prior turns are dropped whole, while an irreducible current request fails before run creation.

The first text send in a blank chat derives its bounded title locally inside the run-creation transaction, compare-and-set against only placeholder titles. It never calls a provider or creates usage; attachment-only input keeps the placeholder. Shares copy the already-persisted sanitized title.

Admission has two commits when Memory may perform utility I/O. Phase A accepts the exact message graph, ordinary bindings, private `preparing` run, bounded base request, and retrieval attempt. Phase B revalidates mutable authority and selected evidence, creates immutable Memory bindings/items, freezes the minimum recovery checkpoint, and makes the run dispatchable. No answer provider or tool I/O occurs while `preparing`.

## Search, Knowledge, And MCP

Search is an explicit ordered logical plan. Off, organization inheritance, personal preference, and concrete selected sources remain distinct. Admission assigns one complete deterministic set of exact hosted/query-only routes; it never drops a source or substitutes another connection/model/key. Hosted and client Search remain different disclosure/retention boundaries.

Client Search receives one normalized bounded generated query and server-owned controls, never transcript, prompts, attachments, or original file data. Fan-out merges safe normalized findings deterministically, preserves attributable partial failures, and calls no fallback. Search provider text is only a bounded tool result; Sources/citations are revalidated safe projections.

Attachments do not disable or narrow a selected Search plan. The query-only request shape, rather than a disclosure-consent gate, prevents attachment identity, names, bytes, and extracted text from reaching client Search.

Knowledge plans bind exact bases, content revisions, active vector generations, embedding destinations, and authority at admission. Tool-capable models may call bounded retrieval over that frozen set. Each invocation persists a private replay-safe checkpoint before ambiguous work and returns only opaque handles, pages, bounded passage text, and safe citations. Settled retrieval replays without a new query embedding; crash-ambiguous retrieval is not repeated.

MCP extends the same tool loop. Ordinary tool-capable runs receive the complete effective enabled/entitled/ready inventory; Assistant runs first restrict it to their exact allowlist. No enabled-but-unready dependency is silently omitted. Administrator policy is validated over the complete sanitized inventory and active revisions affect future admission only.

Requested tool batches are durably recorded before bounded execution and results return in provider order. Settled calls replay; crash-ambiguous external side effects do not. Every round re-applies the context and output safety budgets. A model without tool capability explicitly runs with none rather than mutating persistent tool settings.

## Streaming, Recovery, And Settlement

Normalized SSE publishes live lifecycle, answer deltas, safe sources/artifacts, actionable warnings/errors, usage, and terminal completion. Presentation-only synchronization stays transient. Text may stream per token, while durable partial text/checkpoints are batched. The visible assistant message contains the answer, not request previews, Search traces, provider parameters, tool arguments, internal errors, event timelines, or usage receipts.

Only provider-specific terminal proof permits completion. Truncation, malformed or over-budget streams, timeout, cancellation, safety overflow, and provider failure keep accepted partial text and reported usage where available but never write a contradictory success. Terminal persistence and the status-gated winner occur transactionally; one writer wins completion/cancel/failure.

Recovery uses purpose-bound checkpoints, exact accepted context/bindings, settled tool results, and provider-native handles. It never reconstructs private truth from browser data or provider prose, repeats an ambiguous side effect, or converts a terminal safety/timeout outcome to success. Boot and route-triggered stale reconciliation use guarded age/status boundaries and cannot sweep a newer live run.

Cancellation stops later rounds and durable stream writes promptly. Provider timeout remains distinct from user cancellation. Public and client errors expose stable codes, concise actionable copy, and bounded counters only—never payloads, endpoints, credentials, reasoning, tool arguments, private retrieval text, or storage facts.

## Outputs, Usage, And Retention

Completed UI exposes answer text, safe inline citations and Sources when present, generated outputs, ordinary message actions, Branches, and explicit feedback for approved mutations. Live UI exposes factual progress, Stop, recovery, Retry, and actionable failure. Reasoning may be shown only through its reviewed normalized output; internal traces are not inferred or reconstructed.

Usage derives only from provider-reported categories. Answer rounds, client Search, Knowledge embeddings, and Memory utilities retain their own exact provider/model attribution and then contribute to aggregate accounting where applicable. Missing failed-call usage and price are null, never estimated; cached/reasoning tokens are not inferred. Recovery replaces or monotonically enriches the same outcome instead of double counting.

Anonymous sharing snapshots the active visible branch through the positive sanitized schema in [Backend](BACKEND.md). A grounded Gemini live-only branch is not shareable because durable content does not exist. Branch checkout is history navigation, not a run-inspection surface.

Persist only what execution, recovery, side-effect safety, security, deletion/retention, citations/outputs, or aggregate accounting consumes. Logs remain structured and content-free. [Providers](PROVIDERS.md) owns wire terminals, [Memory](MEMORY.md) personal context, and [Persistence](PERSISTENCE.md) durable mechanics.
