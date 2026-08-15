# PERSISTENCE

Owner: Persistence maintainers
Scope: Durable ownership, migrations, retention, backup, restore, and deletion obligations.

## Authority And Shape

`prisma/schema.prisma`, committed migrations, database constraints, repositories, and stateful tests own exact tables and fields. Prose records only cross-aggregate rules. PostgreSQL is the coordination authority for users, entitlements, chats/message DAGs, immutable configuration revisions, accepted runs/bindings, jobs, usage, Memory, Knowledge, MCP, and share snapshots. Private object bytes live in the configured S3-compatible store or filesystem fallback; relational rows own capability and lifecycle.

Tenant-bearing parents and children prove the same owner at the database boundary wherever representable. Accepted revisions, bindings, content generations, and recovery evidence are immutable and restrictive while referenced. Mutable recommendations, preferences, and drafts grant no entitlement. Null, explicit Off, and a concrete choice remain distinct persisted states.

The protected non-archived `Full access` group has explicit membership and semantically receives every current/future active provider connection, answer model, and Search source without materialized ordinary grants. Its name and lifecycle are immutable. MCP use remains materialized per server so deletion and revision policy retain exact relations; it never grants personal slots, OAuth identity, or personal secrets. Ordinary grants require exactly one principal and one nonempty target.

Persist run or tool data only for execution, recovery, duplicate-side-effect prevention, security, deletion, citations/generated output, retention, or aggregate accounting. Presentation-only event histories, previews, and inspector payloads are not storage justification. Remove a projection first, prove recovery consumers, stop writes, then remove schema with a forward migration.

## Migrations And Bootstrap

`20260815000000_baseline` is the immutable first migration anchor; its reviewed custom PostgreSQL DDL is part of the contract and cannot be reconstructed from Prisma alone. Future changes are append-only migrations. Persistent installations use `prisma migrate deploy`, never `prisma db push`.

Bootstrap runs under a serializable transaction and advisory lock. It accepts only an empty schema or the exact adopted administrator identity, refuses other nonempty targets before mutation, and creates minimal installation foundations without demo content or real provider deployments. Adopted reruns may repair missing code-owned foundations but preserve operator identities, credentials, settings, grants, policy choices, and content.

One active `preparing | queued | streaming | in_progress` run per chat is enforced in PostgreSQL. Run admission commits the message graph, exact ordinary bindings, private preparation state, and Memory attempt together; dispatch becomes possible only after the second guarded commit freezes the recovery request. Terminal writers, tool results, external Memory executions, queue claims, and deletion work use status/version/lease guards so one transition wins.

Background document and Memory queues use durable owner-aware claims, short leases, heartbeats, and idempotent settlement. Fairness is per pipeline and non-preemptive; it prevents one continually eligible owner from monopolizing grants but is not an admission quota. Outcome-ambiguous external side effects are never blindly replayed.

## Retention And Deletion

`npm run prune -- --dry-run` is read-only and precedes any explicitly authorized `--execute`. Pruning removes only bounded terminal/auth state and stages private-object cleanup. It never deletes active sessions, live accepted runs, retrieval-visible Knowledge payloads without a proven cutoff, or an object still referenced by Attachment or Knowledge.

Object deletion uses a durable per-key job. Staging locks and rechecks all references; workers claim bounded leases; deletion is idempotent; failures retain a retryable obligation with a stable value-free code. Run attachment linking uses the inverse compare-and-set so a prune/run race has one transactional winner.

Temporary chat expiry, permanent retained-chat deletion, account Memory cleanup, reusable-Memory deletion, and scope-target deletion are typed aggregate obligations. Admission first fences future recall/work/sharing, then retry-safe handlers settle active work and remove only the authorized aggregate. Deletion obligations may become visibly administrator-blocked but are never abandoned. Provider, external tool, backup, and already-sent Search/embedding retention are not falsely promised as erased.

## Backup And Restore

`ops/backup/create.sh` is the Postgres/object consistency boundary. It verifies the migrated schema, stops app and Memory writers, releases or fences claimed work, copies both authorities, records format/schema and required non-secret Memory key IDs, then restores exactly the prior writer set.

Restore accepts only an acknowledged empty internal `aiqsa-restore-*` project with no published ports and no application writer. It preflights format, schema, identities, keys, and objects before producing a pending review manifest. Review runs credential-free deletion reconciliation and blocks promotion while deletion/account/barrier duties, leases, uncertain executions, missing keys, or object failures remain. Helpers never cut over production automatically.

All destructive verification targets only the disposable topology described in [Testing](TESTING.md). Security and secret boundaries are in [Security](SECURITY.md).
