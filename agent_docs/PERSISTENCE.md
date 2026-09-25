# PERSISTENCE

Owner: Persistence maintainers
Scope: Durable ownership, migrations, retention, backup, restore, and deletion.

## Authority And Shape

[`prisma/schema.prisma`](../prisma/schema.prisma), [migrations](../prisma/migrations/), repositories, and stateful tests own exact storage and lifecycle mechanics. PostgreSQL is the coordination authority; private object bytes retain relational ownership/lifecycle references. OpenSearch and guest disks are not backup authorities.

Enforce tenant-consistent parents/children in the database wherever representable. Accepted revisions, bindings, generations, and recovery evidence stay immutable and restrictive while referenced. Preferences and drafts grant no entitlement; null, explicit Off, and a concrete choice remain distinct. Subject semantics belong to [Critical invariants](CRITICAL_INVARIANTS.md), [Run contracts](RUN_CONTRACTS.md), and [Memory](MEMORY.md).

Persist run/tool data only for execution, recovery, side-effect prevention, security, deletion, citations/outputs, retention or accounting. Before dropping storage, remove projections, prove recovery consumers, stop writes, then migrate forward. Retired shapes serve required historical read/recovery only; current admission never writes them.

Personal and Project principals are disjoint. Account deletion removes membership, not shared content; nullable actors and bounded attribution preserve history. Unrecoverable historical authority fails closed before external I/O; terminal records remain readable. Skill publication grants future use; accepted revisions survive unpublication/deletion. Revisions and bundle objects are append-only, including private incomplete imports. Removing a personal saved file preserves admitted chat copies; Project/Temporary attachments never implicitly become personal files.

The protected `Full access` group's explicit members receive all current/future active provider connections, answer models, and Search sources. Its name/lifecycle are immutable. MCP remains explicitly materialized per server and grants no personal identity or secret authority.

### Recovery And Derived State

External side effects need durable dispatch identity before I/O. Unknown outcomes are never replayed; usage settles once and unknown usage stays unknown. Compatible settled PDF work may be reused by an admitted retry; restore preserves ambiguity. Transient decoded content clears once its durable result is recoverable or by cleanup. Infrastructure failure cannot produce false success or provider replay.

Claims and terminal writers require status/version/lease guards. Release database locks before guest/file I/O. Memory/history/Knowledge derivatives reprove owner, source, lifecycle, safety and generation authority at use, including during purge. Rebuilds cannot repair canonical state from derived indexes. Rejected replacement preflight leaves serving indexes intact; activation follows integrity proof. Projection/deletion obligations survive source deletion so stale retries cannot resurrect content.

Checkpoints retain bounded branch/source/pin/revision and refs. Hybrid adds notes and attempt receipts (binding/source digests/usage), never prompts/transcript/guest bytes; stale writers are fenced. Reuse summaries on source revision; unavailable/oversized sources fail closed without replay/fallback.

Knowledge Source identity is independent of Base membership; equal checksums never merge Sources. Reprocessing preserves attempts; replacement becomes current only after guarded settlement, leaving the prior ready version on failure. Normalized artifacts support reindexing without originals/parser services; citations resolve exact stored versions/artifacts. Embedding reuse requires exact text hash and vector space/dimension, creating no usage. Memory cutover/rollback uses one immutable generation and fresh eligibility/authority checks. Operational evidence stays bounded and content-free.

Workspace originals/outputs survive runtime loss. Execution/export/settlement require current session ownership. Expiry/cancellation cannot prove cleanup; uncertainty blocks the session. Handover fences stale requests across restarts. Export captures quiescent bytes; recovery requires capture without guest enumeration/provider replay. Capacity may reject export, never evict another answer or block chat.

Outputs settle atomically after size/checksum verification. Isolated writes retain cleanup obligations. Downloads cannot claim pre-header digest verification; completed exports never downgrade. Disk loss/reset/restore retires unfinished obligations before recreation, preserving messages, completed attachments and verified retained captures.

References/readers protect immutable captures. Checkpoints settle independently of final export; recovery publishes the declared retained version under current access, without mutable paths or guest reexecution. Same-path versions retain distinct identities; deletion/retention applies.

System Vision claims unknown usage before dispatch; analysis settles once. Ambiguous attempts never rebill. Stop/access loss suppresses success, preserving usage separately. Recovery reuses settled analysis without pixels/provider I/O.

Artifact deduplication is owner-scoped; publication membership never changes author bytes. Renderer caches preserve identity/revocation. Cleanup reservations protect concurrent writes/reuse/deletion.

## Migrations And Bootstrap

v0.2.0 starts supported persistent upgrades; earlier development databases need no bridge. Forward migrations preserve operator data, credentials and configuration, tolerating previous-release writers during Compose replacement. Destructive/incompatible upgrades require a separate operator procedure, never ordinary `pull`/`up`. Verification never resets operator data.

