# NATIVE MEMORY

Owner: Native Memory contract maintainers
Scope: Approved product semantics, correctness fences, privacy boundaries, and target module ownership for AIQSA-native personal Memory.

## Implementation Status And Authority

Native Memory ships as three cooperating retrieval tiers over the existing
PostgreSQL authority:

1. a bounded Core projection of eligible current facts, present on every
   non-Temporary run while Saved Memories are enabled;
2. automatic bounded hybrid prefetch for every eligible non-empty USER turn;
3. one model-callable, read-only `search_memory` tool for a second pass.

Core uses pinned and explicit/user-corrected facts plus automatic facts carrying
the extractor's discrete `coreEligible` and `coreSalience` fields. Ordering is
authority, salience, recency, and stable identity. It does not use query text,
provider I/O, profile summaries, category rules, confidence decimals, or
temperature scores. Its code-owned limits are 12 facts and 512 approximate
tokens; the complete personal-context pack is capped at 12 items and 2,500
approximate tokens.

Every eligible non-empty query reaches candidate generation. Exact whole-query,
Unicode-simple FTS, compatible pgvector, and authoritative-recency lanes run
under the same owner/scope/source/suppression fences. Candidate lanes have
bounded limits and no semantic cutoff. Reciprocal-rank fusion produces a small
candidate set; one strict structured relevance call returns ordered relevant
IDs or abstains. If that call is unavailable, dynamic automatic injection stays
empty and records degradation. Core remains available, local candidates remain
available to an explicit `search_memory` call, and the ordinary answer continues.

`search_memory` covers current facts, grounded EVENT facts, and eligible history
chunks. Its typed input accepts a natural-language query and optional exact
source-kind, owner-validated scope, and absolute time filters. It is available
whenever the corresponding Memory gates are enabled, has no language or intent
router, is limited to two calls per answer run, and owns a private replay-safe
receipt bound to the exact persisted tool call. Extractive legacy `EPISODE` rows
remain decodable only for historical evidence and are never newly enqueued,
indexed, retrieved, packed, or returned by the tool.

The answer model receives all five typed Memory action tools—`save_memory`,
`list_memories`, `update_memory`, `forget_memory`, and
`mark_memory_incorrect`—on eligible tool-capable normal runs. There is no
natural-language regex router. Mutation authority is minted and claimed at
tool execution from the exact current USER message plus the exact owned target,
current version, and scope. Retrieved, Assistant, tool, Knowledge, quoted, or
earlier-turn text cannot grant authority. Direct Manage Memories APIs remain the
fallback for models without tool calling. Unambiguous mutations apply
immediately and expose compact Edit/Undo feedback; genuine ambiguity asks one
clarifying question, and bulk irreversible deletion retains confirmation.

Automatic learning defaults on, independently of Saved Memories and history
reference. Extraction emits one strict `STORE | ABSTAIN` decision containing a
normalized fact, exact supporting message spans, structured modality/scope/time,
optional valid BCP-47 or `und` language metadata, sensitivity, and discrete Core
fields. The server validates shape, ownership, spans, enums, bounds, and safe
scope; it does not reinterpret natural language with regexes, dictionaries,
substring equality, or numeric confidence/importance gates. Deterministic DLP
is limited to recognizable formats such as private-key envelopes, JWT/provider
token shapes, credential URLs, Luhn-valid card candidates, and high-entropy
values.

Consolidation receives a bounded same-scope semantic neighborhood and emits one
strict `ADD | REINFORCE | SUPERSEDE | CONFLICT | EXPIRE | NOOP` decision with
exact targets. The server enforces evidence, ownership/currentness, temporal
ordering, suppression, and explicit-over-automatic authority. New logical facts
receive an opaque server-owned `canonicalKey`; target operations retain the
target key. Keys and exact hashes are compatibility/deduplication identifiers,
not semantic identity. The old category-word verifier, Global Dream semantic
reconciliation, profile generation, and temperature working set are absent from
the normal path. Historical jobs for retired kinds settle deterministically
without provider I/O or new semantic data.

Runtime admission validates actual compatibility and authority only: provider
entitlement, protocol and strict-tool support, configured credential, embedding
dimension/vector-space identity, accepted administrator destination, and
bounded execution. Signed quality registries, per-installation benchmark
qualification, corpus signatures, and language allowlists are not runtime
authority. Offline evaluation may still document tested or recommended model
combinations without blocking a compatible administrator-selected model.

