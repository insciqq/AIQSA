# NATIVE MEMORY

Owner: Native Memory contract maintainers
Scope: Approved product semantics, correctness fences, privacy boundaries, and target module ownership for AIQSA-native personal Memory.

## Implementation Status And Authority

Native Memory is approved. The current baseline includes the feature-dark
Phase 0 contract/evaluation harness, Phase 1 persistence and coordination, and
the complete explicit Saved Memories vertical slice of Phase 2. Phase 0 has strict decoders, pure
state/counter/safety validation, RU/EN parity, frozen provider-neutral scoring,
signed qualification decisions, and a hash-frozen synthetic tuning/holdout
corpus. Behavior-only benchmark-shaped probes contain no upstream benchmark
text and are not official benchmark scores.

Phase 1 persists default-off settings; dormant typed scopes; fact, version,
event, evidence, suppression, mutation, generation, job/deletion, execution,
retrieval-attempt, and final-run evidence. Database ownership, uniqueness,
current-pointer, active-generation, request/execution/vector shape, and account
deletion constraints are authoritative. Production repositories and the
feature-local coordinator fence claims, retries, slow-schedule blocked deletion
work, and apply. New-user/bootstrap/upgrade paths schedule no work. Non-global
scope activation remains database-blocked until Phase 3. Suppression HMAC keys
stay installation-only and are preflighted before restore or automatic work.

Every normal send and regeneration uses the two-phase run boundary. Phase A
commits the exact DAG, ordinary dependency evidence, private `PREPARING` run,
bounded base request, and local-only attempt. Eligible current explicit
`GLOBAL_USER` facts come from local exact/FTS and enter the shared budget as
clearly untrusted personal context with no utility consent. Phase B revalidates
the DAG, folder/Assistant, settings/generation/index, ordinary admission, and
each staged version/source/scope/safety snapshot before freezing the request,
preview, binding, and items. Drift gets at most one safe fresh attempt; stale
mutation authority fails. Ordinary retrieval may degrade without Memory, but
management fails actionably. Dispatch rejects `PREPARING`, and recovery reuses
only a finalized request.

All answer adapters place personal context after trusted instructions. Phase 2
withholds it from hosted Search, Knowledge, MCP/external tools, and non-owned
Assistants; finalization and provider dispatch enforce the same egress fence.
Each accepted run privately projects its exact frozen Memory outcome/items into
the originating answer and a passage-free Events digest. Later Forget or source
loss adds a lifecycle label without replacing admitted text. Save/Edit/Forget
feedback requires the exact same-run applied operation/tool receipt join;
ambiguous targets route to Manage Memories without mutation.

Authenticated `GET/PATCH /api/me/memory/settings` exposes bounded, `private,
no-store` settings/capability and current-versus-accepted utility policy. It
accepts one CAS patch or consent payload. The three gates and RU/EN locale are
independent; only memory-visible changes advance Memory revision. Embedding
selection requires current exact entitlement, and consent recomputes the
server-owned fingerprint inside the lock. Stale observations fail atomically;
the route schedules no work. Phase 2 advertises explicit Memory and qualified
RU local retrieval while history recall and automatic learning remain
unavailable; existing users remain default-off for Memory use.

Explicit `GLOBAL_USER` management is gate-independent. Short-lived grants bind
Save to an exact statement; Edit/Forget to owner fact/current version; and
`DELETE_EXPLICIT` to the operation plus settings/Memory revisions, confirmation
copy, and nonce. The serializable mutation consumes the grant; only an exact
receipt-matched retry can replay. Private list, POST-search, detail, evidence,
create, edit, pin, Forget, bulk-delete, and status routes rejoin ownership and
keep free text out of URLs. Writes synchronously update exact/RU/EN/simple FTS
without utility egress. Non-global scope and secret-like statements are
rejected; internal owner/canonical/authorization/suppression identities stay
private.

Deterministic direct-current-user intent may expose exactly one strict
first-party `save_memory`, `list_memories`, `update_memory`, or `forget_memory`
tool. Mutation schemas contain no authority token: PREPARING mints one hidden,
short-lived run/source-span authorization, update and Forget bind it to exactly
one current version, and execution claims it with the persisted tool call before
the existing mutation transaction consumes it. Successful Save/Edit/Forget
receipts retain the exact run/tool-call join. Quoted, embedded, Assistant,
retrieved, ambiguous, regenerated mutation, and provider-paraphrased authority
cannot mutate. A tool-capable management run must actually attempt its planned
first-party action before completing; a non-tool model may prefetch a read-only
list, including an authoritative itemless result that is invalidated by any
intervening Memory revision, but mutation intent returns the
confirmation-required error.

