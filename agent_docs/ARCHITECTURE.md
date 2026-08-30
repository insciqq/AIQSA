# ARCHITECTURE

Owner: System architecture maintainers
Scope: Dependency direction, supported deployment shape, durable data/egress boundaries, and architectural prohibitions. Exact modules, services, adapters, and runtime flows belong to executable artifacts.

## Architectural Stance

AIQSA is a TypeScript/Node.js Next.js modular monolith. Browser rendering, authenticated HTTP entry points, domain logic, persistence, and external-service adapters ship as one application rather than independently deployed frontend and backend services. PostgreSQL/Prisma owns relational state, private S3-compatible object storage owns attachment and Knowledge bytes, and OpenSearch holds only a rebuildable Knowledge passage-lexical projection.

The supported production shape is one hardened, single-host, single-replica Compose installation for authenticated users in an operator-managed organization. Multi-replica/HA operation and a separately deployed application backend are unsupported. Revisit admission, scheduling, state ownership, and failure recovery before accepting untrusted external tenancy, promising spend/latency guarantees, or adding replicas.

## Dependency Direction

```text
browser UI
  -> client-safe contracts and API clients
  -> thin authenticated route handlers
  -> provider-neutral domain and server orchestration
  -> repositories or bounded external adapters
  -> PostgreSQL, private object storage, or reviewed egress
```

- `components/` and browser code may depend on client-safe contracts, never server modules, Prisma, credentials, Node-only APIs, or provider transports.
- `lib/contracts/` is a dependency leaf for explicit client-safe wire shapes. `lib/domain/` remains provider-neutral and free of runtime/framework consumers.
- Route handlers authenticate, validate, and compose boundaries; reusable behavior lives below the route file.
- Repositories own durable-state access. Provider, Search, embedding, MCP, storage, and parsing wire formats remain inside server adapters and do not leak into browser contracts or neutral domain rules.
- Dependencies point inward toward contracts and pure rules. A lower layer does not import its route, UI, or runtime consumer.

The enforceable owners are [ESLint configuration](../eslint.config.mjs), the [architecture-boundary checker](../scripts/eslint/architecture-boundaries.mjs), its [focused tests](../scripts/eslint/architecture-boundaries.test.ts), and the imports in [`app/`](../app/), [`components/`](../components/), and [`lib/`](../lib/).

## Supported Deployment Shape

- [`docker-compose.yml`](../docker-compose.yml) is the persistent single-host installation. Its databases, object storage, and other stateful volumes survive normal image replacement; committed migrations and bootstrap establish relational state before dependent roles become ready.
- [`docker-compose.dev.yml`](../docker-compose.dev.yml) is the disposable development and integration topology. It is never a preservation or recovery target and must not share state with the persistent installation.
- The application is the only public application boundary. PostgreSQL, OpenSearch, object storage, parser sidecars, ToolHive control/proxies, and sibling workloads remain on private networks without direct host publication. Default publication and supported proxy/identity choices are constrained by [Environment](ENV_VARIABLES.md) and [Security](SECURITY.md).
- Sidecars are bounded helpers, not owners of application tenancy or durable product state. Optional provider, Search, SMTP, MCP, parser, release-awareness, and Memory failures remain feature-local unless an explicit contract changes core readiness. OpenSearch is an explicit Knowledge-only dependency: its absence does not replace PostgreSQL as application authority or stop unrelated product areas, but passage retrieval fails closed instead of selecting another lexical backend. Knowledge parsing may try only the canonical format route's bounded parser sequence; availability and quality outcomes may select a fallback, while tenant authority and durable settlement remain in the application.
- Live cancellation and external sessions are process-local. Durable accepted state and recovery data live in PostgreSQL, but process ownership does not cross replicas; this is why multi-replica operation is not supported.

Executable deployment owners are [Compose](../docker-compose.yml), [development Compose](../docker-compose.dev.yml), the [runtime image](../Dockerfile), committed [`ops/`](../ops/) scripts, and installation-focused tests beside them.

## Data And Egress Boundaries

| Boundary | Durable rule | Executable owner |
| --- | --- | --- |
| PostgreSQL | Owns authenticated tenancy, mutable control state, conversation/run graphs, immutable accepted bindings, recovery checkpoints, lifecycle metadata, and user-visible output records. | [Prisma schema](../prisma/schema.prisma) and [migrations](../prisma/migrations/) |
| OpenSearch | Holds the versioned, rebuildable BM25 passage projection. It returns bounded identities and scores only; PostgreSQL revalidates owner, scope, artifact, content, and citation authority before admission. | [OpenSearch contract](../lib/server/search/opensearch/contract.ts), [transport](../lib/server/search/opensearch/transport.ts), and [projection lifecycle](../lib/server/knowledge/searchProjection.ts) |
| Knowledge identity | A Source and its immutable Versions/artifacts are reusable owner-scoped content identity; a Base is membership and retrieval scope, and accepted scope is an immutable exact-ready snapshot rather than a live membership query. | [Knowledge persistence](../lib/server/knowledge/sourcePersistence.ts), [Prisma schema](../prisma/schema.prisma), and stateful tests |
| Private object storage | Owns attachment and Knowledge object bytes behind relational ownership/lifecycle references; it is not a public file host. An explicitly configured browser-reachable endpoint may receive only short-lived object-specific multipart uploads; server settlement remains the authority before bytes become a Source. | [Compose storage wiring](../docker-compose.yml), server storage code, and focused tests |
| Browser boundary | Receives explicit allowlisted projections only. Repository objects, credentials, raw upstream payloads, internal event histories, retrieval internals, and tool traces do not become client contracts by existing. | [`lib/contracts/`](../lib/contracts/) and route/component tests |
| Provider, Search, and embedding egress | Leaves the server only through bounded adapters after authorization and validation. Embedding/indexing is a distinct egress from answer generation and is governed by an administrator-activated installation Knowledge Profile rather than ordinary browser selection. | [`lib/server/`](../lib/server/) adapters and focused tests |
| MCP egress | Uses reviewed remote MCP or the private ToolHive boundary; MCP authorization grants no unrelated provider or application-data authority. | Server MCP code, Compose/ToolHive wiring, and focused tests |
| Parser egress | Receives only bounded document work over a private network and has no database, object-storage, or tenancy credentials and no durable document state. | Parser code, [`ops/docling/`](../ops/docling/), Compose, and focused tests |

No new external destination, credential audience, public projection, or durable store is implicit. Adding one requires an explicit data/egress boundary and the applicable privacy, failure, retention, and operator controls.

## Architectural Prohibitions

- Do not split a microservice, separate frontend/backend runtime, remote control plane, or dedicated tool host without a measured blocker and an explicit design for authentication, data ownership, networking, deployment, recovery, and observability.
- Do not let browsers or sidecars become entitlement, credential-selection, persistence, or provider-transport authorities.
- Do not expose a private service merely to simplify local wiring, and do not make an optional integration a core readiness dependency accidentally.
- Do not mix disposable verification state with the persistent installation.
- Do not duplicate executable inventories or runtime-flow narration in this document. Link the owning source, schema, migration, configuration, or test instead.

Subject semantics and operations route to [Backend](BACKEND.md), [Persistence](PERSISTENCE.md), [Run contracts](RUN_CONTRACTS.md), [Providers](PROVIDERS.md), [Frontend](FRONTEND.md), [Environment](ENV_VARIABLES.md), [Security](SECURITY.md), and [Testing](TESTING.md). Those documents constrain non-derivable behavior and boundaries; executable artifacts remain the exact implementation record.