Every normal send and regeneration retains the two-phase run boundary. Phase A
commits the exact DAG, ordinary dependency evidence, private `PREPARING` run,
bounded base request, and retrieval attempt before external Memory I/O. Phase B
rechecks the DAG, settings and generation, active source, scopes, safety,
suppression, accepted destination, and every exact Core/dynamic item before
freezing the untrusted pack, request, binding, and items. Recovery uses only that
frozen request. Drift receives one safe retry; retrieval degradation never
becomes an invented Memory success.

All adapters place labelled personal context after trusted instructions. Memory
may coexist with Search, Knowledge, and administrator-connected tools, but it is
data and cannot authorize an action, enable a tool, or select credentials.
Temporary chats perform no personal-Memory reads or writes. Anonymous shares
strip Memory context, attempts, bindings, items, receipts, identifiers, sources,
and lifecycle metadata while preserving visible assistant prose.

Explicit Memory supports owned `GLOBAL_USER`, `FOLDER`, `ASSISTANT`, and
non-Temporary `CHAT` scopes. Assistant archive pauses its scope; target deletion
retracts automatic current versions and orphans explicit ones for Move or
Forget. Permanent chat deletion separately fences the source, revokes shares,
and completes durable aggregate cleanup. Forget synchronously fences the item
and suppression before its Undo-window purge; unchanged evidence cannot
resurrect it.

PostgreSQL remains the durable truth and coordination boundary. Lexical rows are
synchronous; compatible vectors are asynchronous and vector spaces never mix.
Every external Memory call has an immutable accepted execution binding and one
usage outcome. Administrator-owned egress acceptance is the default; changed
destinations pause only affected work until renewed. Hindsight and other public
memory engines remain design/evaluation references, never runtime dependencies.

## Product Vocabulary And Independent Controls

The feature has three user-understandable sources:

- explicit Saved Memories, whose user action has highest authority;
- safe past-chat chunks used for history recall;
- automatically learned, evidence-backed semantic facts, including grounded
  EVENT facts.

The gates are independent and default on for new owners:

| Gate | Reads | Writes | Turning it off |
| --- | --- | --- | --- |
| `useMemoryFacts` | Eligible explicit and previously learned facts | Nothing by itself | Stops future fact injection and retains data |
| `referenceChatHistory` | Eligible chunks | Incremental history index only | Stops history recall/index work and retains data |
| `learnAutomatically` | Source evidence needed by learning | Candidates and automatic facts | Stops learning work and retains data |

Explicit CRUD and Forget work under every gate. Enabling history fills a
newest-first bounded `INDEX_HISTORY` window after a coordinator pass; Settings
shows progress and vectors enrich asynchronously. Terminal failures retry only
after an off/on cycle.

Eligible terminal sources independently enqueue `EXTRACT_FACTS` only while
learning is on; history is not a prerequisite. The retired redream/episode path
does not enqueue new semantic work.

`memoryUiLocale` remains a wire/schema compatibility field; it does not classify
content, gate execution, select prompts, or change fixed-English presentation.
Source storage and retrieval accept arbitrary non-empty normalized Unicode.

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
- Hard-delete chat separately authorizes the exact revision, leaf, and optional
  origin-memory choice. Admission fences recall, learning, and sharing before
  resumable aggregate cleanup. Legacy chat `DELETE` remains Archive-only.
- Expire closes reliable temporal validity; Retract removes automatic truth
  whose evidence is no longer admissible. Neither is user Forget.
- Clear history index removes rebuildable chunks/search rows while
  retaining chats and semantic facts.
- Delete all reusable memory removes reusable fact/history data; it is
  not conversational erasure, retroactive provider erasure, or backup erasure.

## Trust, Evidence, And Scope

Raw AIQSA messages and explicit user actions are primary. Chunks, candidates,
facts, and search entries are derivatives.
Every derived assertion remains rebuildable or retractable and cannot outrank
its admissible evidence. Assistant, web, MCP, tool, Knowledge, and attachment
text do not establish a user fact by default. Secret-tainted source windows are
excluded before derivative persistence or external Memory I/O.