`20260815000000_baseline` is the immutable first migration anchor, including custom PostgreSQL DDL that Prisma cannot reconstruct. Changes are append-only migrations. Persistent installations use `prisma migrate deploy`, never `prisma db push`.

Upgrade adopts Vision from page-image configuration once; later edits/clears stay independent. Accepted PDF bindings remain immutable.

Keep custom checks and deferred triggers for row, tenant/source, history, deletion, and concurrent-writer invariants that relations cannot express, especially with raw SQL workers and destructive handlers. Simplify them only through behavior-proven forward migrations.

Bootstrap accepts an empty schema or the exact adopted administrator identity under serializable/advisory-lock protection. It refuses other nonempty targets before mutation and creates minimal foundations without demo content or real provider deployments. Adopted reruns may repair code-owned foundations, preserving operator identity, credentials, settings, grants, policy, and content.

The Knowledge V1 bridge backfill (`npm run knowledge:sources:backfill`) remains bounded, resumable, idempotent, and content-free. It preserves explicit document/version identities and never deduplicates by checksum. Inspect executable migrations/backfills for the actual upgrade path; development fixtures do not establish an external compatibility contract.

## Retention And Deletion

`npm run prune -- --dry-run` is read-only and precedes any explicitly authorized `--execute`. Never prune active sessions/runs, retrieval-visible evidence without a proven cutoff, or referenced objects. All destructive verification targets only the disposable topology in [Testing](TESTING.md), never the default persistent installation or operator data.

Deletion first fences future admission/recall/sharing and creates a durable obligation before acknowledgment. Handlers reauthorize the exact aggregate, settle active work, and retry idempotently; administrator-blocked obligations are not abandoned. Object staging locks/rechecks every reference, deletion uses leased per-key jobs, and concurrent attachment linking has one transactional winner. Failures retain value-free retry evidence.

Knowledge Trash fences future use while membership/publication remains recoverable. Permanent deletion starts only from Trash. Source purge removes its versions/artifacts/private evidence; Base purge removes scope/evidence without deleting canonical Sources. Answer text remains, but deleted citations retain only generic handles without private provenance. Completion waits for every object to be deleted or proven live elsewhere, then drops object-path manifests. Retention cutoffs and batches are owned by code.

Account deletion drains owned Knowledge and Memory dependencies/staging before protected parents. Project deletion is an explicit Owner-authorized aggregate action; unlinking personal resources does not delete them. Account deletion and Project archival cannot substitute for that action. Inbound Memory OAuth revocation retains facts; account deletion removes grants/issued secrets without deleting independently registered public-client metadata. Accounting retention may preserve content-free usage without retaining grants/users indefinitely.

Workspace idle stop preserves disk; expiry/reset/deletion first records exact-session cleanup. Continuation archives are private checksum-bound seeds, owned by the claim then destination chat. Fence capture/restore leases. Successful restore consumes the seed even after reset or disk loss; interrupted restore retries only after cleanup. Abandoned/failed/reset/deleted seeds enqueue reference-checked object cleanup. Missing disks visibly recreate canonical originals, never claim survival. External provider/tool retention, backups and sent data remain outside application-erasure claims.

Agent threads remain outside exported `project/`, without independent retention/backup/continuation seeds. Ordinary resume requires a compatible completed active-branch predecessor in the surviving session; otherwise use branch context. Follow-up requires the live run's exact settled predecessor/runtime; loss prohibits recreation/replay. Stored identifiers/hashes cannot override disk loss/revocation.

## Backup And Restore

Orchestration belongs to the separate infrastructure workspace. Verify migrated schema, stop all writers, release/fence claimed Memory, Knowledge, and object-deletion work, then copy PostgreSQL and private objects together. Record format/schema and required non-secret Memory key IDs; restore exactly the prior writer set afterward. Preserve chat PDF artifacts and dispatch ambiguity. Back up required secrets separately under [Environment](ENV_VARIABLES.md).

Restore accepts only an acknowledged empty internal `aiqsa-restore-*` project with no published ports or application writer. Preflight format, schema, identities, keys, and objects before producing a pending review manifest. Review performs credential-free Memory/Knowledge deletion reconciliation and blocks promotion while deletion/account/barrier duties, leases, uncertain executions, missing keys, or object failures remain. Helpers never cut over production automatically.

OpenSearch is excluded: reset restored obligations to pending, rebuild from PostgreSQL, and pass strict aggregate integrity gates before enabling each retrieval mode. Guest disks/runtime identities are excluded: clear them, retire restored process/export obligations, and reset sessions to pending before new runs restage originals.
