# NATIVE MEMORY

Owner: Native Memory contract maintainers
Scope: Approved product semantics, correctness fences, privacy boundaries, and target module ownership for AIQSA-native personal Memory.

## Implementation Status And Authority

Native Memory is approved. Shipped foundations cover evaluation, durable
coordination, scoped explicit Memory, Temporary lifecycle, safe history
indexing/manual search, and answer recall. Recall uses exact/RU/EN/simple FTS,
optional qualified vectors, RRF, bounded per-term language ORs,
temporal/contextual probes, bounded packing, and exact source/suppression
rechecks; generic knowledge queries need a personal/history signal.
Retained turns and Resume enqueue indexing only with `referenceChatHistory`;
the gate now defaults on for every owner, while learning stays independent and
defaults off. HYBRID degrades to lexical without qualified query
embedding. Remote expansion/rerank are opt-in and require exact accepted policy
plus signed role qualification.

Explicit Memory supports owned `GLOBAL_USER`, `FOLDER`, `ASSISTANT`, and
non-Temporary `CHAT` scopes. Assistant archive pauses its scope; target deletion
retracts automatic current versions and orphans explicit ones for Move or
Forget. The dormant chat hard-delete hook has no public surface.

One transaction helper owns production DAG/source writes and exact active-path
hashes. Apply rechecks generation, leaf, branch, revision, and hash under the
chat lock; drift settles without partial writes. Lock order is affected Folder,
Chat, UserMemorySettings; source-job commit locks Chat, UserMemorySettings,
then its MemoryJob lease. Queued/streaming payload is hash-neutral. Source
changes invalidate stale active history rows synchronously; `INDEX_HISTORY`
rechecks source, generation, gate, suppressions, and cutoffs before atomically
committing chunks, joins, FTS rows, and checkpoint. Qualified episodes commit
safe extractive summaries under the same fence. Learning remains unavailable.

The durable foundation persists settings, facts/evidence/suppressions, indexes,
jobs/deletions, execution/retrieval attempts, and final-run evidence under
database ownership/shape/current-pointer constraints. The coordinator fences
claims, retries, blocked deletion, and apply. The current schema and upgrade
default `useMemoryFacts` and `referenceChatHistory` on for every owner while
`learnAutomatically` remains off; suppression HMAC keys stay installation-only.

Every normal send and regeneration uses the two-phase run boundary. Phase A
commits the exact DAG, ordinary dependency evidence, private `PREPARING` run,
bounded base request, and one retrieval attempt. Recall selects eligible current
or requested historical facts plus safe chunks/episodes from the exact active
generation and scope. Local exact/FTS needs no utility consent. Qualified query
embedding and optional expansion/rerank bind before I/O and retain one usage row
per terminal outcome. Phase B rechecks the DAG, target, settings/index, ordinary
admission, used utility policy, and every exact item/source/safety snapshot
before freezing the untrusted pack, request, binding, and items. Drift gets one
safe retry. Retrieval may degrade; management cannot invent success. Dispatch
rejects `PREPARING`; recovery uses only the finalized request.

Tool-capable answers may additionally use the first-party bounded
`search_my_history` tool. It returns at most 20 private results per page, may
run at most twice per answer run, applies the same source/suppression/safety
fences as manual history search, and owns a distinct private receipt joined to
the exact persisted tool call. Settled receipts replay exactly; a recovered
RUNNING receipt has unknown outcome and is never repeated.

All answer adapters place labelled personal context after trusted instructions.
Normal runs may carry that untrusted context together with hosted/client Search,
Knowledge, and administrator-connected MCP/external tools. Temporary chats
still carry none, and Memory remains data: it cannot authorize an action,
enable a tool, or select credentials.
Each accepted run privately projects its exact frozen Memory outcome/items into
the originating answer and a passage-free Events digest. Later Forget or source
loss adds a lifecycle label without replacing admitted text. Save/Edit/Forget
feedback requires the exact same-run applied operation/tool receipt join;
ambiguous targets route to Manage Memories without mutation.

