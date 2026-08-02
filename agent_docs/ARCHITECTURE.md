# ARCHITECTURE

Owner: System architecture maintainers
Scope: Current process topology, module dependency direction, durable data boundaries, and supported deployment shape; behavior details remain with subject owners.

## Ownership

AIQSA is a TypeScript/Node.js Next.js modular monolith for a self-hosted installation. The supported topology is a hardened single-host, single-replica runtime. Before broad real-user exposure it still lacks shared-provider quotas, per-user pressure limits, general observability, and completed 50-user load evidence.

Do not split a separate backend, frontend runtime, or microservice without a measured blocker that cannot be solved within this boundary. API behavior belongs to `BACKEND.md`, UI behavior to `FRONTEND.md`, deployment configuration to `ENV_VARIABLES.md`, and security/exposure rules to `SECURITY.md`.

## System Shape

```text
browser
  -> Next.js pages/layouts + React components
     -> client stores/actions + wire decoders
  -> Next.js route handlers
     -> auth + domain/handler boundaries
     -> repositories -> Prisma -> Postgres
     -> uploads -> private S3/MinIO (filesystem fallback outside bundled stack)
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

The dependency rules are executable in `eslint.config.mjs` and `tests/harness/import-boundaries.test.ts`: browser components cannot import server/Prisma/Node-only modules, shared contracts and pure domain code cannot depend on consumers or runtime frameworks, API routes cannot import browser components, provider adapters remain Prisma-free, and the Research Chat shell cannot depend on Control Center internals.

### Server control planes

- `lib/server/auth/` owns sessions, admission, user/group entitlements, and the built-in `full_access` semantic wildcard. Entitlement never selects a credential; direct-user, active-group, and permitted default credential precedence remains a separate pure/domain and runtime boundary.
- Administrator provider owners manage mutable connection/model/credential configuration. Provider runtime owns transactional run admission, immutable accepted bindings, credential-version/revocation guards, and adapter construction. Browser contracts expose only write actions and safe metadata.
- Search administration exposes one logical source per exact provider connection and owns the source-level lifecycle; physical hosted/query-only routes retain their own draft/test/activation/publication evidence below it. Provider-neutral Search owns typed query-only execution, plan rules, fan-out merge, and bounded evidence. Technical-only provider deployments may support Search while remaining absent from answer-model catalogs.
- MCP owns installation definitions, grants, encrypted configuration/OAuth envelopes, activation jobs, runtime generations, and official SDK/ToolHive adapters. One process-local coordinator advances a database-owned activation job; another reconciles durable desired generations into live sessions. Both fence writes to exact versions/fingerprints. Remote traffic uses the SSRF-safe fetch boundary; local stdio uses ToolHive sibling workloads on the private control network.
- A remote MCP server may broker another SaaS authorization flow, but AIQSA authorizes only the reviewed MCP resource and stores only MCP-audienced per-user tokens. It has no provider-specific upstream callback, secret, scope, organization, or persistence authority.
- SMTP is an independent database-owned draft/test/active control plane with bounded delivery. Release awareness is a separate optional read-only boundary fixed to the official public AIQSA release endpoint; it cannot deploy or mutate installation state.

Exact handler, repository, and adapter names remain discoverable from source and focused tests rather than duplicated here.

## Runtime And Deployment Boundary

Docker Compose is the supported local and single-host topology:

- `docker-compose.yml` owns the persistent operator installation. One published non-root image supplies the standalone app, one-shot migration/bootstrap, and profiled maintenance commands alongside internal Postgres, MinIO/bucket initialization, and pinned ToolHive control.
- Migration/bootstrap applies committed migrations and the idempotent fail-closed installation bootstrap before app readiness. Retention and other maintenance roles use explicit command overrides and role-specific environment.
- Named Postgres, MinIO, and ToolHive volumes preserve relational data, private objects, and disposable MCP runtime state across normal image updates.
- `docker-compose.dev.yml` owns bind-mounted deterministic development/test execution and separate disposable volumes. Development verification may mutate only this named stack and has no preservation, crash-recovery, or parallel-run guarantee.
- Only ToolHive mounts the host Docker socket. The app reaches its control/proxy endpoints on a private network; a profiled cleanup role may manage only exact AIQSA-owned workloads.

The default app publication is loopback HTTP and requires no domain, active provider, SMTP, OAuth, reverse proxy, or reachable GitHub API. An exposed installation places the same canonical stack behind the supported TLS proxy. Postgres, MinIO, ToolHive, and MCP proxies have no host publication.

Process liveness is separate from readiness. Readiness checks explicit runtime security configuration, Postgres, and private object storage; provider, SMTP, MCP/ToolHive, and release-awareness failures remain feature-local.

Installation state relies on stable volumes, coordinated pre-migration backup, committed `prisma migrate deploy` migrations, guarded restore, and versioned/commit-tagged unified images. `ops/backup/` owns the write-quiesced database/object backup and disposable-target restore verification; `ops/nginx/` owns the optional SSE/upload-aware TLS proxy template.

Live run cancellation and MCP sessions are process-local. Durable run status, per-chat active-run uniqueness, activation jobs, desired MCP generations, and evidence survive restart; live abort/session ownership does not cross replicas. Multi-replica/HA operation is unsupported.

## Persistence And Durable Ownership

Postgres/Prisma is authoritative for:

- users, identities, sessions, auth admission, groups, grants, and invitations;
- folders, chats, message DAGs, prompt/settings state, runs, events, usage, and immutable accepted bindings;
- provider/model/credential, Search, run-profile, SMTP, and MCP control planes;
- MCP activation/runtime evidence, upload metadata/cleanup work, and public-share snapshots.

Private objects live in S3/MinIO in the bundled stack. A filesystem fallback exists only when S3 is absent outside that topology.

Core rules:

- private rows are resolved through the authenticated user; request-supplied ownership is never trusted;
- catalogs are server-filtered and entitlements/configuration are revalidated at run admission;
- installation Search policy recommends but never grants access; preferred intent is durable while model-compatible execution is ephemeral;
- a chat is a message DAG with a persisted active leaf assembled by the server;
- relational constraints keep parents/leaves inside their chat and grants inside one valid principal/target shape;
- one active run is allowed per chat, while different chats may execute concurrently;
- uploads stay private and enter provider payloads only after ownership/capability checks;
- a public share is an immutable sanitized snapshot, never a live pointer into private chat state;
- normalized bounded previews/events/evidence may persist; raw provider payloads do not persist by default.

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

Send and regenerate use one server-only preparation boundary. Route handlers retain auth, source lookup, orphan reconciliation, and the active-run gate; preparation owns content, capability, prompt, context, controls, Search, attachment, MCP, budget, and redacted-preview validation.

The prepared run is a deeply frozen plain-data snapshot. Persistence and execution receive isolated materializations instead of rebuilding it. Run creation independently revalidates entitlement, active revisions, model/Search compatibility, credential resolution, evidence, and MCP inventory freshness before atomically persisting messages, run graph, accepted defaults, and immutable bindings.

Preferred logical Search-source intent remains distinct from the effective model-compatible plan. Admission selects only a physical route belonging to that exact source, preferring eligible same-connection hosted execution and otherwise requiring a tested query-only route without cross-source fallback. Every selected source has an ordered immutable binding that also pins the physical strategy/revision and technical provider binding; each actual invocation is a separate execution record. MCP bindings similarly pin revision, generation, fingerprint, namespaced complete tool definitions, and safe source/account evidence.

### Execution, tools, and recovery

Foreground execution owns provider/tool dispatch, live SSE, batched token persistence, transient chat synchronization, and the process-local cancellation registry. Provider adapters translate only their wire/transport/parser semantics and return normalized events/results.

Search and MCP use one provider-neutral continuation loop. It persists each complete requested tool batch before bounded parallel dispatch and preserves provider order. Completed calls can be reused after recovery; a call left running across a crash is outcome-unknown and is not repeated automatically. Private provider continuation signatures remain outside client projections.

Recovery owns boot orphan sweep, explicit provider refresh, checkpointed tool continuation, and stale-run settlement. Terminal completion, recovered failure, and cancellation all use status-guarded database writes so only one writer finalizes messages, usage, and run state. Live token cadence may be finer than persistence and React updates.

Gemini native grounding is a special live-only answer boundary: once detected, answer/artifact drafts are purged and later grounded content/signatures remain transient. Durable state keeps status, usage, provenance, and neutral placeholders rather than misleading stored answer text.

`backend/RUNS_AND_STREAMING.md` owns exact lifecycle, cancellation, event, context, usage, and cost semantics. `backend/PROVIDER_ADAPTERS.md` owns provider-specific behavior. `QSA_PIPELINE.md` owns product meaning.

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
