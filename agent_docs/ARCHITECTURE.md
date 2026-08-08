# ARCHITECTURE

Owner: System architecture maintainers
Scope: Current process topology, module dependency direction, durable data boundaries, and supported deployment shape; behavior details remain with subject owners.

## Ownership

AIQSA is a TypeScript/Node.js Next.js modular monolith for a self-hosted installation. The supported topology is a hardened single-host, single-replica runtime. Before broad real-user exposure it still lacks shared-provider quotas, per-user pressure limits, general observability, and completed 50-user load evidence.

Do not split a separate backend, frontend runtime, or microservice without a measured blocker that cannot be solved within this boundary. API behavior is routed by `BACKEND.md`, UI behavior by `FRONTEND.md`, deployment configuration belongs to `ENV_VARIABLES.md`, and security/exposure rules are routed by `SECURITY.md`.

## System Shape

```text
browser
  -> Next.js pages/layouts + React components
     -> client stores/actions + wire decoders
  -> Next.js route handlers
     -> auth + domain/handler boundaries
     -> repositories -> Prisma -> Postgres
     -> uploads -> private S3/MinIO (filesystem fallback outside bundled stack)
     -> bounded document parser adapter -> private Docling/Tika sidecars
     -> provider/Search adapters -> external APIs
     -> remote MCP or private ToolHive proxy -> sibling stdio MCP workload
```

### Primary layers

| Layer | Stable responsibility |
| --- | --- |
| `app/` | Page/layout composition and thin HTTP entry points. |
| `components/` | Browser rendering, interaction, and feature state; no server repositories, secrets, or provider transports. |
| `lib/contracts/` | Client-safe shared wire types and runtime decoders; a dependency leaf. |
| `lib/domain/` | Provider-neutral pure rules and transformations. |
| `lib/server/` | Auth, repositories, storage, run orchestration, provider/Search/MCP adapters, and other Node-only work. |
| `prisma/` | Schema, immutable applied migrations, bootstrap, and deterministic test seed. |

Route handlers resolve runtime dependencies and compose handler/repository/adapter boundaries. Business behavior belongs below the route file. Provider wire shapes stay inside server adapters; React never calls a provider directly. Shared contracts flow into domain/server/browser consumers without importing those consumers back.

The dependency rules are executable in `eslint.config.mjs` and `tests/harness/import-boundaries.test.ts`: browser components cannot import server/Prisma/Node-only modules, shared contracts and pure domain code cannot depend on consumers or runtime frameworks, API routes cannot import browser components, provider adapters remain Prisma-free, and the Chat shell cannot depend on Control Center internals.

### Server control planes

- `lib/server/auth/` owns sessions, admission, user/group entitlements, and the built-in `full_access` semantic wildcard. Entitlement never selects a credential; direct-user, active-group, and permitted default credential precedence remains a separate pure/domain and runtime boundary.
- Administrator provider owners manage mutable connection/model/credential configuration. Provider runtime owns transactional run admission, immutable accepted bindings, credential-version/revocation guards, and adapter construction. Browser contracts expose only write actions and safe metadata.
- Search administration exposes one logical source per exact provider connection and owns the source-level lifecycle; physical hosted/query-only routes retain configuration-evidenced immutable revisions and optional non-gating diagnostics below it. Provider-neutral Search owns typed query-only execution, whole-plan physical-route assignment, fan-out merge, and bounded canonical findings/source evidence supplied explicitly by each adapter. Technical-only provider deployments may support Search while remaining absent from answer-model catalogs.
- MCP owns installation definitions, grants, encrypted configuration/OAuth envelopes, activation jobs, runtime generations, and official SDK/ToolHive adapters. One process-local coordinator advances a database-owned activation job; another reconciles durable desired generations into live sessions. Both fence writes to exact versions/fingerprints. Remote traffic uses the SSRF-safe fetch boundary; local stdio uses ToolHive sibling workloads on the private control network.
- `lib/server/parsing/` owns the optional file-to-structured-text boundary. Plain text, Markdown, CSV, and JSON remain in-process; structure-aware PDF/OOXML/HTML/image work routes to Docling first with Tika fallback, while Tika owns legacy office/mail/ebook formats. Its ordered page-anchored blocks are a consumer-neutral contract; upload/chat and Knowledge ingestion wire to it only through their own later lifecycle owners.
- A remote MCP server may broker another SaaS authorization flow, but AIQSA authorizes only the reviewed MCP resource and stores only MCP-audienced per-user tokens. It has no provider-specific upstream callback, secret, scope, organization, or persistence authority.
- SMTP is an independent database-owned draft/test/active control plane with bounded delivery. Release awareness is a separate optional read-only boundary fixed to the official public AIQSA release endpoint; it cannot deploy or mutate installation state.

