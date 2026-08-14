# ARCHITECTURE

Owner: System architecture maintainers
Scope: Current process topology, module dependency direction, durable data boundaries, and supported deployment shape; behavior details remain with subject owners.

## Ownership

AIQSA is a TypeScript/Node.js Next.js modular monolith for an open-source, self-hosted, model-agnostic AI web interface. The supported topology is a hardened single-host, single-replica runtime. Its current capacity policy assumes authenticated, authorized users inside one trusted, operator-managed organization: different-chat runs intentionally have no per-user, installation-wide, or shared-provider admission quota or queue. That absence is an accepted capacity-allocation choice, not an authentication, tenant-isolation, per-request-bound, or same-chat-integrity exception. Operators still observe saturation and tune capacity; reassess admission controls before accepting untrusted or external users, promising contractual spend or latency guarantees, adding multi-replica scheduling, or after measured provider, CPU, memory, or cost contention.

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
- Search administration exposes one logical source per exact provider connection and owns the source-level lifecycle; physical hosted/query-only routes retain configuration-backed immutable revisions and optional non-gating diagnostics below it. Provider-neutral Search owns typed query-only execution, whole-plan physical-route assignment, fan-out merge, and bounded canonical findings and safe citation sources supplied explicitly by each adapter. Technical-only provider deployments may support Search while remaining absent from answer-model catalogs.
- MCP owns installation definitions, grants, encrypted configuration/OAuth envelopes, activation jobs, runtime generations, and official SDK/ToolHive adapters. One process-local coordinator advances a database-owned activation job; another reconciles durable desired generations into live sessions. Both fence writes to exact versions/fingerprints. Remote traffic uses the SSRF-safe fetch boundary; local stdio uses ToolHive sibling workloads on the private control network.
- `lib/server/parsing/` owns the optional file-to-structured-text boundary. Plain text, Markdown, CSV, and JSON remain in-process; structure-aware PDF/OOXML/HTML/image work routes to Docling first with Tika fallback, while Tika owns legacy office/mail/ebook formats. The Docling request explicitly recognizes printed Russian and English text in image regions while preserving usable native PDF text; this is OCR, not semantic understanding of pictures, plots, diagrams, handwriting, or other visual content. Its ordered page-anchored blocks are a consumer-neutral contract; upload/chat and Knowledge ingestion wire to it only through their own later lifecycle owners.
- Knowledge owns private publishable bases, append-only document versions, immutable embedding/index generations, and hybrid relational retrieval storage. Object storage holds originals and normalized text; Postgres holds lifecycle metadata, bounded chunks, vectors, FTS projections, and temporal revision authority. Embedding is a separate disclosed provider-egress boundary outside chat runs.
- A remote MCP server may broker another SaaS authorization flow, but AIQSA authorizes only the reviewed MCP resource and stores only MCP-audienced per-user tokens. It has no provider-specific upstream callback, secret, scope, organization, or persistence authority.
- SMTP is an independent database-owned draft/test/active control plane with bounded delivery. Release awareness is a separate optional read-only boundary fixed to the official public AIQSA release endpoint; it cannot deploy or mutate installation state.

Exact handler, repository, and adapter names remain discoverable from source and focused tests rather than duplicated here.

## Runtime And Deployment Boundary

Docker Compose is the supported local and single-host topology:

- `docker-compose.yml` owns the persistent operator installation. One published non-root image supplies the standalone app, the private no-API Memory worker, one-shot migration/bootstrap, and profiled maintenance commands alongside internal Postgres, MinIO/bucket initialization, pinned ToolHive control, a locally built stateless Docling parser derived from its digest-pinned upstream image plus checksum-pinned offline Russian/English OCR assets, and digest-pinned Tika. The app role starts the generated Next standalone server through a repository-owned one-shot launcher that authenticates the immediate TCP peer before framework request conversion; the worker and one-shot roles override that command. Development embeds the feature-local Memory coordinator in the app process instead of adding a second dev service.
- The release pipeline owns one pgvector-capable Postgres companion image: it preserves the exact pinned Postgres 16 Alpine base, compiles checksum-pinned pgvector source on native amd64 and arm64 runners, and publishes one verified multi-platform manifest. Compose may adopt that image only by its immutable manifest digest. Replacing the container image does not add a database, move the named volume, or activate the extension; committed schema migrations own extension activation.
- Migration/bootstrap applies committed migrations and the idempotent fail-closed installation bootstrap before app readiness or Memory worker startup. Retention and other maintenance roles use explicit command overrides and role-specific environment.
- Named Postgres, MinIO, and ToolHive volumes preserve relational data, private objects, and disposable MCP runtime state across normal image updates.
- `docker-compose.dev.yml` owns bind-mounted deterministic development/test execution and separate disposable volumes. Development verification may mutate only this named stack and has no preservation, crash-recovery, or parallel-run guarantee.
- Only ToolHive mounts the host Docker socket. The app reaches its control/proxy endpoints on a private network; a profiled cleanup role may manage only exact AIQSA-owned workloads.
- The supported ToolHive shape is co-hosted Compose, not an operator-selectable remote URL. A later dedicated tool host is architecturally feasible, but it is a separate deployment slice: the host carries no AIQSA application data; an encrypted private L3 link and firewall expose only an authenticated controller plus a controlled dynamic-proxy port range or gateway; controller and tool traffic are encrypted; ToolHive state and generated npm/PyPI images are migrated or rebuilt; maintenance retains the exact cleanup ownership and deployment encryption key. Host separation narrows the application-data blast radius but does not remove the compromised application's full controller authority. Individually managed remote Streamable HTTP MCP servers remain the supported off-host option today.
- Docling and Tika share only the private `parser-control` network with the app, receive no storage/database credentials or volumes, and have explicit CPU, memory, temporary-filesystem, health, restart, and log bounds. The sealed Docling runtime uses only its preloaded OCR models; model downloads during a document request are unsupported. Docling deliberately runs one local conversion worker under a 10 GiB bound: callers may queue concurrently, but only one heavyweight OCR/table conversion is in flight so simultaneous tenants cannot make the sidecar OOM. The parsers are not app startup dependencies and own no document or tenancy state.

