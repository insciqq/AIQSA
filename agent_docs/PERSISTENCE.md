---
paths:
  - "prisma/**"
  - "lib/server/retention/**"
  - "lib/server/bootstrap/**"
  - "lib/server/storageMigration/**"
  - "aiqsa.sh"
---
# Persistence

Durable state: the PostgreSQL schema and migrations (`prisma/schema.prisma`, `prisma/migrations/`), bootstrap (`prisma/bootstrap.ts`, `lib/server/bootstrap/`), object storage, recovery state, retention, deletion, and single-host backup and restore (`aiqsa.sh`). The schema and committed migrations are the exact inventory of what is stored; do not describe tables in prose.

## Authority

- PostgreSQL is the authority for ownership, control state, accepted bindings, recovery and outputs. Object storage holds bytes, but relational rows decide who may read them and how long they live. Workspace guest disks are operational state: they are not backed up, and rebuilds never repair canonical rows from them.
- Enforce tenant consistency in the database (composite keys that carry the owner) wherever it can be expressed. Keep the custom checks and deferred triggers that guard what relations cannot express, because raw SQL workers and destructive handlers bypass application code; simplify them only in forward migrations that tests prove.
- The Memory history and round source guards validate each chat once per batch of deferred events. Every table their asserts read must carry the statement-level trigger that forgets checked keys, or a later write in the same batch escapes validation (`prisma/migrations/20261005180000_memory_source_guard_once_per_batch/migration.sql`).
- Accepted revisions, bindings, generations and recovery evidence are immutable and protected by restrictive references while referenced. Skill revisions and bundle objects are append-only.
- To retire stored data: remove the projections that read it, prove recovery no longer needs it, stop writes, then drop it in a forward migration. Retired values stay readable only where history or recovery needs them; new work never writes them. Answer Review's storage (decision 2026-10-25) has no writer: only the legacy collapse reads its sessions (`lib/domain/answerReviewTranscript.ts`), and its unread columns are dropped in a later release.
- Projects and Knowledge were removed together with their data (operator decisions 2026-10-23). v0.4.0 fenced every Project for deletion and deleted Projects and Knowledge through their own deletion paths; v0.4.4 drops their tables with the routines and types only they used (`prisma/migrations/20261025092000_drop_projects_knowledge/migration.sql`, decision 2026-10-25). The always-null Project columns of chats, messages, files, uploads, shares and usage stay, because core integrity routines still name them; a null check guards each, except in a table a missed retirement left Project rows in, where it would refuse every later write of those rows. The historical Knowledge columns of usage stay with their records.

## Ownership rules that are easy to get wrong

- Deleting an account removes its group memberships; nullable actor references keep history readable.
- Publishing a Skill grants future use only; accepted revisions survive unpublication and deletion. Deleting an Assistant clears run and chat references but keeps their snapshots.
- Removing a personal saved file keeps copies already admitted into chats. Temporary chat attachments never become personal files implicitly. Artifact deduplication is scoped to one owner.
- The protected `Full access` group gives its explicit members every current and future active provider connection, answer model and Search source; its name and lifecycle cannot change. MCP servers are never included implicitly and the group never confers personal identity or secrets.
- A research frame's `continuedFromRunId` lets a Continue reach the interrupted run's records. Its key carries the owner and the chat but cannot say the branch, so only the server's own check at the Continue writes it, once, and a reader walks only from the current run under a bound. Deleting the earlier run takes its rows and clears only this column, as it does a later run's correction or page reference: a plain `SET NULL` would null the required owner columns too, so these keys are column-scoped.

## Recovery and derived state

- Release database locks before guest or file I/O.
- A side-effecting call whose outcome is unknown stays unknown, after recovery and after a restore (`agent_docs/RUN_CONTRACTS.md`).
- Derived Memory and history data re-proves owner, source, lifecycle and generation authority when used, including during purge. Projection and deletion obligations outlive their source, so a stale retry cannot resurrect deleted content.
- Index replacement keeps the serving index until the new one passes a full integrity proof. A Memory cutover switches one immutable generation, never repairing pointers piecemeal.
- Workspace originals and outputs survive runtime loss. Expiry or cancellation does not prove cleanup, so uncertainty blocks the session. Completed exports never downgrade, and lack of capacity may reject an export but never evicts another answer's files.

## Migrations And Bootstrap