Forget atomically fences generation/revision, clears the current pointer,
forgets fact/version state, installs exact fact/value/source suppressions,
invalidates lexical data, records a plaintext-free event, and creates one
`FORGET_PURGE` obligation. `DELETE_EXPLICIT` fences its exact admitted set; a
later new Save is outside it. Versioned contributors scrub content, lexical/
vector rows, evidence, and unaccepted run context, settling affected
`PREPARING` runs content-free. Completion audits every contributor and startup/
status reconciliation reopens stale success with residual work. Suppression
blocks automatic recreation; fresh explicit authority may create a new version.

Explicit writes enqueue content-free `EMBED_ITEMS` only for an active HYBRID
generation; lexical-only rows stay `NOT_APPLICABLE`. The optional handler parks
before binding without consent, exact credential authority, or signed role
qualification. One admitted call has one job binding/usage event and applies
only to the exact current version, generation, content, configuration,
dimension, and vector space. Credential rotation alone creates no generation.
Visible READY/FAILED settlement advances revision once while FTS remains live;
unknown results are not replayed, and Forget/generation drift blocks late apply.

Past-chat/automatic/profile retrieval, answer-time reranking, split
Memory-plus-external-tool synthesis, other lifecycle/bulk variants, and
production-composed qualified utility calls remain unavailable. Development runs the
feature-local coordinator; production uses the same code in private no-API
`memory-worker`. Both preflight every historical suppression key ID, and Memory
failure does not alter web readiness. The default Phase 2 registry composes
`FORGET_PURGE` and optional `EMBED_ITEMS`; embedding parks before provider I/O
because the code-owned qualification registry is empty and signature
verification is fail-closed until operator-approved authority is installed.
Lexical CRUD and retrieval remain live. Per-call execution owns
current authority/consent/qualification, immutable destination evidence,
single-winner start, nullable usage, unknown-outcome recovery, and detach.
Private `preparing` runs never enter public projection or provider I/O.
Ordinary answers cannot create Memory. Existing chat context and folder/project
prompt memory are separate behavior.

Anonymous share creation and reads re-project through the positive public
text-only schema. Personal context, Memory attempts/executions/bindings/items,
events, operation/tool receipts, identifiers, sources, and lifecycle metadata
never enter the public snapshot or response; visible answer prose is preserved.

This document owns the durable target contract while implementation lands in
ordered slices. Executable code, migrations, and tests remain authoritative for
what is currently shipped; each slice must update this status and the bounded
current-behavior owner it crosses. A planned name below is semantic rather than
permission to expose a route, schema, or control before its dependencies exist.

Memory is native to the existing modular monolith. PostgreSQL is the durable
authority; pgvector, PostgreSQL full-text search, exact matching, temporal
filters, and reciprocal-rank fusion are retrieval tools below that authority.
No external memory service owns chat branches, accepted-run evidence, access,
deletion, retention, or truth.

Hindsight is absent from production. It may appear only behind a disabled,
development/evaluation adapter using synthetic or explicitly approved data,
with a pinned upstream version and recorded configuration. Production code
must not import it, and comparison results never define AIQSA truth. Behavior-
level reimplementation is preferred; copied code requires license and
attribution review.

Evaluation evidence binds the exact adapter/deployment/config/vector
fingerprints, corpus hash, suite/corpus/scorer and pipeline/policy/prompt/schema
versions, PostgreSQL/pgvector profile, and fixed random seed. Proportion metrics
use two-sided 95% Wilson intervals; ranked retrieval uses deterministic
stratified-bootstrap 95% intervals. Gates compare unrounded values, while
display values round to three decimals. Missing hard-invariant coverage fails,
and one deterministic privacy, lifecycle, run, or safety violation fails the
suite rather than being averaged away. Automatic-learning beta evidence is
incomplete until every frozen overall quality gate is independently present
and passing for RU and EN.