Authenticated `GET/PATCH /api/me/memory/settings` exposes bounded, `private,
no-store` settings/capability and utility-policy state. The three gates and
RU/EN locale are independent; only memory-visible changes advance Memory
revision. `AIQSA_MEMORY_EGRESS_CONSENT_MODE` selects installation-owned
`ADMIN` (default) or retained `PER_USER` consent. `ADMIN` gives users passive
status only; administrators own its four-row exact-fingerprint action.
`PER_USER` retains the existing fingerprint/CAS acceptance.
Embedding selection still requires current entitlement. Stale observations
fail atomically.

Explicit management is gate-independent across owned `GLOBAL_USER`, `FOLDER`,
`ASSISTANT`, and non-Temporary `CHAT` scopes. Short-lived grants bind Save to an
exact statement; Edit/Forget/Move to one fact; and `DELETE_EXPLICIT`,
`CLEAR_HISTORY_INDEX`, or `REDREAM_EXISTING_CHATS` to counters,
operation, confirmation copy, and nonce.
Move separately reauthorizes and locks its exact active target scope before the
grant is consumed. The serializable
mutation consumes the grant; only an exact receipt-matched retry can replay.
Private list, POST-search, detail, evidence, create, edit, Move, pin, Forget,
bulk-delete, and status routes rejoin ownership and keep free text out of URLs.
Writes synchronously update exact/RU/EN/simple FTS without utility egress.
Published foreign Assistants confer no personal-memory authority, unavailable
targets do not consume a mutation grant, and orphaned explicit facts expose
only Move or Forget. Secret-like statements remain rejected; internal owner,
canonical, authorization, and suppression identities stay private.

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
Clear-history fences with an account cutoff and auditable `BULK_CLEAR` while
retaining chats, facts, and accepted evidence.

Explicit, chunk, and episode writes enqueue content-free `EMBED_ITEMS` only for
an active HYBRID generation; lexical-only rows stay `NOT_APPLICABLE`. The handler
parks without consent, credential authority, or signed contract qualification.
Each call has one binding/usage event and exact item/generation/content/config/
dimension/vector-space apply. READY/FAILED advances revision while FTS stays
live; unknown results are not replayed, and drift blocks late apply.

Shadow rebuild/re-embed uses non-serving full diff; HYBRID requires
vectors and consent. Activation rechecks source/config/barriers/revision and
advances counters once; failure/cancel never serves. Redream jobs are salted,
source-fenced, and replayable.

Candidate extraction is feature-dark; consolidation/profile, later bulk
variants, and production qualification remain unavailable.
Remote lanes require exact consent/qualification and otherwise fail closed while
local exact/FTS remains available. Web and `memory-worker` share one coordinator
for purge, Temporary deletion, indexing, episodes, rebuild, history/source
cleanup, and optional embeddings; Memory failure does not alter web readiness.
Manual search remains inspection-only; answer recall admits safe frozen history
through its own PREPARING attempt. Per-call
execution owns current authority, receipts, single-winner start, usage,
recovery, and detach. Private
`preparing` runs never reach public projection or provider I/O.
Ordinary answers cannot create Memory. Existing chat context and folder/project
prompt memory are separate retained-chat behavior.

Temporary admission atomically binds an empty chat to one deletion obligation;
mode/policy are immutable. It keeps disabled run evidence, omits Memory/source/
project projections, and stays exact-route.

Anonymous share creation and reads re-project through the positive public
text-only schema. Personal context, Memory attempts/executions/bindings/items,
events, operation/tool receipts, identifiers, sources, and lifecycle metadata
never enter the public snapshot or response; visible answer prose is preserved.

Executable code, migrations, tests, and this status own shipped behavior; a
planned name grants no route, schema, or control before its dependencies exist.

Memory is native to the existing modular monolith. PostgreSQL is the durable
authority; pgvector, PostgreSQL full-text search, exact matching, temporal
filters, and reciprocal-rank fusion are retrieval tools below that authority.
No external memory service owns chat branches, accepted-run evidence, access,
deletion, retention, or truth.

Hindsight is absent from production but may guide behavior and architecture for
complex components. Only a disabled, pinned evaluation adapter may use synthetic
or explicitly approved data; results never define AIQSA truth. Copied code
requires license and attribution review.

