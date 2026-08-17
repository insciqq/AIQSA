# MEMORY

Owner: Native Memory maintainers
Scope: Personal Memory semantics, evidence, privacy, retrieval, learning, lifecycle, and recovery.

## Product Contract

Native Memory is AIQSA-owned PostgreSQL state, not an external memory engine. It has three independently controlled sources: explicit Saved Memories, safe past-chat recall chunks, and automatically learned evidence-backed facts. Reading facts, referencing history, and automatic learning are separate gates; disabling a gate stops future use/work without silently deleting retained data. Explicit management remains available.

Retrieval has three cooperating tiers: a small query-independent Core of authoritative facts, automatic hybrid prefetch for an eligible user turn, and a read-only model-callable `search_memory` second pass. Core favors explicit/corrected/pinned authority and stable salience. Dynamic recall combines owner- and scope-fenced exact, lexical, vector, and recency candidates, then uses a strict structured relevance decision; if that utility call degrades, dynamic automatic injection is empty rather than guessed. Local candidates remain available to the explicit search tool and the ordinary answer may continue.

The answer model may receive typed save, list, update, forget, incorrect, and search tools on eligible tool-capable normal runs. Natural-language regex routing is not an authority boundary. Mutations mint authority only from the current direct user message plus an exact current owned target/version/scope. Retrieved text, assistant prose, tool/Search/Knowledge output, quoted content, or earlier turns cannot authorize a Memory mutation. Ambiguity asks; irreversible bulk deletion confirms.

Temporary chats never read or write personal Memory, inherit project Memory, advance Memory counters, or schedule Memory work. Anonymous shares retain only visible assistant prose and strip all Memory context, facts, attempts, bindings, sources, receipts, identifiers, and lifecycle metadata.

Shared Project Memory is a separate Project-owned aggregate, not a scope of personal Memory. Project runs include only current active approved fact versions; pending proposals are excluded until a Manager or Owner explicitly approves them. Project chats never read, write, learn from, or schedule work for personal Memory, and facts are never copied automatically between a user and a Project.

## Evidence, Scope, And Trust

Raw direct-user messages and explicit user actions are primary evidence; chunks, candidates, facts, vectors, and search entries are derivatives. Assistant, web, MCP, tool, Knowledge, and attachment text do not establish a user fact by default. Secret-shaped source windows are rejected before derivative storage or provider egress. Structured extraction must cite exact source spans and may store or abstain; the server validates shape, ownership, source, modality, sensitivity, scope, time, and recognizable-secret safety without inventing semantic meaning from regexes or numeric confidence thresholds.

Memory is untrusted data placed after trusted instructions. It cannot authorize an action, enable a tool, choose a provider/credential, grant access, bypass confirmation, or publish data. Explicit correction outranks explicit memory, which outranks direct recent evidence, independent evidence, and derived inference; scope and time constrain every level.

Facts support user-global, exact Folder, exact Assistant, and exact non-Temporary Chat scopes. `userId` is always the tenant boundary. Retrieval admits only the current user's global scope plus the exact current targets. The server selects the narrowest safe scope and never promotes ambiguity to global. Assistant publication grants no personal-Memory access.

Scope identity and version history are append-only. Target deletion retracts unsupported automatic facts and makes explicit scoped facts non-retrievable until Move or Forget; Move creates lineage in a new scope rather than rewriting history. Forget synchronously fences the fact and suppression barrier before deferred purge, so unchanged evidence cannot resurrect it. A later explicit save may deliberately override that barrier under the reviewed rule.

## Admission, Indexing, And External Calls

Every normal send/regeneration uses the run's two-phase boundary. Phase A atomically accepts the message graph, ordinary bindings, private non-dispatchable run, base request, and one retrieval attempt before optional Memory provider I/O. Each embedding, expansion, rerank, extraction, consolidation, or verification call first gets an immutable execution binding with exact destination, credential, schema/prompt role, input/output identity, and usage authority.

Phase B rechecks the graph, settings/generations, scope, source eligibility, suppression, egress consent, utility evidence, and every selected item, then freezes the minimum untrusted pack and recovery request. Only then may the answer provider run. Drift may receive one safe retry; finalized recovery reuses the frozen pack and never retrieves again. Cancellation/failure/expiry settles the owned attempt and any open bindings.

PostgreSQL exact and multilingual-simple FTS projections are synchronous. Vectors are asynchronous enrichments pinned to one accepted embedding fingerprint, dimension, and generation; incompatible spaces never mix. Candidate generation has no semantic cutoff that would make non-English or cross-language recall silently disappear. Every returned ID is authoritatively rejoined under owner/scope/source/suppression fences after ranking.

External Memory work follows administrator-approved aggregate egress fingerprints. A changed destination pauses only affected work until renewed; no fallback destination is selected. Every call has one starter and one usage outcome. Ambiguous outcomes are recoverable only through provider-specific monotonic reconciliation, never blind replay.

## Learning And Lifecycle

Automatic extraction makes one strict store-or-abstain decision. Consolidation receives a bounded same-scope semantic neighborhood and may add, reinforce, supersede, conflict, expire, or abstain. The server rechecks current evidence, temporal order, explicit precedence, suppression, and exact targets before applying. Conflicts remove the unqualified current pointer until explicit resolution; age alone never expires a stable preference.

Branch/path and source revisions fence derivatives from abandoned or changed chat evidence. User Memory generation fences destructive or identity-changing work; Memory revision covers visible eligibility/ranking/safety changes. Background work snapshots the exact source revision/content identity and commits nothing when stale. Shared transaction helpers own counter changes; callers do not improvise them.

Archive is organization only. Exclude stops future automatic recall/learning from a retained chat; Resume is an explicit bounded reindex. Clear history removes rebuildable chunks while keeping chats/facts. Delete reusable Memory does not erase chat text, providers, tools, Search, or backups. Permanent chat and account deletion first fence admission and then run typed durable cleanup; unresolved external outcomes remain blockers rather than discarded evidence.

Deletion duties are retryable and never terminally abandoned. Backup requires writer quiescence and every suppression key referenced by durable state; restore remains blocked until deletion/barrier/execution review is clean. [Persistence](PERSISTENCE.md) owns those mechanics, [Run contracts](RUN_CONTRACTS.md) owns answer admission, and [Security](SECURITY.md) owns secrets and egress trust.
