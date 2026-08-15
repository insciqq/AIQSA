# AGENTS

Scope: `prisma/**` schema, migrations, bootstrap/seed, integrity, and migration-contract fixtures.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/backend/PERSISTENCE_AND_RETENTION.md`, `ARCHITECTURE.md`, `SECURITY.md`, and the migration lane in `TESTING.md` before changing durable state.

- Every schema change ships a forward migration and updates bootstrap/seed/integrity contracts when their assumptions change.
- Preserve existing rows and accepted compatibility semantics unless the operator explicitly authorizes a destructive cutover.
- Never run migration, seed, prune, or reset commands against the default persistent installation during development.
- Regenerate the API/schema reference after schema changes; do not hand-edit its output.
- Verify with the clean-install migration contract and disposable Compose parity lane required by `TESTING.md`.