`MemoryCapabilityQualification` is fail-closed authority, not advisory
metadata. It matches the exact role, language, provider/model/deployment/config
and vector fingerprints, retrieval configuration, and material version/hash
set; approval must be signature-verified, already effective, and unexpired.
Missing, stale, ambiguous, unapproved, expired, or unverifiable qualification
cannot enable the affected role. A live evaluation has no ambient permission:
it requires an explicit operator authorization bound to the exact native
adapter and evaluation configuration, accepts only synthetic HOLDOUT fixtures,
and returns sanitized aggregates without fixture or provider bodies.

## Product Vocabulary And Independent Controls

The feature has four independently understandable layers:

- explicit Saved Memories, whose user action has highest authority;
- safe past-chat chunks and episodes used for history recall;
- automatically learned, evidence-backed semantic facts;
- a derived profile/working set that may summarize only supported current
  facts.

Three account gates are independent and default off for existing users:

| Gate | Reads | Writes | Turning it off |
| --- | --- | --- | --- |
| `useMemoryFacts` | Eligible explicit and previously learned facts | Nothing by itself | Stops future fact injection and retains data |
| `referenceChatHistory` | Eligible chunks and episodes | Incremental history index only | Stops history recall/index work and retains data |
| `learnAutomatically` | Source evidence needed by learning | Candidates and automatic facts | Stops learning work and retains data |

Explicit list, save, edit, and Forget remain available under every combination.
An explicit save while fact use is off commits synchronously and discloses that
it will not be used yet. History opt-in is either new-chat-only or an explicit
bounded backfill; no migration or toggle silently backfills an account.

Feature-owned UI copy has a persisted `RU | EN` account locale, initially RU.
Russian is an independent release gate for retrieval, extraction, temporal
reasoning, safety, lifecycle, visible and accessible copy; English success
cannot mask a Russian failure. Display text preserves the source language and
search copies may normalize NFKC, case, spacing, punctuation, and `ё`/`е`
equivalence without changing the displayed original.

These lifecycle actions are not aliases:

- Archive/Restore changes organization only. An archived retained chat stays a
  Memory source.
- Exclude removes a retained chat from future automatic recall/learning;
  Resume is an explicit controlled reindex and cannot cross prior suppression
  barriers.
- Temporary is chosen before first send, never reads or writes personal Memory,
  cannot convert to retained, cannot be shared, and enters complete-aggregate
  deletion on the fixed retention contract.
- Forget removes one reusable memory from future Memory use and prevents the
  unchanged evidence from recreating it. It does not rewrite retained chat text
  or old accepted runs.
- Hard-delete chat deletes the source aggregate and reconciles derivatives. It
  is a distinct future action from the currently archive-like chat `DELETE`.
- Expire closes reliable temporal validity; Retract removes automatic truth
  whose evidence is no longer admissible. Neither is user Forget.
- Clear history index removes rebuildable chunks/episodes/search rows while
  retaining chats and semantic facts.
- Delete all reusable memory removes reusable fact/history/profile data; it is
  not conversational erasure, retroactive provider erasure, or backup erasure.

## Trust, Evidence, And Scope

Raw AIQSA messages and explicit user actions are primary. Chunks, episodes,
candidates, facts, profiles, search entries, and temperature are derivatives.
Every derived assertion remains rebuildable or retractable and cannot outrank
its admissible evidence. Assistant, web, MCP, tool, Knowledge, and attachment
text do not establish a user fact by default. Secret-tainted source windows are
excluded before derivative persistence or external Memory I/O.

Memory is untrusted data. It cannot become system/developer instruction,
authorize an action, enable MCP, bypass confirmation, choose a provider or
credential, grant access, publish/share data, or initiate a side effect.
Explicit user correction outranks existing explicit memory, which outranks
direct recent evidence, independent direct evidence, and derived inference in
that order. Scope and time still constrain every authority level.

Semantic facts use exactly these scope kinds:

| Scope | Eligible run |
| --- | --- |
| `GLOBAL_USER` | Any relevant run owned by the user |
| `FOLDER` | A run in the exact current Folder/project |
| `ASSISTANT` | A run using the exact currently authorized Assistant |
| `CHAT` | The exact current chat |

`userId`, not scope, is the tenant boundary. Normal retrieval admits the
current user's global scope plus only the exact current Folder, Assistant, and
Chat scopes. Chunks and episodes stay tied to their source chat and may support
cross-chat recall after source-eligibility checks.

