# AGENTS

Scope: `lib/server/**` server-only policy, handlers, repositories, adapters, and runtime orchestration.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/BACKEND.md`, then only the crossed owner among `PERSISTENCE.md`, `RUN_CONTRACTS.md`, `PROVIDERS.md`, `MEMORY.md`, `SECURITY.md`, and `ENV_VARIABLES.md`.

- Keep route entry points thin and keep provider, storage, Prisma, and secret authority server-only.
- Validate untrusted input before mutation or external I/O; preserve auth, ownership, entitlement, redaction, and cancellation contracts.
- Put pure shared wire/domain rules in their existing leaf owners rather than importing server code into them.
- Run the smallest focused server tests, then the proportional hermetic or container lane from `agent_docs/TESTING.md`.
- Schema or migration work also follows `prisma/AGENTS.md`.
