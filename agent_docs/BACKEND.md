# BACKEND

Owner: Backend contract router
Scope: Reading map for current API, persistence, run, and provider behavior; executable route and schema inventories are generated from source.
Verified against: 4f51fdd (2026-08-01)

This file is a router, not a second endpoint or schema manifest. Read only the owner needed for the change:

- [API and auth behavior](backend/API_AND_AUTH.md) — route families and observable state transitions.
- [Persistence and retention](backend/PERSISTENCE_AND_RETENTION.md) — cross-table constraints, migrations, retention, and deletion ownership.
- [Runs and streaming](backend/RUNS_AND_STREAMING.md) — context replay, visible answers, SSE, cancellation, usage, and cost.
- [Provider adapters](backend/PROVIDER_ADAPTERS.md) — current internal provider behavior and defaults.
- [Generated API and schema reference](generated/API_AND_SCHEMA.md) — route methods plus Prisma model/enum names; regenerate rather than editing it.
- [Security](SECURITY.md) — threat, privacy, auth, secret, network, and exposure boundaries.
- [QSA pipeline](QSA_PIPELINE.md) — product-level Question → Search → Answer semantics.

Executable routes, Prisma schema, and tests remain authoritative for exact code shape. Accepted ADRs own historical rationale; living backend contracts describe only the current implementation.