The extractor may propose a scope, but the server validates it and chooses the
narrowest safe scope or defers ambiguity; it never promotes ambiguity to
global. Target deletion retracts automatic scoped facts. Explicit scoped facts
become non-retrievable `ORPHANED` records until the user moves or forgets them.
Moving scope appends an explicit version under the target-scope logical fact
and retains lineage; it never rewrites an old fact's scope. Assistant
publication grants no personal-Memory access, and target labels/snapshots are
never authorization.

Every Memory parent has a same-owner identity and every expressible child edge
uses a composite `(userId, parentId)` foreign key. Retrieval filters by user
before ranking and authoritatively rejoins returned IDs. Admin role alone
grants no access to another user's Memory; operational UI is aggregate-only.

## Counters And Source Fences

Four counters have separate jobs:

- `Chat.memoryBranchGeneration` changes when the selected source path changes
  through edit, regeneration, branch checkout, or active-path deletion. It
  makes derivatives from the abandoned path ineligible.
- `Chat.memorySourceRevision` changes whenever eligible source content or
  source state changes. It fences background snapshot freshness without
  invalidating earlier valid derivatives after an ordinary append.
- `UserMemorySettings.memoryGeneration` changes for destructive, identity-
  changing, reset, or active-index-switch operations. Any mismatch rejects a
  prepared pack.
- `UserMemorySettings.memoryRevision` changes for every Memory-visible state,
  eligibility, content, ranking, projection, safety, suppression, or active-
  index change. Additive drift may omit new items from an admitted run only
  after every already-selected item is revalidated.

`settingsRevision` separately provides optimistic concurrency for every
settings mutation. Locale-only changes advance that settings revision but do
not change Memory visibility counters.

The authoritative mutation matrix is:

| Operation | Branch gen. | Source rev. | Memory gen. | Memory rev. | Exact authority check |
| --- | ---: | ---: | ---: | ---: | --- |
| Normal append / one semantic terminal settlement | – | + | – | after a derivative becomes visible | source revision and hash |
| First empty lexical-index bootstrap inside its owning visible mutation | – | – | – | no extra increment | settings lock and absent active pointer |
| Edit, regenerate, checkout, active-path delete | + | + | + | + | active leaf, branch, selected items |
| Explicit save or automatic add/reinforce | – | – | – | + | logical fact and current pointer |
| Explicit edit, pin, rescope, conflict resolution | – | – | – | + | selected version and scope |
| Automatic supersede, conflict, expiry, retraction | – | – | – | + | selected version and current pointer |
| Activate/invalidate chunk or episode and lexical row | – | – | – | + once | source, safety, hash |
| Active-generation vector settles READY/FAILED | – | – | – | + | item, generation, fingerprint |
| Replace profile projection | – | – | – | + | all contributing active versions |
| Forget, bulk clear, or source hard delete | as source requires | + for chat source | + | + | suppression, source, exact items |
| Source NORMAL to EXCLUDED | – | + | + | + | source mode and items |
| Explicit source Resume/reindex | – | + | – | + | cutoff barriers and source snapshot |
| Archive or Restore chat | – | – | – | – | organizational state only |
| Folder move / Assistant access or archive change | – | + for chat move | – | + | current target and access |
| Delete Folder, Assistant, or Chat scope target | – | + where source changes | + | + | target and affected items |
| Change read/learning/safety/egress setting | – | – | – | + | settings, fingerprints, selected items |
| Change only Memory UI locale | – | – | – | – | settings-revision compare-and-set |
| Shadow-row, catch-up, or physical-purge progress | – | – | – | – | job/outbox fence |
| Activate/reset an index generation | – | – | + | + | exact revision, config, barriers |

Shared transaction helpers own counter mutation. Background work snapshots the
exact revision and safe source-content hash and commits nothing when either is
stale. A global job is not invalidated merely by unrelated additive revision
drift; it rechecks its exact source/fact/version preconditions.

## Fact And Operational State

Candidate, logical-fact, and fact-version state are different authorities:

- candidate: `PENDING`, `DEFERRED`, `PROMOTED`, `REJECTED`, `STALE`;
- fact: `ACTIVE`, `CONFLICTED`, `ORPHANED`, `EXPIRED`, `RETRACTED`,
  `FORGOTTEN`;