The default app publication is loopback HTTP and requires no domain, active provider, SMTP, OAuth, reverse proxy, or reachable GitHub API. Direct non-loopback HTTP is also supported for an operator-selected trusted LAN/VPN: the release launcher authenticates the immediate socket peer with process-local material and forwarding headers remain untrusted. HTTPS requires the supported loopback-reached TLS proxy declaration; contradictory identity topology fails both readiness and auth admission. Postgres, MinIO, ToolHive, parser sidecars, and MCP proxies have no host publication.

Process liveness is separate from readiness. Readiness checks explicit runtime security configuration, Postgres, and private object storage; Memory worker/key-preflight, provider, SMTP, MCP/ToolHive, parser-sidecar, and release-awareness failures remain feature-local. The recurring object-storage check is a non-mutating `HeadBucket`: green proves endpoint/bucket reachability and accepted bucket-head authorization, not complete object Put/Get/Delete IAM. The bundled MinIO integration lane proves its object path; an external S3-compatible deployment separately requires the operator-owned fresh-object write/read/compare/delete proof defined by the environment contract.

Installation state relies on stable volumes, coordinated pre-migration backup, committed `prisma migrate deploy` migrations, guarded restore, and versioned/commit-tagged unified images. `ops/backup/` owns write-quiesced database/object backup, durable Memory-lease fencing, and the internal no-port restore project plus key/deletion/barrier review receipt; it never starts or promotes an application. `ops/nginx/` owns the optional SSE/upload-aware TLS proxy template.

Live run cancellation and MCP sessions are process-local. Durable run status, per-chat active-run uniqueness, accepted bindings, recovery checkpoints, activation jobs, and desired MCP generations survive restart; live abort/session ownership does not cross replicas. Multi-replica/HA operation is unsupported.

## Persistence And Durable Ownership

Postgres/Prisma is authoritative for:

- users, identities, sessions, auth admission, groups, grants, and invitations;
- folders, chats, message DAGs, settings state, Assistant definitions/revisions/publications/pins, runs, purpose-bound lifecycle/checkpoint records, usage, and immutable accepted bindings;
- Knowledge Base ownership/publications, document-version visibility, vector-space generations, chunks, vectors, retrieval checkpoints, and safe citations;
- provider/model/credential, Search, SMTP, and MCP control planes;
- MCP activation/runtime state, accepted tool-call checkpoints, upload metadata/cleanup work, and public-share snapshots.

Private attachment and Knowledge original/normalized objects live in S3/MinIO in the bundled stack. A filesystem fallback exists only when S3 is absent outside that topology.

At the architecture layer, Postgres owns authenticated relational tenancy,
mutable control-plane state, conversation/run graphs, accepted bindings,
recovery checkpoints, and user-visible output records; private object storage owns attachment bytes behind those relational
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
  -> normalized live updates + bounded durable checkpoints/outputs
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

Recovery reconstructs work from durable accepted bindings and purpose-bound
checkpoints; live controllers and provider sessions remain process-local. Exact
batch persistence, outcome-unknown handling, terminal settlement, and
provider-specific live-only exceptions are owned by the routed run and provider
contracts rather than repeated in this topology map.

`backend/RUNS_AND_STREAMING.md` owns exact lifecycle, cancellation, event, context, usage, and cost semantics. The bounded owners routed by `backend/PROVIDER_ADAPTERS.md` own provider-specific behavior. Bounded owners routed by `RUN_PIPELINE.md` own product-level run meaning.

## Frontend Boundary

The browser maintains strict summary/detail and server/client separation:

- workspace state contains lightweight summaries only;
- keyed thread state contains messages, active leaf, usage, and branch snapshots;
- keyed run-lifecycle state contains only live status and the minimal decoded run outcome required for cancellation, resume polling, terminal reconciliation, citations, and generated outputs;
- keyed composer sessions contain draft/edit/attachment and async-operation ownership;
- Branches, next-run controls, and overlay/menu state remain in focused owners. Repository objects and internal checkpoints never cross this boundary without an explicit allowlisted serializer.

Every async producer captures its source chat/session before awaiting. Optimistic rows, ID adoption, token flushes, errors, persisted refresh, and terminal updates affect only that source. Cached inactive state survives navigation, and stale responses merge without overwriting concurrent user/stream work.

`features/workspace-v2/PowerAppShellV2` is the sole authenticated browser composition. It projects exactly seven semantic view contracts into the v2 presentation and does not pass a root setter bag. Focused stores, controllers, and API clients under `components/app-shell/` remain headless owners rather than an alternate renderer. `frontend/IMPLEMENTATION_STATE.md` owns exact state boundaries; other frontend behavior routes through `FRONTEND.md`. Theme remains browser-local with cookie-backed server first paint.

## Change Rules

- Preserve dependency direction and keep server-only code out of client bundles.
- Extend existing domain, handler, repository, adapter, or coordinator boundaries before inventing another runtime.
- Keep each change as a runnable or clearly verifiable vertical slice.
- Directly test cross-user ownership, terminal settlement, migrations, uploads, shares, secret handling, and publication safeguards.
- Update this document only for topology, stable module ownership, dependency direction, deployment/process shape, or durable data-boundary changes. Do not add exhaustive module or run-engine narration already owned by source/tests.