Fact extraction receives only bounded, storage-time-safe, complete direct USER
messages from the active branch. Recognizable-format DLP runs before extractor
egress; semantic sensitivity, quotation, hypothetical/modality meaning, and
`STORE | ABSTAIN` belong to the structured model decision. Exact cited offsets
must resolve to the original message text, while relational messages—not model
JSON—own source authority. This adds no general egress-time DLP dependency.

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
Chat scopes. Chunks stay tied to their source chat and may support
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

`settingsRevision` owns settings CAS. A compatibility-locale-only write
advances it without changing Memory counters or fixed-English presentation.

The authoritative mutation matrix is:

| Operation | Branch gen. | Source rev. | Memory gen. | Memory rev. | Exact authority check |
| --- | ---: | ---: | ---: | ---: | --- |
| Normal append / one semantic terminal settlement | – | + | – | after a derivative becomes visible | source revision and hash |
| First empty lexical-index bootstrap inside its owning visible mutation | – | – | – | no extra increment | settings lock and absent active pointer |
| Edit, regenerate, checkout, active-path delete | + | + | + | + | active leaf, branch, selected items |
| Explicit save or automatic add/reinforce | – | – | – | + | logical fact and current pointer |
| Explicit edit, pin, rescope, conflict resolution | – | – | – | + | selected version and scope |
| Automatic supersede, conflict, expiry, retraction | – | – | – | + | selected version and current pointer |
| Activate/invalidate chunk and lexical row | – | – | – | + once | source, safety, hash |
| Active-generation vector settles READY/FAILED | – | – | – | + | item, generation, fingerprint |
| Forget, bulk clear, or source hard delete | as source requires | + for chat source | + | + | suppression, source, exact items |
| Source NORMAL to EXCLUDED | – | + | + | + | source mode and items |
| Explicit source Resume/reindex | – | + | – | + | cutoff barriers and source snapshot |
| Archive or Restore chat | – | – | – | – | organizational state only |
| Folder move / Assistant access or archive change | – | + for chat move | – | + | current target and access |
| Delete Folder, Assistant, or Chat scope target | – | + where source changes | + | + | target and affected items |
| Change read/learning/safety/egress setting | – | – | – | + | settings, fingerprints, selected items |
| Change only compatibility Memory UI locale | – | – | – | – | settings-revision compare-and-set |
| Shadow-row, catch-up, or physical-purge progress | – | – | – | – | job/outbox fence |
| Activate/reset an index generation | – | – | + | + | exact revision, config, barriers |

Shared transaction helpers own counter mutation. Background work snapshots the
exact revision and safe source-content hash and commits nothing when either is
stale. A global job is not invalidated merely by unrelated additive revision
drift; it rechecks its exact source/fact/version preconditions.

## Fact And Operational State

Candidate, decision, logical-fact, and fact-version states are separate. Legacy
verification states remain decodable for queued/history compatibility but are
not emitted by the normal learning path:

- candidate: `PENDING`, `DEFERRED`, `PROMOTED`, `REJECTED`, `STALE`;
- decision: `PENDING_VERIFICATION`, `APPLIED`, `REJECTED`, `STALE`;
- fact: `ACTIVE`, `CONFLICTED`, `ORPHANED`, `EXPIRED`, `RETRACTED`,
  `FORGOTTEN`;
- version: `ACTIVE`, `CONFLICTING`, `ORPHANED`, `SUPERSEDED`, `EXPIRED`,
  `RETRACTED`, `FORGOTTEN`.

Candidates never reach answers; each binds to succeeded extraction and
direct-USER evidence. Consolidation gets at most 12 same-scope facts and three
versions each, then proposes
`ADD|REINFORCE|SUPERSEDE|CONFLICT|EXPIRE|NOOP`. Server rechecks source,
suppression, explicit precedence, targets, temporal order, and evidence. One
direct-user statement supports its subjective preference; ambiguous scope,
time, sensitivity, or authority abstains during extraction or remains
non-applied. Text terminals fail, unknown calls are not replayed, and drift
schedules source purge.

An active fact has exactly one same-owner active current version. Conflicted,
orphaned, expired, retracted, and forgotten facts have no unqualified current
pointer. Corrections append versions and preserve system-time and valid-time
history. Conflict clears the pointer; explicit resolution appends a version.
Age alone never expires a stable preference. Source invalidation removes only
inadmissible support, then atomically restores one supported claim, keeps two or
more incompatible claims conflicted, or retracts the fact when none remain.
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
configuration, protocol/schema capability, and vector-space compatibility. A second
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
5. Phase B freezes the minimum private recovery checkpoint, exact personal-context text, private run binding/items, and transitions out
   of `PREPARING` to a dispatchable admitted state.