- version: `ACTIVE`, `CONFLICTING`, `ORPHANED`, `SUPERSEDED`, `EXPIRED`,
  `RETRACTED`, `FORGOTTEN`.

An active fact has exactly one same-owner active current version. Conflicted,
orphaned, expired, retracted, and forgotten facts have no unqualified current
pointer. Corrections append versions and preserve system-time and valid-time
history. Conflict clears the pointer; explicit resolution appends a new
explicit version. Age alone never expires a stable preference. Source
invalidation retracts only unsupported automatic claims; remaining admissible
claims are normalized back to zero, one, or multiple incompatible truths.
Forget always wins over automatic proposals, and only a later explicit save
with an allowed suppression override may revive the same logical identity.

Durable operational transitions are closed and lease/idempotency fenced:

```text
RetrievalAttempt:
  PENDING -> EXECUTING -> READY -> CONSUMED
  PENDING | EXECUTING | READY -> STALE | FAILED | CANCELLED | EXPIRED

ExecutionBinding:
  PENDING -> RUNNING -> SUCCEEDED | FAILED | CANCELLED | OUTCOME_UNKNOWN
  PENDING -> FAILED | CANCELLED before network I/O
  OUTCOME_UNKNOWN -> SUCCEEDED | FAILED | CANCELLED by bounded recovery only

IndexGeneration:
  first empty LEXICAL_ONLY -> ACTIVE
  BUILDING -> CATCHING_UP -> READY -> ACTIVE -> SUPERSEDED
  BUILDING | CATCHING_UP | READY -> FAILED | CANCELLED

DeletionOutbox:
  PENDING -> RUNNING -> SUCCEEDED
  RUNNING -> RETRY_WAIT -> RUNNING
  RUNNING | RETRY_WAIT -> BLOCKED_REQUIRES_ADMIN -> RUNNING

MemoryJob:
  QUEUED -> CLAIMED -> SUCCEEDED | RETRYABLE_FAILED | TERMINAL_FAILED | STALE | CANCELLED
  RETRYABLE_FAILED -> QUEUED
  QUEUED | pre-call CLAIMED -> WAITING_FOR_EGRESS_CONSENT -> QUEUED
```

Only non-deletion work may become terminally failed. A deletion obligation may
be visibly blocked and retried slowly, but it is never abandoned. A WAITING job
holds no live lease and cannot select a fallback destination. An uncertain
external outcome is never replayed blindly.

Every external Memory operation first commits one owner-bound `PENDING`
execution row, then wins one `PENDING -> RUNNING` transition after re-resolving
the accepted aggregate egress fingerprint, exact credential version, provider
configuration, role capability, and signed unexpired qualification. A second
starter receives no execution authority. Settlement creates exactly one
independent `UsageEvent`; unreported token categories and ambiguous cost remain
null, and the row is never linked into answer-run replacement accounting.
Provider-specific recovery may monotonically enrich an `OUTCOME_UNKNOWN` row
without another call. Only honestly terminal, usage-backed rows detach their
live provider/model/credential relations after the 24-hour recovery horizon;
provider deletion reports every remaining live or recoverable Memory binding as
an explicit blocker. Authoritative result application must run through the
same locked current-policy recheck, so an in-flight result cannot cross a
changed consent fence.

## Two-Phase Run Boundary

Memory retrieval that might perform external utility I/O extends ordinary run
admission with two durable phases:

1. Phase A atomically accepts the user/assistant message graph, a `PREPARING`
   run, ordinary dependency bindings, and one retrieval attempt before any
   external Memory query embedding or reranker call.
2. Every external Memory call receives its own accepted execution binding
   before network I/O and retains exact provider/model/credential, role,
   prompt/schema, input/output hash, outcome, and usage evidence.
3. Retrieval produces bounded staging items. It cannot dispatch an answer.
4. Phase B locks the run and chat, rechecks ordinary admission plus settings,
   active leaf, chat mode, all four relevant generation/revision snapshots,
   accepted/current egress policy, source and scope targets, safety,
   suppression, and every selected exact item/version.
5. Phase B freezes the final normalized provider request, provider preview,
   exact personal-context text, private run binding/items, and transitions out
   of `PREPARING` to a dispatchable admitted state.
6. Only the committed finalized request may reach the answer provider. Recovery
   of a finalized run replays that frozen request and never performs fresh
   retrieval.

