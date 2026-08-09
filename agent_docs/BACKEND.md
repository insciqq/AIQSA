# BACKEND

Owner: Backend contract router
Scope: Non-normative router to current API, persistence, run, and provider owners; executable inventories are generated from source.

This file is a router, not a second endpoint or schema manifest. Read only the owner needed for the change:

- [API and auth behavior](backend/API_AND_AUTH.md) — routing index for route families and observable state-transition owners.
- [Persistence and retention](backend/PERSISTENCE_AND_RETENTION.md) — cross-table constraints, migrations, retention, and deletion ownership.
- [Native Memory](backend/MEMORY.md) — approved target terminology, correctness fences, lifecycle/privacy contract, bounded ownership, and explicit not-yet-implemented status.
- [Runs and streaming](backend/RUNS_AND_STREAMING.md) — context replay, visible answers, SSE, cancellation, usage, and cost.
- [Provider adapters](backend/PROVIDER_ADAPTERS.md) — routing index for current provider runtime behavior, shared boundaries, and provider-specific defaults.
- [Generated API and schema reference](generated/API_AND_SCHEMA.md) — route methods plus Prisma model/enum names; regenerate rather than editing it.
- [Security](SECURITY.md) — threat, privacy, auth, secret, network, and exposure boundaries.
- [Run pipeline](RUN_PIPELINE.md) — product-level message, optional Search/tool, response, evidence, and sharing semantics.

Installation model-policy ownership crosses three bounded owners: administrator
set/clear behavior belongs to the provider control plane, durable singleton and
deletion constraints belong to persistence, and exact credential-bearing
resolution belongs to provider admission. The installation default remains a
user recommendation; the system utility role is a separate internal-only
selection and grants no entitlement.

Executable routes, Prisma schema, and tests remain authoritative for exact code shape. Living backend contracts describe only the current implementation; rationale that must survive belongs beside the current rule in its owner.
