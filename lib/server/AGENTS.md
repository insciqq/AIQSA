# AGENTS

Scope: `lib/server/**` server-only policy, handlers, repositories, adapters, and runtime orchestration.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Use `agent_docs/BACKEND.md` to select only the API, persistence, run, or provider contract needed here; add `SECURITY.md`, `RUN_PIPELINE.md`, `ENV_VARIABLES.md`, or `PROVIDER_API_NOTES.md` when that boundary changes.

- Keep route entry points thin and keep provider, storage, Prisma, and secret authority server-only.
- Validate untrusted input before mutation or external I/O; preserve auth, ownership, entitlement, redaction, and cancellation contracts.
- Put pure shared wire/domain rules in their existing leaf owners rather than importing server code into them.
- Run the smallest focused server tests, then the proportional hermetic or container lane from `agent_docs/TESTING.md`.
- Schema or migration work also follows `prisma/AGENTS.md`.