Temporary runs take the zero-read/zero-write path. Whole-retrieval failure
normally degrades an ordinary answer to no personal context with an honest
receipt; a Memory-management request cannot degrade into an invented success.
Old bindings and included item text are immutable and may later show lifecycle
labels such as `Later forgotten` or `Source deleted` without rebuilding the
old context from current Memory.

## External Egress And Tool Separation

Logical utility roles are provider-neutral. Resolution uses current AIQSA
provider/credential admission, records the accepted destination, and never
silently substitutes a provider, model, credential, embedding space, or
reranker. Explicit CRUD/Forget and local exact/FTS operation do not depend on a
utility model or embedding credential.

User consent binds a non-secret fingerprint of the effective system-memory,
embedding, and remote-reranker destinations and policy version. A material
provider, endpoint, deployment, account/destination, or policy change pauses
affected calls in `WAITING_FOR_EGRESS_CONSENT`; already-sent evidence remains
honest but cannot commit across the changed fence. The answer model is governed
by ordinary per-run admission and is not silently folded into this static
fingerprint. Settings reads disclose only bounded connection/model labels and
the non-secret current/accepted fingerprints. Accepting policy never trusts the
browser's echoed hash: the commit transaction resolves current provider,
credential-destination, deployment, endpoint/configuration, role, and policy
authority again and exact-compares it before recording consent.

Initial server-owned tool planning is memory-blind at the wire boundary: direct
current-user text and, when necessary, bounded prior direct-user text only. It
contains no personal context, Memory receipt/profile text, assistant message,
or tool/Search/Knowledge result. A value known only from Memory requires exact
user confirmation and destination disclosure so it becomes direct current-
turn input. `SECRET` and `HIGHLY_SENSITIVE` values never take that path.
Authorization and revocation are checked immediately before dispatch.

When a response needs both external server-owned tools and personal Memory,
tool execution completes from the memory-blind request first. A separate
answer synthesis request may then receive frozen safe tool results and
personal context, but exposes no tool capability and cannot re-enter a tool
loop. Each request and call has its own immutable receipt.

Provider-hosted Search and `personalContext` are mutually exclusive in one
provider request because AIQSA cannot fence a provider-internal search subcall.
A run records either a Memory-bearing mode with hosted Search disabled or a
hosted-Search mode with personal context omitted and prior Memory-bearing
assistant turns excluded. Confirmed eligible current-turn values may enter a
memoryless hosted-Search request; any later Memory synthesis is another
no-search request.

## Retrieval And Index Integrity

Lexical-only is a complete supported mode. Every authoritative visible item
gets synchronous Russian, English, and simple FTS projections in the active
generation; optional compatible vectors enrich them asynchronously. Search
entries are rebuildable and never become truth.

An immutable generation pins index mode, source/target revisions, language,
normalization, chunking, pipeline, and, for hybrid mode, the exact embedding
deployment/configuration, dimension, and vector-space fingerprint. An
incompatible change builds and catches up a shadow generation while the old
active generation serves. Activation requires an unchanged full eligible-set
proof, exact current configuration and barriers, then atomically flips the
pointer and advances generation/revision fences. Partial generations never
serve and vector spaces never mix.

Vector retrieval uses direct, dimension-specific cosine HNSW scans whose SQL
contains user, active generation, vector readiness, authoritative state,
scope/source/safety, and same-owner joins before final ranking. It does not put
a materialized CTE ahead of the ANN scan or trust candidates before the exact
authoritative rejoin. Initial plan constants are:

```text
EXACT_VECTOR_MAX_ELIGIBLE_ROWS = 5000
HNSW_EF_SEARCH = 100
HNSW_MAX_SCAN_TUPLES = 20000
HNSW_OVERFETCH_MULTIPLIER = 8
HNSW_MAX_CANDIDATES_PER_LANE = 200
```

At or below the threshold, retrieval uses a bounded exact tenant/generation
cosine scan. Above it, iterative strict-order HNSW requests at most
`min(k * 8, 200)` candidates and applies the same authoritative rejoin. If ANN
under-fills while an exact eligible count proves enough rows exist, a bounded
exact scan fills the lane; it never broadens tenant, generation, dimension, or
relevance policy. Changing pgvector version, index expression, dimension, or
query shape requires fresh plan and recall qualification with adversarial
closer cross-tenant vectors and production-shaped `EXPLAIN` evidence.

## Lifecycle And Deletion Truth