Evaluation binds exact runtime/version/vector fingerprints, corpus hash,
PostgreSQL profile, and seed. Proportions use two-sided 95% Wilson intervals;
ranking uses deterministic stratified-bootstrap intervals. Gates compare
unrounded values and display three decimals. Missing hard-invariant or selected-
profile coverage fails. `RECALL_RELEASE` and `AUTOMATIC_LEARNING_BETA` require
independent complete RU/EN gates.

`MemoryCapabilityQualification` is fail-closed authority over the exact role,
language, runtime/config/vector fingerprints, retrieval configuration, and
material versions. Approval is signed, effective, and unexpired. Live
evaluation separately requires exact operator authorization, synthetic HOLDOUT
fixtures, and sanitized aggregates without fixture/provider bodies.

## Product Vocabulary And Independent Controls

The feature has four independently understandable layers:

- explicit Saved Memories, whose user action has highest authority;
- safe past-chat chunks and episodes used for history recall;
- automatically learned, evidence-backed semantic facts;
- a derived profile/working set that may summarize only supported current
  facts.

The gates are independent. Facts/history default on for new and migrated
owners; automatic learning defaults off:

| Gate | Reads | Writes | Turning it off |
| --- | --- | --- | --- |
| `useMemoryFacts` | Eligible explicit and previously learned facts | Nothing by itself | Stops future fact injection and retains data |
| `referenceChatHistory` | Eligible chunks and episodes | Incremental history index only | Stops history recall/index work and retains data |
| `learnAutomatically` | Source evidence needed by learning | Candidates and automatic facts | Stops learning work and retains data |

Explicit CRUD and Forget work under every gate. Enabling history fills a
newest-first four-job `INDEX_HISTORY` window after a coordinator pass; Settings
shows progress and vectors enrich asynchronously. Terminal failures retry only
after an off/on cycle.

Eligible terminal sources independently enqueue `EXTRACT_FACTS` only while
learning is on; history is not a prerequisite and existing chats still require
explicit `REDREAM_EXISTING_CHATS`.

Memory UI locale persists as `RU | EN` (initially RU). Russian independently
gates behavior and accessible copy. Display preserves source language; search
may normalize NFKC, case, spacing, punctuation, and `ё`/`е` equivalence.

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

Fact extraction receives only bounded, storage-time-safe, complete direct USER
messages from the active branch. Local screening removes secrets/disallowed
sensitivity and excludes instruction- or hypothetical-shaped input before
extractor egress. Exact model quotes become server-validated spans; relational
messages—not model JSON—own source authority. This adds no general egress-time
DLP dependency.

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

Candidates are never answer-retrievable. Every non-purged active candidate is
bound to its exact source job, succeeded extraction, and direct-USER message
relation; authority drift rejects commit, while later invalidation makes it
`STALE` and schedules source purge.

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
query/result derivatives after resolving message/episode result provenance,
preventing stranded query/result/tool-argument text.

## Retrieval And Index Integrity

Lexical-only is complete. Visible items synchronously get RU/EN/simple FTS;
compatible vectors are asynchronous. Rebuildable entries never become truth.
Queries OR bounded normalized terms per projection before exact tenant,
generation, lifecycle, scope, safety, and relevance fences.

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
| Save/edit explicit | New lexical current version; stale selected versions fail Phase B | Source action remains; vector/profile may follow | Earlier runs and snapshots unchanged; new utility egress follows installation policy |
| Forget one / delete explicit set | Exact versions and unchanged source evidence fenced | Retained chats remain; durable purge and suppression reconcile all affected derivatives | Old destination request/receipt remains immutable and labeled; share prose is not rewritten; provider/backups keep their own retention |
| Delete learned set | Automatic facts fenced with observed-source barrier | Chats remain; automatic facts/candidates purge | Old destination evidence/prose remains |
| Clear history index | Chunks/episodes immediately ineligible with source barrier | Chats and semantic facts remain; rebuildable rows purge | Old destination evidence/prose remains |
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
| Account deletion | Immediate account-wide Memory fence | Memory hook cancels work and purges reusable/private data within global owner workflow | Account shares revoke; provider and operator-backup limits remain disclosed |
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
- [Evidence, sharing, and retention](../run_pipeline/EVIDENCE_SHARING_AND_RETENTION.md)
  owns implemented frozen Memory inspection and positive public-share
  stripping alongside the other run evidence.
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
