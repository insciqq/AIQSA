# PERSISTENCE

Owner: Persistence maintainers
Scope: Durable ownership, migrations, retention, backup, restore, and deletion.

## Authority And Shape

[`prisma/schema.prisma`](../prisma/schema.prisma), [migrations](../prisma/migrations/), repositories, and stateful tests own exact storage and lifecycle mechanics. PostgreSQL is the coordination authority; private object bytes retain relational ownership/lifecycle references. OpenSearch and guest disks are not backup authorities.

Enforce tenant-consistent parents/children in the database wherever representable. Accepted revisions, bindings, generations, and recovery evidence stay immutable and restrictive while referenced. Preferences and drafts grant no entitlement; null, explicit Off, and a concrete choice remain distinct. Subject semantics belong to [Critical invariants](CRITICAL_INVARIANTS.md), [Run contracts](RUN_CONTRACTS.md), and [Memory](MEMORY.md).

Persist run/tool data only for execution, recovery, duplicate-side-effect prevention, security, deletion, citations/generated output, retention, or accounting. Inspection and presentation histories are insufficient justification. Before dropping storage, remove its projection, prove recovery consumers, stop writes, then apply a forward migration. Retired execution shapes may remain only for required inert historical read/recovery; current admission must not write them.

Personal and Project principals are disjoint. Account deletion removes membership, not shared Project content; nullable actor references and bounded attribution snapshots preserve history. Historical bindings whose missing recovery authority cannot be reconstructed fail closed before external I/O; terminal records remain readable. Skill publication is a live future grant, while accepted text revisions survive unpublication/deletion. Personal Library files have independent lifetimes; removal does not delete already-admitted chat copies, and Project/Temporary attachments are not implicitly promoted to personal files.

The protected `Full access` group's explicit members receive all current/future active provider connections, answer models, and Search sources. Its name/lifecycle are immutable. MCP remains explicitly materialized per server and grants no personal identity or secret authority.

### Recovery And Derived State

External side effects need durable dispatch identity before I/O. Unknown outcomes are never blindly replayed; reported usage settles once and unknown usage stays unknown. Compatible checksum-verified settled PDF work may be reused by an admitted retry; restore preserves ambiguity. Transient decoded/transcribed content is cleared atomically once its durable result is recoverable, or by source/reset/account cleanup. Infrastructure failure cannot produce false success or authorize provider replay.

Claims and terminal writers require status/version/lease guards. Release database locks before guest or file I/O. Memory/history/Knowledge derivatives must reprove current owner, source, lifecycle, safety, and generation authority at use, including while purge is pending. Rebuilds cannot repair canonical state from derived indexes. A rejected replacement preflight leaves the serving index intact; readiness/alias activation follows full integrity proof. Projection and deletion obligations survive source-row deletion so stale retries cannot resurrect content.

Knowledge Source identity is independent of Base membership and equal checksums never merge Sources. Reprocessing preserves prior attempt lineage; replacement content becomes current only after guarded complete settlement, leaving the previous ready version available on failure. Normalized artifacts must suffice for reindexing without originals/parser services, and citations resolve exact stored versions/artifacts. Embedding reuse requires exact text hash and vector space/dimension and creates no provider usage. Memory cutover/rollback uses an immutable whole generation and fresh canonical eligibility/authority checks, never a partial pointer repair. Operational evidence stays bounded and content-free.

Workspace originals/outputs remain downloadable after runtime loss. Only the exact current session owner can execute, export, or settle; lease expiry or cancellation alone does not prove receiver cleanup. Handover must reject stale requests at the guest boundary, including after restart; unproven cleanup leaves the session unavailable. Export captures an answer's owed bytes at its quiescent boundary and recovery reuses that capture without re-enumerating changed guest files or replaying the provider. Missing capture is failure, never an empty success. Bounded capture capacity may fail the affected export, never evict another answer or indefinitely prohibit chat.

Published outputs require verified size/checksum and atomic relational settlement. Attempts use separate writable keys and retain cleanup obligations for unpublished/redundant objects; downloads do not claim pre-header digest verification. Completed exports never downgrade. Confirmed disk loss/reset/restore retires unfinished export/process obligations before recreation, preserving completed attachments. Reset affects runtime state, not messages or attachments.