Every destructive response first commits a synchronous eligibility fence; a
durable outbox then scrubs derivatives idempotently. Forget consumes exact
current-user mutation authority, locks the fact/version, clears retrievability,
advances generation and revision, writes a content-free event, installs keyed
suppression/source barriers, removes active search eligibility, and enqueues
purge in the same transaction. Subsequent runs cannot observe the item even if
physical cleanup is pending.

Bulk clear additionally records an account source-created-at cutoff so old
evidence cannot return through rebuild. Re-enable/Resume cannot cross that
barrier; only a disclosed explicit new save/correction may use an allowed
override. Physical cleanup may retain only bounded operation metadata,
timestamps, actor, IDs needed for reconciliation, non-reversible keyed hashes,
generation, and purge status—never forgotten plaintext.

The source/retention outcomes are:

| Action | Future Memory | Source and derivatives | Historical destinations, shares, external retention |
| --- | --- | --- | --- |
| Save/edit explicit | New lexical current version; stale selected versions fail Phase B | Source action remains; vector/profile may follow | Earlier runs and snapshots unchanged; new egress needs accepted policy |
| Forget one / delete explicit set | Exact versions and unchanged source evidence fenced | Retained chats remain; durable purge and suppression reconcile all affected derivatives | Old destination request/receipt remains immutable and labeled; share prose is not rewritten; provider/backups keep their own retention |
| Delete learned set | Automatic facts fenced with observed-source barrier | Chats remain; automatic facts/candidates purge | Old destination evidence/prose remains |
| Clear history index | Chunks/episodes immediately ineligible with source barrier | Chats and semantic facts remain; rebuildable rows purge | Old destination evidence/prose remains |
| Delete all reusable Memory | All reusable gates fenced with account cutoffs | Raw retained chats remain; reusable tables/indexes purge | Destination runs remain under their owners; no retroactive provider or backup erasure |
| Turn a gate off | That future read/write stops | Data remains; queued work waits or cancels | Existing evidence/shares unchanged; no new affected egress |
| Archive/Restore chat | No Memory change | Chat remains eligible | No change |
| Exclude/Resume source | Exclude fences immediately; Resume obeys barriers | Chat remains; derivatives reconcile or controlled active branch reindexes | Earlier destination evidence/prose remains; resumed egress needs consent |
| Branch change | Old selected path fenced | Full DAG remains; active path reconciles | Historical runs/shares and already-sent data remain |
| Delete scope target | Target scope unavailable | Automatic facts retract; explicit facts become orphaned | Old destination evidence/prose remains |
| Hard-delete source chat | Source and run graph fenced | Source aggregate deletes, source shares revoke, derivatives reconcile; explicit facts survive by default and CHAT scope orphans | Cross-chat accepted items/prose remain; provider/backups unchanged |
| Delete destination chat/run | No change to source memory | Destination-owned request/attempt/binding becomes deletable; its shares revoke | That destination evidence is removed; already-sent provider/backups unchanged |
| Revoke public share | No Memory change | Share bearer/snapshot becomes inaccessible under share retention | Private run remains; backups may contain old snapshot |
| Temporary expiry | No reusable data ever existed | Entire messages/runs/files/object bytes/drafts/tool/Search/MCP/evidence aggregate purges durably | No AIQSA receipt/share remains; disclosed external retention and backups are separate |
| Account deletion | Immediate account-wide Memory fence | Memory hook cancels work and purges reusable/private data within global owner workflow | Account shares revoke; provider and operator-backup limits remain disclosed |
| Restore old backup | Restored snapshot is quarantined from production | External deletion journal, suppression keys, outbox, barriers, and audit reconcile before promotion | Bearer endpoints remain disabled until review; product never promises operator-backup erasure |

Temporary deletion is due 24 hours after the last terminal run, or after
creation/last local activity when no run settles. Recovery must settle a stuck
run rather than let it postpone deletion indefinitely. The deadline covers all
owned content and object bytes; overdue work is visible as
`BLOCKED_REQUIRES_ADMIN` and remains retryable.

Public anonymous snapshots keep visible assistant prose but strip personal
context, Memory settings/IDs/scores/sources, attempts and execution bindings,
run bindings/items/receipts, Memory events, and Memory tool results. Ordinary
logs and metrics contain only bounded identifiers, stage, duration, counts,
usage, pipeline/model version, and stable codes—never memory text, source
excerpts, tool queries/results, embeddings, raw provider bodies, or secrets.

