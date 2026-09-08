# ARCHITECTURE

Owner: System architecture maintainers
Scope: Dependency direction, deployment shape, and data/egress ownership.

## Architectural Stance

AIQSA is a Next.js modular monolith for authenticated users in an operator-managed organization. The supported production shape is one hardened, single-host, single-replica Compose installation. Process-local cancellation and external sessions do not support replica handover. Revisit admission, scheduling, recovery, and isolation before adding replicas, untrusted tenancy, or spend/latency guarantees.

Do not split services or introduce a remote control plane without a measured blocker and an explicit design for authentication, ownership, networking, deployment, recovery, and observability.

## Dependency Direction

Browser UI → client-safe contracts/API clients → authenticated routes → provider-neutral domain/server orchestration → repositories and bounded adapters.

Browser code cannot import server modules, Prisma, credentials, Node-only APIs, or provider transports. Contracts are a dependency leaf; domain rules do not import framework/runtime consumers. Routes compose boundaries; reusable behavior belongs below them. Repositories own durable access and adapters contain external wire formats. Lower layers never import their UI, route, or runtime consumers.

Enforcement: [ESLint](../eslint.config.mjs), [boundary checker](../scripts/eslint/architecture-boundaries.mjs), and imports in [`lib/`](../lib/), [`app/`](../app/), and [`components/`](../components/).

## Supported Deployment Shape

Application code, images, committed migrations, bootstrap, and disposable development belong here. Production Compose, proxies, deployment, secrets, schedules, and backup/restore orchestration belong to the separate infrastructure workspace; do not reintroduce them as application-repository tooling. Infrastructure runs migrations/bootstrap before dependent roles.

[`docker-compose.dev.yml`](../docker-compose.dev.yml) is disposable and must never share persistent-installation state. The application is the public application boundary; data services, parsers, controllers, and sibling workloads stay private. Publication and proxy rules belong to [Environment](ENV_VARIABLES.md) and [Security](SECURITY.md).

Sidecars are bounded helpers, never tenancy or durable-state authorities. Optional integration failures remain feature-local unless an explicit contract makes them core readiness dependencies. The Workspace runner owns only guest lifecycle/tool transport; the app retains admission, storage, recovery, and presentation authority. Runtime build owners are [Dockerfile](../Dockerfile) and [`ops/`](../ops/).

## Data And Egress Boundaries

- PostgreSQL is canonical for ownership, control state, accepted bindings, recovery, and output records; [schema and migrations](../prisma/) own exact storage.
- Private object storage owns originals and exported bytes; relational references govern access and lifetime. It is not a public file host.
- OpenSearch is a rebuildable candidate projection, never canonical content or authority. PostgreSQL reauthorizes every hit. Knowledge passage retrieval has no alternate lexical backend; Memory fallback/rollout belongs to [Memory](MEMORY.md) and [Environment](ENV_VARIABLES.md).
- Browsers receive explicit allowlisted projections. Storage objects and upstream formats do not become client contracts by existing.
- External I/O crosses authorized, bounded server adapters. Knowledge embedding/indexing has an independently disclosed installation-profile destination; answer-model selection does not authorize it.
- Parsers receive bounded documents without data credentials or durable document state. Workspace receives opaque runtime identity, bounded streams, and allowlisted tools, never application/data credentials. Guest disks are operational state outside backup authority.

No new destination, credential audience, public projection, or durable store is implicit: define its privacy, failure, retention, and operator boundary. Execution semantics belong to [Run contracts](RUN_CONTRACTS.md); lifecycle and recovery operations belong to [Persistence](PERSISTENCE.md).
