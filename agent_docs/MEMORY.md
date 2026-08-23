# MEMORY

Owner: Native Memory maintainers
Scope: Personal Memory semantics, evidence, privacy, retrieval, learning, lifecycle, and recovery.

## Product Contract

Personal Memory is AIQSA-owned PostgreSQL state with three user controls: the master Memory switch, Search past chats, and Learn automatically. Saved Memories remain directly manageable while Memory is paused; pausing a source stops new use and work without silently deleting retained data. Reset requires confirmation, fences future admission synchronously, and drains reusable Personal Memory through the durable deletion path.

Personal Memory v1 has three reusable inputs: explicit Saved Memories, conservative direct-user learned facts, and role-preserving personal past-chat chunks. Folder, Assistant, arbitrary user-facing scopes, generated profiles, patterns, conflict workflows, and Project Memory are outside this product. Existing Project Memory data may remain dormant, but Project runs create and receive no Personal or Project Memory bindings, context, sources, or jobs.

Temporary chats create no Personal Memory attempt, binding, item, source, receipt, counter change, or background work. Anonymous shares retain only their positive public snapshot and strip all Memory context, actions, references, sources, and lifecycle metadata.

## Actions, Evidence, And Safety

Natural-language Memory actions are decided by one bounded forced-strict System Model call over the exact current direct-user message. The answer model receives no Memory tools. Supported outcomes are `NONE`, `SAVE`, `UPDATE`, `FORGET`, `LIST`, `SEARCH`, and `RESET`; at most one further strict call may resolve an ambiguous owned target, and destructive reset still requires explicit confirmation. Mutation authority requires byte-for-byte evidence from the current user turn plus an exact current owned target where applicable. Assistant text, retrieved Memory, earlier turns, quotations, Search, Knowledge, MCP, tools, and attachments cannot authorize a mutation or become evidence for a user fact.

Semantic safety, durability, category, subject, correction, and target decisions belong to forced-strict System Model contracts. A separate format-aware parser rejects recognizable credential URLs, keys/tokens, JWTs, PEM material, recovery codes, payment-card numbers, and high-entropy secret shapes before persistence or provider egress; regexes, keyword lists, locale phrase maps, and numeric heuristics are not semantic authority. Storable personal facts follow the ordinary persistence and retrieval rules; there is no separate Sensitive product mode. `SECRET` and `UNCERTAIN` content is never retained or recalled.

Automatic learning gives each eligible direct-user message one generation-bound deterministic extraction job after its committed Normal turn. Preparation reloads that immutable target plus bounded context; later turns and chat revisions do not invalidate it, while source deletion, exclusion, pause intervals, suppression, Project boundaries, and generation changes still fail closed. One strict extraction may return zero to four independently validated observations, each with an exact target-user quote that the server re-locates and hashes. Assistant context may help resolve references but never becomes evidence. Only durable, future-useful, allowlisted, `HIGH`-confidence, storable, non-temporary, non-third-party observations proceed.

The automatic write path is append-only: a new proposition commits its fact, immutable version, exact evidence, and event atomically; an exact normalized duplicate attaches fresh evidence and reinforcement without creating a competing version; replay of the same source is idempotent. Explicit Saved Memory retains higher authority. Semantic persistence does not wait for embeddings: compatible indexing is queued independently and remains retryable after the fact commit.

Facts and versions remain immutable evidence records. Active v1 Personal facts are user-global; legacy non-global and Project records are not broadened or destructively migrated. Forget/edit/reset synchronously advances the applicable fences before deferred derivative cleanup, so queued jobs, rebuilds, stale vectors, or unchanged evidence cannot resurrect content.

## Retrieval And Run Admission

Each eligible Normal send/regeneration uses the run's two-phase boundary. Phase A accepts a private non-dispatchable run and one content-bounded retrieval attempt before optional Memory utility calls. A strict System Model plan decides independently whether facts, past chats, and response preferences are useful and supplies the bounded query text. Targeted dynamic Memory requires the plan, query embedding/index, configured candidate floors, and a forced-strict reranker over every candidate; lexical-only, vector-only, recent-only, or Core-only fallback is not allowed. For an explicit broad request for what Memory knows about the user, the same plan may instead authorize a bounded current-fact inventory: this lane excludes past-chat chunks, skips query embedding because there is no semantic subset to search for, and still requires the forced-strict reranker to accept every supplied current fact. Any missing or invalid required stage yields zero dynamic Memory items while the ordinary answer remains available.

The administrator owns one installation-wide admission timeout for future Personal Memory attempts. It defaults to 30 seconds and is bounded to 1–120 seconds; expiry cancels the remaining optional Memory work and continues the ordinary answer without Memory rather than failing the chat run.

Outside the bounded broad current-fact inventory, the only query-independent context is a small set of explicit, current, user-global response preferences. Dynamic facts, preferences, and history are packed under their per-class budgets and a 1,800-token hard cap. Every selected item is authoritatively rejoined under owner, current version, safety classification, generation, source projection, source revision, exclusion, suppression, and deletion fences before Phase B freezes the exact untrusted pack. Recovery reuses that frozen pack and never retrieves again.

Only exact committed run items may produce browser Memory sources. The source contract receives friendly text and short-lived opaque owner/run/version/operation-bound references, never Memory repository IDs, hashes, scores, provider details, policy versions, revisions, or reasoning. Correct, Forget, Not relevant, and Open source revalidate the current authoritative item before acting; forgotten, excluded, deleted, stale, or non-current evidence cannot be replayed. Successful Open source may then redirect to the app's ordinary authenticated chat route. Public-share projection removes the entire private surface.

## History, Lifecycle, And Operations

Past-chat chunks preserve canonical `User:` and `Assistant:` labels, message boundaries, exact source maps, timestamps, and versioned chunk/source projections. Assistant text may support past-chat recall but never automatic fact evidence. History must pass the same format-aware secret defense and forced-strict semantic safety classification before reusable persistence. Source reads are personal-only and exclude Temporary, Project, deleted, excluded, pre-cutoff, stale-branch, stale-revision, and incompatible-generation data.

Archive is organization only. Exclude immediately fences the retained chat from future recall and learning. Resume affects only messages created after its server-owned cutoff; it never schedules automatic historical backfill. Master/subordinate OFF periods and reset use durable generation, revision, cutoff, cancellation, and source barriers so delayed workers cannot commit old evidence.

One production Memory worker owns a complete declared job manifest, bounded leases, heartbeats, retry policy, and visible terminalization of unsupported legacy kinds. Startup verifies schema/write authority, registry completeness, key material, every actually admitted System/embedding credential envelope, and a rollback-only claim/heartbeat/commit transition without provider network I/O. Provider capability failures disable only the affected Memory stage; they do not prevent ordinary answers or unrelated deletion work.

Deletion duties are retryable and never terminally abandoned. Backup requires writer quiescence and every suppression key referenced by durable state; restore remains blocked until deletion, barrier, execution, and generation review is clean. [Persistence](PERSISTENCE.md) owns those mechanics, [Run contracts](RUN_CONTRACTS.md) owns answer admission, and [Security](SECURITY.md) owns secrets and egress trust.