## Runtime, Backup, And Recovery

The coordinator uses the same code/image and shared PostgreSQL schema in both
supported shapes. Development starts it process-locally from
`instrumentation.ts`; the persistent Compose topology runs `memory-worker` as a
private standalone process for isolation. This is not a microservice, exposes
no port or API, and is not a web readiness dependency. Database-owned jobs use
skip-locked claims, leases, heartbeat, bounded retry, and idempotency. Invalid
key configuration, a missing historical key, database preflight failure, or
coordinator construction failure prevents claims and remains feature-local;
durable job/deletion status stays inspectable.

No asynchronous embedding, indexing, Temporary promise, or purge promise may
ship before the job ledger, the single deletion outbox, lease recovery, and
reconciliation paths that make it durable. Provider/credential removal must
honor accepted execution evidence and outstanding obligations.

The supported backup helper records and stops both `app` and `memory-worker`,
verifies both are quiescent, and atomically releases their claimed Memory jobs
and deletion obligations to due retry states before database/object copying.
Cleanup restarts exactly the roles that were previously running. Format-2
bundles retain only sorted distinct non-secret `fingerprintKeyVersion` IDs;
the dedicated keyring is recovered independently from protected secret storage
and is never copied into PostgreSQL, object archives, manifests, or checksums.
The conditional fence also permits a pre-migration backup of a database that
does not yet contain Memory tables, and format-1 bundles remain verifiable.

Restore is accepted only into an isolated empty review target with public
bearer endpoints and both writers disabled. It preflights manifest IDs before
mutation, verifies restored authoritative IDs and preflights again before
handoff. Missing keys fail closed and prohibit automatic-memory resume,
rebuild, or redream. Before production promotion the operator must still
reapply an external post-backup deletion journal when present, reconcile the
deletion outbox plus account/source barriers, and audit for resurrection.

## Bounded Ownership Map

- This document owns Memory terminology, truth/authority, gates, scopes,
  counters, state transitions, retrieval safety, egress separation, lifecycle,
  and feature-level deletion meaning.
- [Architecture](../ARCHITECTURE.md) owns the current supported process and
  deployment shape. It changes when the coordinator role actually ships.
- [Persistence and retention](PERSISTENCE_AND_RETENTION.md) owns implemented
  table constraints, migrations, physical retention, prune/account deletion,
  and backup mechanics. Planned names here are not a schema inventory.
- [API and auth](API_AND_AUTH.md) owns implemented route families,
  authentication, mutation admission, no-store behavior, and observable HTTP
  transitions.
- [Core run pipeline](../run_pipeline/CORE_PIPELINE.md) and [runs and
  streaming](RUNS_AND_STREAMING.md) own implemented run/message admission,
  dispatch, recovery, settlement, context, and streaming behavior. Memory owns
  only its proposed two-phase extension until those seams are executable.
- [Evidence, sharing, and retention](../run_pipeline/EVIDENCE_SHARING_AND_RETENTION.md)
  owns implemented run inspection and share projection. Memory owns the
  additional private-artifact stripping requirement until it ships there.
- [Provider adapters](PROVIDER_ADAPTERS.md) own provider transport, credential
  resolution, usage normalization, and supported capabilities; Memory owns
  role qualification and no-fallback semantics.
- [Frontend](../FRONTEND.md) routes current shell, Settings, receipts, Details,
  responsive access, and localization behavior. Memory UI must extend those
  owners rather than create a parallel app or new Details tab.
- [Security](../SECURITY.md) owns implemented auth, secret, logging, network,
  and private-data enforcement. Memory adds no exception.
- [Testing](../TESTING.md) owns lane selection and disposable-environment
  safety. Memory requires focused domain fixtures, migration/Prisma proofs,
  phase gates, RU/EN holdouts, adversarial tenancy/egress tests, and bounded
  provider qualification only in the phase that exposes the capability.

The approved phase order is contracts/evaluation, feature-dark durable
substrate, explicit Saved Memories, chat/Temporary/scoped lifecycle, safe
history index, automatic recall, automatic learning, global reconciliation,
then hard-delete and operational GA. A surface cannot ship ahead of the
durable job, deletion, consent, retention, and recovery foundation it promises.