6. Only the committed finalized request may reach the answer provider. Recovery
   of a finalized run replays that frozen request and never performs fresh
   retrieval.

Temporary runs use a fixed disabled snapshot and zero-item `DISABLED` binding
without querying reusable Memory. Whole-retrieval failure
normally degrades an ordinary answer to no personal context with an honest
receipt; a Memory-management request cannot degrade into an invented success.
Old bindings and included item text are immutable and may later show lifecycle
labels such as `Later forgotten` or `Source deleted` without rebuilding the
old context from current Memory.

## External Egress And Tool Coexistence

Logical utility roles are provider-neutral. Resolution uses current AIQSA
provider/credential admission, records the accepted destination, and never
silently substitutes a provider, model, credential, embedding space, or
reranker. Explicit CRUD/Forget and local exact/FTS operation do not depend on a
utility model or embedding credential.

Memory applies System reasoning to a copied snapshot. Effort and policy
revision fence starts via the execution fingerprint without changing
consent identity; unsupported effort is unavailable.

The installation policy `ADMIN | PER_USER` owns acceptance of the non-secret
fingerprint for effective system-memory, embedding, and remote-reranker
destinations. `ADMIN` is the default because those destinations are connected
by an administrator; `PER_USER` preserves the earlier account-level contract.
`ADMIN` stores canonical exact role/destination fingerprints plus policy/audit
metadata in one secret-free singleton. Optimistic acknowledgment kicks
coordinator reconciliation. Bindings, drift checks,
`WAITING_FOR_EGRESS_CONSENT`, and no-silent-fallback remain: only a changed
call target waits, while aggregate additions/removals still require review.
In-flight results cannot cross drift. The answer model remains under per-run
admission, outside the static utility fingerprint.

Labelled `personalContext`, ordinary conversation context, prior assistant
messages, hosted/client Search, Knowledge, and administrator-connected MCP
tools may coexist in the normal provider/tool loop. No per-request exact-value
confirmation, memory-blind planning projection, hosted-Search XOR, or mandatory
split synthesis exists. Storage-time secret screening prevents secret-like
source windows from becoming Memory content; current user input—not Memory—must
still authorize actions and tool/credential selection. Temporary chats expose
no Memory.

Each Memory-affected answer-provider/tool dispatch writes an owner-bound,
recovery-idempotent `MemoryToolEgressReceipt` with destination, ordinal, mode,
content hashes, and terminal outcome—never plaintext or confirmation state.
Destination authority is rechecked before client Search, Knowledge, or MCP.
Accepted destination/outcome stays immutable; deletion scrubs private
query/result derivatives after resolving message/chunk/fact result provenance,
preventing stranded query/result/tool-argument text.

## Retrieval And Index Integrity

Visible facts and chunks synchronously receive one language-agnostic Unicode
exact/simple-FTS projection; compatible vectors are asynchronous. Rebuildable
entries never become truth. A non-empty bounded raw query always enters local
candidate generation even when tokenization produces no terms. Recognizable
secret/binary-like shapes suppress external query embedding and relevance I/O,
not owner-local exact/simple/recency retrieval; only the query hash is persisted
when a safe snapshot cannot be retained.

Exact/simple/vector/recency lanes run in parallel within code-owned bounds and
rejoin owner, generation, lifecycle, scope, source, safety, and suppression
authority before use. RRF combines only lane ranks; BM25 and cosine values are
never treated as a shared calibrated scale. Candidate generation has no
language rule or model-independent semantic threshold. One relevance stage sees
the query, bounded safe projections, and authoritative timestamps, then selects
ordered IDs or an empty set. It cannot modify truth, authority, scope, or time.

An immutable generation pins index mode, source/target revisions, language,
normalization, chunking, pipeline, and, for hybrid mode, the exact embedding
deployment/configuration, dimension, and vector-space fingerprint. An
incompatible change builds and catches up a shadow generation while the old
active generation serves. Activation requires an unchanged full eligible-set
proof, exact current configuration and barriers, then atomically flips the
pointer and advances generation/revision fences. Partial generations never
serve and vector spaces never mix.