## Migrations And Bootstrap

v0.2.0 requires a clean database. Compatibility with v0.1.x, including v0.1.24, is intentionally unsupported: the installation operator must remove the old database and initialize an empty one. Do not restore the old migration chain, adopt its baseline, or add an upgrade bridge to preserve that data. This release boundary does not authorize resetting operator data during development or verification.

`20260815000000_baseline` is the immutable first migration anchor, including custom PostgreSQL DDL that Prisma cannot reconstruct. Changes are append-only migrations. Persistent installations use `prisma migrate deploy`, never `prisma db push`.

Keep custom checks and deferred triggers for row, tenant/source, history, deletion, and concurrent-writer invariants that relations cannot express, especially with raw SQL workers and destructive handlers. Simplify them only through behavior-proven forward migrations.

Bootstrap accepts an empty schema or the exact adopted administrator identity under serializable/advisory-lock protection. It refuses other nonempty targets before mutation and creates minimal foundations without demo content or real provider deployments. Adopted reruns may repair code-owned foundations, preserving operator identity, credentials, settings, grants, policy, and content.

The Knowledge V1 bridge backfill (`npm run knowledge:sources:backfill`) remains bounded, resumable, idempotent, and content-free. It preserves explicit document/version identities and never deduplicates by checksum. Inspect executable migrations/backfills for the actual upgrade path; development fixtures do not establish an external compatibility contract.

## Retention And Deletion

`npm run prune -- --dry-run` is read-only and precedes any explicitly authorized `--execute`. Never prune active sessions/runs, retrieval-visible evidence without a proven cutoff, or referenced objects. All destructive verification targets only the disposable topology in [Testing](TESTING.md), never the default persistent installation or operator data.

Deletion first fences future admission/recall/sharing and creates a durable obligation before acknowledgment. Handlers reauthorize the exact aggregate, settle active work, and retry idempotently; administrator-blocked obligations are not abandoned. Object staging locks/rechecks every reference, deletion uses leased per-key jobs, and concurrent attachment linking has one transactional winner. Failures retain value-free retry evidence.

Knowledge Trash fences future use while membership/publication remains recoverable. Permanent deletion starts only from Trash. Source purge removes its versions/artifacts/private evidence; Base purge removes scope/evidence without deleting canonical Sources. Answer text remains, but deleted citations retain only generic handles without private provenance. Completion waits for every object to be deleted or proven live elsewhere, then drops object-path manifests. Retention cutoffs and batches are owned by code.

Account deletion drains owned Knowledge and Memory dependencies/staging before protected parents. Project deletion is an explicit Owner-authorized aggregate action; unlinking personal resources does not delete them. Account deletion and Project archival cannot substitute for that action. Inbound Memory OAuth revocation retains facts; account deletion removes grants/issued secrets without deleting independently registered public-client metadata. Accounting retention may preserve content-free usage without retaining grants/users indefinitely.

Workspace idle stop preserves its disk. Expiry/reset/chat deletion first records exact-session cleanup; it never authorizes another sandbox's deletion. Missing disks are visibly recreated from canonical originals, not reported as surviving state. External provider/tool retention, backups, and already-sent data are outside claims of application erasure.

## Backup And Restore

Orchestration belongs to the separate infrastructure workspace. Verify migrated schema, stop all writers, release/fence claimed Memory, Knowledge, and object-deletion work, then copy PostgreSQL and private objects together. Record format/schema and required non-secret Memory key IDs; restore exactly the prior writer set afterward. Preserve chat PDF artifacts and dispatch ambiguity. Back up required secrets separately under [Environment](ENV_VARIABLES.md).

Restore accepts only an acknowledged empty internal `aiqsa-restore-*` project with no published ports or application writer. Preflight format, schema, identities, keys, and objects before producing a pending review manifest. Review performs credential-free Memory/Knowledge deletion reconciliation and blocks promotion while deletion/account/barrier duties, leases, uncertain executions, missing keys, or object failures remain. Helpers never cut over production automatically.

OpenSearch is excluded: reset restored obligations to pending, rebuild from PostgreSQL, and pass strict aggregate integrity gates before enabling each retrieval mode. Guest disks/runtime identities are excluded: clear them, retire restored process/export obligations, and reset sessions to pending before new runs restage originals.