- Compatibility is owed to the two production installations (root `AGENTS.md`). Each upgrades from the release it runs with `docker compose pull && docker compose up -d` (or `./aiqsa.sh upgrade`). Forward migrations preserve operator data, credentials and configuration, and tolerate the previous release's writers while Compose replaces containers. A destructive or incompatible change needs an explicit operator decision and its own documented procedure. Other installations, development databases and fixtures need no bridges.
- The native agent engine replaced the old run core (decision 2026-10-23). `ModelRun.engine` tells the old core's rows apart: their answers stay readable, and a run it left active ends at startup, or once its chat opens or its user sends (`lib/server/runs/retiredEngineRuns.ts`).
- v0.4.4 drops the storage the removed features left behind: the Codex Agent's, the Memory lexical projection's, the old core's `MemoryToolEgressReceipt` and every Project and Knowledge table (decision 2026-10-25). Earlier images still name some of it, their bootstrap included, so after that upgrade going back to one means restoring the backup taken before it.
- `prisma/migrations/20260815000000_baseline` is the immutable first migration and holds custom PostgreSQL DDL that Prisma cannot reconstruct. Every change is a new migration; never edit a committed one. Installations use `prisma migrate deploy`, never `prisma db push`.
- Every schema change ships a forward migration and updates bootstrap, seed and integrity checks when their assumptions change.
- Build an index on a large live table with `CREATE INDEX CONCURRENTLY` as the only statement in its migration file, so writers keep working during the upgrade. Prisma sends a file as one simple query, and PostgreSQL refuses `CONCURRENTLY` inside the implicit transaction of a multi-statement query. A failed concurrent build leaves an invalid index and a failed migration; the operator drops the index and marks the migration rolled back before deploying again.
- Bootstrap accepts only an empty schema or the exact adopted administrator identity and refuses any other non-empty database before changing it. It creates no demo content or real provider deployments; reruns repair code-owned foundations but keep operator identity, credentials, settings, grants and content.
- Upgrade adoptions of earlier configuration run once; later administrator edits stay independent of them.
- After the installation exists, bootstrap brings the release's shipped Skills in line (`lib/server/bootstrap/shippedSkills.ts`): unchanged text writes nothing, changed text appends a revision, and a key no longer shipped is retired like a deleted Skill, history kept. They carry text files only, since migrate-bootstrap has no object storage. Accepted risk (2026-11-06): an earlier image cannot read an ownerless Skill an Assistant links, so going back after this release means restoring the backup taken before it, as for v0.4.4. Likewise an earlier image cannot read the `COMPUTER_OUTPUT` attachment origin (`prisma/migrations/20261107130000_computer_output_attachments/migration.sql`).
- A scheduled task's schedule columns stay required (decision 2026-10-25): a webhook-only task keeps the editor's schedule with `scheduleEnabled` off, and a check keeps its next run null, so existing rows needed no backfill and the previous release's writers, which never fire a task without a next run, stay safe during the upgrade (`prisma/migrations/20261025120000_automation_webhooks/migration.sql`).
- Migrations from the baseline on use column-scoped `ON DELETE SET NULL (column)`, the research contract's among them (`prisma/migrations/20261101140000_research_system_contract/migration.sql`), so a key that carries the owner and the chat clears only its own column. That needs PostgreSQL 15 or later, and both Compose files pin 18. `prisma/schema.prisma` cannot express it, so a `migrate diff` shows that drift by design, and no migration should chase it.

## Deletion

- Deletion first fences future admission, recall and sharing and records a durable obligation, then acknowledges. Handlers reauthorize the exact aggregate, settle active work and retry idempotently; an obligation an administrator blocked waits, it is never abandoned.
- Object deletion rechecks every reference before removing bytes; the application drains due deletions itself.
- `npm run prune -- --dry-run` is read-only and comes before any explicitly authorized `--execute`. Pruning never touches active sessions or runs, evidence still visible to retrieval, or referenced objects.
- Account deletion drains personal MCP servers and owned Memory before deleting their parents, and stays pending until then. Disconnecting a personal MCP server wipes its saved values immediately. Revoking an inbound Memory OAuth grant keeps the facts.
- A missing Workspace disk is recreated from canonical originals and the UI never claims the old files survived.
- Data already sent to external providers or tools, and their own retention and backups, are outside the application's erasure claims.

## Retention decisions

Cutoffs and batch sizes live in code; these are the product decisions behind them.

- Deleting chats never resets spend: chat deletion and Temporary chat expiry keep usage and only detach run and Memory links. Usage limits gate admission, not spend; accepted runs finish and system work is never blocked.
- A scheduled task's history retention deletes only chats its runs created and the owner never touched or kept, through the ordinary permanent-deletion path (`lib/server/scheduledTasks/historyRetention.ts`). Deleting the task makes its chats ordinary.
- A webhook event keeps its body only until its run is admitted, after which the body lives only in that chat under the task's history retention, or until it is discarded because it can no longer run; it never runs later. The bodyless row stays seven days for deduplication and the rate cap (decision 2026-10-25, `lib/contracts/scheduledTasks.ts`). The webhook and its events go with the task and the account.
- Operator telemetry has no foreign key to users; deleting an account clears its id from incidents in the same transaction.
- An answer problem report stores a reason and an optional comment, never the question or answer, and disappears with the answer, chat or reporting account.
- Discord (owner decisions 2026-11-12): a question's row, its claim and content-free journal, lives 90 days with its ratings; a revoked monitoring key 30 days (`lib/server/discord/store/retention.ts`). Conversations and their chats are never deleted automatically, and a question deleted in Discord removes only the bot's answer there, never the turn in AIQSA. Deleting the service account takes its Discord chats with it.
- Research evidence, stored pages and frames live with their run (operator decision 2026-11-01): they go with it, and so with the branch, the chat and the account, through their keys and with no job, cutoff or switch of their own. While the run lives nothing deletes a record.
- Stored pages are the one large thing here, and they sit in PostgreSQL rather than object storage so they go with the run in one transaction. `RESEARCH_PAGE_LIMITS` bounds them; most pages are tens of KB, so a run usually keeps a few MB, and the database compresses long text. They stay as long as the chat does and every backup carries them, so an installation that researches daily should watch the size of `ResearchPage`; deleting chats is what frees it.

## Backup and restore

`./aiqsa.sh backup` and `./aiqsa.sh restore` provide single-host cold backup and empty-target restore.

- Backup stops every writer, fences claimed Memory and object-deletion work, copies PostgreSQL and private objects together, records the schema and the non-secret Memory key ids restore needs, and restarts exactly the writers it stopped. Keys from `.env` are backed up separately (`agent_docs/ENV_VARIABLES.md`).
- Restore fills only an empty installation of the same version, through an isolated `aiqsa-restore-*` project with no published ports and no application writer, after preflighting format, schema, identities, keys and objects. Memory deletion reconciliation (`npm run memory:restore:reconcile`) must pass before any application role starts. Nothing cuts over a running installation automatically.
- Restore clears guest disks and runtime identities and resets Workspace sessions so new runs restage originals.