Exact handler, repository, and adapter names remain discoverable from source and focused tests rather than duplicated here.

## Runtime And Deployment Boundary

Docker Compose is the supported local and single-host topology:

- `docker-compose.yml` owns the persistent operator installation. One published non-root image supplies the standalone app, one-shot migration/bootstrap, and profiled maintenance commands alongside internal Postgres, MinIO/bucket initialization, pinned ToolHive control, and digest-pinned stateless Docling/Tika parsers. The app role starts the generated Next standalone server through a repository-owned one-shot launcher that authenticates the immediate TCP peer before framework request conversion; other image roles override that command.
- The release pipeline owns one pgvector-capable Postgres companion image: it preserves the exact pinned Postgres 16 Alpine base, compiles checksum-pinned pgvector source on native amd64 and arm64 runners, and publishes one verified multi-platform manifest. Compose may adopt that image only by its immutable manifest digest. Replacing the container image does not add a database, move the named volume, or activate the extension; committed schema migrations own extension activation.
- Migration/bootstrap applies committed migrations and the idempotent fail-closed installation bootstrap before app readiness. Retention and other maintenance roles use explicit command overrides and role-specific environment.
- Named Postgres, MinIO, and ToolHive volumes preserve relational data, private objects, and disposable MCP runtime state across normal image updates.
- `docker-compose.dev.yml` owns bind-mounted deterministic development/test execution and separate disposable volumes. Development verification may mutate only this named stack and has no preservation, crash-recovery, or parallel-run guarantee.
- Only ToolHive mounts the host Docker socket. The app reaches its control/proxy endpoints on a private network; a profiled cleanup role may manage only exact AIQSA-owned workloads.
- Docling and Tika share only the private `parser-control` network with the app, receive no storage/database credentials or volumes, and have explicit CPU, memory, temporary-filesystem, health, restart, and log bounds. They are not app startup dependencies and own no document or tenancy state.

The default app publication is loopback HTTP and requires no domain, active provider, SMTP, OAuth, reverse proxy, or reachable GitHub API. Direct non-loopback HTTP is also supported for an operator-selected trusted LAN/VPN: the release launcher authenticates the immediate socket peer with process-local material and forwarding headers remain untrusted. HTTPS requires the supported loopback-reached TLS proxy declaration; contradictory identity topology fails both readiness and auth admission. Postgres, MinIO, ToolHive, parser sidecars, and MCP proxies have no host publication.

Process liveness is separate from readiness. Readiness checks explicit runtime security configuration, Postgres, and private object storage; provider, SMTP, MCP/ToolHive, parser-sidecar, and release-awareness failures remain feature-local.

Installation state relies on stable volumes, coordinated pre-migration backup, committed `prisma migrate deploy` migrations, guarded restore, and versioned/commit-tagged unified images. `ops/backup/` owns the write-quiesced database/object backup and disposable-target restore verification; `ops/nginx/` owns the optional SSE/upload-aware TLS proxy template.

Live run cancellation and MCP sessions are process-local. Durable run status, per-chat active-run uniqueness, activation jobs, desired MCP generations, and evidence survive restart; live abort/session ownership does not cross replicas. Multi-replica/HA operation is unsupported.

## Persistence And Durable Ownership

Postgres/Prisma is authoritative for:

- users, identities, sessions, auth admission, groups, grants, and invitations;
- folders, chats, message DAGs, settings state, Assistant definitions/revisions/publications/pins, runs, events, usage, and immutable accepted bindings;
- provider/model/credential, Search, SMTP, and MCP control planes;
- MCP activation/runtime evidence, upload metadata/cleanup work, and public-share snapshots.