Vector retrieval directly scans dimension-specific cosine HNSW with tenant,
generation, readiness, state, scope, source, and safety predicates. ANN forces a
custom plan; a bounded materialized authoritative rejoin rechecks candidates,
and a predicate-identical direct count selects exact/HNSW. No CTE precedes ANN.
Initial plan constants are:

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
query shape requires fresh plan and recall regression evidence with adversarial
closer cross-tenant vectors and production-shaped `EXPLAIN` evidence. That
evidence is an engineering release check, not a signed runtime allowlist.

## Lifecycle And Deletion Truth

Destructive responses commit an eligibility fence; the outbox scrubs
idempotently. Forget consumes exact user
authority, advances counters, fences and suppresses the version/source, removes
search eligibility, and enqueues purge. Undo cancels only its exact pending row;
the fence holds until explicit revival.

`DELETE_LEARNED` records an `AUTOMATIC_FACTS` cutoff, forgets admitted automatic
versions, cancels their search/work, and enqueues one `FORGET_PURGE`. Old work
cannot cross it; later messages may be learned. Purge audits automatic content,
candidates, and feedback influence empty; explicit data/chats/accepted items remain.

`DELETE_ALL_REUSABLE` consumes authorization and Memory/settings CAS.
Admission advances counters, disables gates, detaches the index, records
`ALL_REUSABLE` cutoff, fences reusable owners, and enqueues purge. Eleven
contributors scrub/purge/audit private derivatives. Raw messages and accepted
items remain with frozen text and detached live refs; the cutoff rejects replay.

History clear has its own cutoff; Resume obeys every applicable barrier. Cleanup
retains bounded reconciliation metadata and hashes, never forgotten text.

The source/retention outcomes are:

| Action | Future Memory | Source and derivatives | Historical destinations, shares, external retention |
| --- | --- | --- | --- |
| Save/edit explicit | New lexical current version; stale selected versions fail Phase B | Source action remains; vector may follow | Earlier runs and snapshots unchanged; new utility egress follows installation policy |
| Forget one / delete explicit set | Exact versions and unchanged source evidence fenced | Retained chats remain; durable purge and suppression reconcile all affected derivatives | Old destination request/receipt remains immutable and labeled; share prose is not rewritten; provider/backups keep their own retention |
| Delete learned set | Automatic versions fenced at source cutoff | Explicit versions/chats remain; admitted automatic derivatives purge | Accepted runs/provider/backups unchanged |
| Clear history index | Chunks immediately ineligible with source barrier | Chats and semantic facts remain; rebuildable rows purge | Old destination evidence/prose remains |
| Delete all reusable Memory | All reusable gates fenced with account cutoffs | Raw retained chats remain; reusable tables/indexes purge | Destination runs remain under their owners; no retroactive provider or backup erasure |
| Turn a gate off | That future read/write stops | Data remains; queued work waits or cancels | Existing evidence/shares unchanged; no new affected egress |
| Archive/Restore chat | No Memory change | Chat remains eligible | No change |
| Exclude/Resume source | Exclude fences immediately; Resume obeys barriers | Chat remains; derivatives reconcile or controlled active branch reindexes | Earlier destination evidence/prose remains; resumed utility egress follows installation policy |
| Branch change | Old selected path fenced | Full DAG remains; active path reconciles | Historical runs/shares and already-sent data remain |
| Delete scope target | Target scope unavailable | Automatic facts retract; explicit facts become orphaned | Old destination evidence/prose remains |
| Hard-delete source chat | Source and run graph fenced | Source aggregate deletes, source shares revoke, derivatives reconcile; explicit facts survive by default and CHAT scope orphans | Cross-chat accepted items/prose remain; provider/backups unchanged |
| Delete destination chat/run | No change to source memory | Destination-owned request/attempt/binding becomes deletable; its shares revoke | That destination evidence is removed; already-sent provider/backups unchanged |
| Revoke public share | No Memory change | Share bearer/snapshot becomes inaccessible under share retention | Private run remains; backups may contain old snapshot |
| Temporary expiry | No reusable data ever existed | Entire messages/runs/files/object bytes/drafts/tool/Search/MCP/evidence aggregate purges durably | No AIQSA receipt/share remains; disclosed external retention and backups are separate |
| Account deletion | Composed hook fences immediately; otherwise no mutation | Cancels work, audits, and purges reusable/private data before global user removal | Shares revoke; provider and backup limits remain disclosed |
| Restore old backup | Restored snapshot is quarantined from production | External deletion journal, suppression keys, outbox, barriers, and audit reconcile before promotion | Bearer endpoints remain disabled until review; product never promises operator-backup erasure |

Temporary deletion is due 24 hours after the last terminal run, or after
creation/last local activity when no run settles. Recovery must settle a stuck
run rather than let it postpone deletion indefinitely. The deadline covers all
owned content and object bytes; overdue work is visible as
`BLOCKED_REQUIRES_ADMIN` and remains retryable.

One policy-versioned outbox row and a claimed-lease delete guard own expiry.
The handler settles stuck runs/attempts/executions/tools, removes the complete
run/chat/share/attachment aggregate, deletes only object keys with no surviving
Attachment/Knowledge reference, and requires an empty audit before success.
Crash, lease loss, object failure, or corruption stays blocked/retryable. This
removes AIQSA-owned data only; external providers/tools and operator backups
retain already-sent data under their disclosed policies.

Public anonymous snapshots keep visible assistant prose but strip personal
context, Memory settings/IDs/scores/sources, attempts and execution bindings,
run bindings/items/receipts, Memory events, and Memory tool results. Ordinary
logs and metrics contain only bounded identifiers, stage, duration, counts,
usage, pipeline/model version, and stable codes—never memory text, source
excerpts, tool queries/results, embeddings, raw provider bodies, or secrets.

## Runtime, Backup, And Recovery

The coordinator shares code/image and PostgreSQL. Development starts it from
`instrumentation.ts`; persistent Compose runs private `memory-worker`, with no
API or web-readiness dependency. Tenant-fair skip-locked queues use leases,
bounded retry, and idempotency. Policy admits at most two jobs, one per user,
plus an independent deletion worker; safety weighting bounds every tier.
Invalid policy/keys or database preflight blocks claims feature-locally.
Phase 8 enables hard-delete admission only after exact composition; conflict
fails closed and rollback retains accepted obligations. Durable status stays owner-readable through its bounded operational status projection. [Testing](../TESTING.md) owns the measured gate.

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

Restore uses an internal no-port empty project with only Postgres/MinIO live.
Key IDs preflight before and after mutation; missing keys block automatic work.
A checksummed pending manifest requires explicit external-journal disposition.
Provider-free deletion-only review audits outbox/account obligations, leases,
executions, barriers, objects, and Compose identity. Residue blocks its
checksummed promotion receipt; neither helper performs cutover.

## Bounded Ownership Map

- This document owns Memory terminology, truth/authority, gates, scopes,
  counters, state transitions, retrieval safety, egress policy, lifecycle,
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
  two-phase Memory retrieval/finalization, dispatch, recovery, settlement,
  context, and streaming behavior.
- [Outputs, recovery, sharing, and retention](../run_pipeline/OUTPUTS_RECOVERY_SHARING_AND_RETENTION.md) owns private Memory checkpoint boundaries and positive public-share stripping alongside the other run data.
- [Provider adapters](PROVIDER_ADAPTERS.md) own provider transport, credential
  resolution, usage normalization, and supported capabilities; Memory owns
  compatibility, destination authority, and no-fallback semantics.
- [Frontend](../FRONTEND.md) routes the current shell, Settings, explicit Memory confirmations, responsive access, and localization behavior. Memory UI must extend those owners rather than create a parallel app or post-hoc run inspector.
- [Security](../SECURITY.md) owns implemented auth, secret, logging, network,
  and private-data enforcement. Memory adds no exception.
- [Testing](../TESTING.md) owns lane selection and disposable-environment
  safety. Memory requires focused domain fixtures, migration/Prisma proofs,
  language/script-agnostic semantic-boundary cases, adversarial tenancy/egress
  tests, and a bounded real-provider smoke when current credentials are
  available.

`memory-ga-rollout-manifest-v1` now records default-on fact/history/learning,
the three-tier retrieval contract, model-driven actions, and
composition-gated hard deletion. Legacy capability fields and retired job enums
remain compatibility-only. Rollback stops future work, keeps data, skips silent
backfill, and finishes accepted deletions. Publishing is separate.