Private objects live in S3/MinIO in the bundled stack. A filesystem fallback exists only when S3 is absent outside that topology.

At the architecture layer, Postgres owns authenticated relational tenancy,
mutable control-plane state, conversation/run graphs, and immutable accepted
evidence; private object storage owns attachment bytes behind those relational
references. Browser input never becomes ownership or entitlement authority, and
external payloads cross into durable state only through a bounded normalized
projection. `CRITICAL_INVARIANTS.md` owns the cross-cutting safety outcomes;
the persistence, API, run, and security owners below own their exact mechanics.

Exact schema constraints, migration policy, retention, branch repair, usage accounting, upload cleanup, and share sanitization live in `backend/PERSISTENCE_AND_RETENTION.md`. Applied migrations are historical artifacts and are not rewritten to refresh current prose.

## Run Architecture

```text
authenticated mutation
  -> ownership/catalog/control/attachment validation
  -> trusted branch context + context budget
  -> immutable provider-neutral prepared snapshot
  -> atomic run graph + accepted bindings
  -> provider/Search/MCP execution
  -> normalized SSE + bounded durable evidence
  -> status-guarded finalization
  -> source-keyed browser reconciliation
```

### Preparation and admission

Send and regenerate cross one server-only preparation boundary between thin
authenticated route handlers and persistence/execution. It produces a frozen
provider-neutral plain-data snapshot; persistence and execution receive
isolated materializations and never rebuild accepted input from mutable browser
or control-plane state.

The atomic run graph binds every accepted logical choice to the immutable
provider, Search, credential, and MCP identities required for continuation and
recovery. [API state transitions](backend/api/CATALOG_CHATS_AND_RUNS.md) own the
exact validation/commit sequence, [Search plans](run_pipeline/SEARCH_PLANS.md)
own physical-route assignment, and [provider admission](backend/providers/ADMISSION_AND_BINDINGS.md)
owns credential and deployment binding mechanics.

### Execution, tools, and recovery

Foreground execution owns provider/tool dispatch, normalized live events,
batched persistence, transient chat synchronization, and process-local
cancellation. One provider-neutral continuation owner coordinates Search and
MCP while adapters remain limited to wire/transport/parser translation.

Recovery reconstructs work from durable accepted bindings, checkpoints, and
evidence; live controllers and provider sessions remain process-local. Exact
batch persistence, outcome-unknown handling, terminal settlement, and
provider-specific live-only exceptions are owned by the routed run and provider
contracts rather than repeated in this topology map.

`backend/RUNS_AND_STREAMING.md` owns exact lifecycle, cancellation, event, context, usage, and cost semantics. The bounded owners routed by `backend/PROVIDER_ADAPTERS.md` own provider-specific behavior. Bounded owners routed by `RUN_PIPELINE.md` own product-level run meaning.

## Frontend Boundary

The browser maintains strict summary/detail separation:

- workspace state contains lightweight summaries only;
- keyed thread state contains messages, active leaf, usage, and branch snapshots;
- keyed run-surface state contains compacted Events and persisted inspection;
- keyed composer sessions contain draft/edit/attachment and async-operation ownership;
- next-run controls and overlay/menu state remain in focused owners.

Every async producer captures its source chat/session before awaiting. Optimistic rows, ID adoption, token flushes, errors, persisted refresh, and terminal updates affect only that source. Cached inactive state survives navigation, and stale responses merge without overwriting concurrent user/stream work.

`PowerAppShell` composes exactly seven semantic view contracts and does not pass a root setter bag. `frontend/IMPLEMENTATION_STATE.md` owns exact state boundaries; other frontend behavior routes through `FRONTEND.md`. Theme remains browser-local with cookie-backed server first paint.

## Change Rules

- Preserve dependency direction and keep server-only code out of client bundles.
- Extend existing domain, handler, repository, adapter, or coordinator boundaries before inventing another runtime.
- Keep each change as a runnable or clearly verifiable vertical slice.
- Directly test cross-user ownership, terminal settlement, migrations, uploads, shares, secret handling, and publication safeguards.
- Update this document only for topology, stable module ownership, dependency direction, deployment/process shape, or durable data-boundary changes. Do not add exhaustive module or run-engine narration already owned by source/tests.
