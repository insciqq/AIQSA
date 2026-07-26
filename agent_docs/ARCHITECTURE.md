# ARCHITECTURE

## Ownership

This document owns system topology, module dependency direction, durable data boundaries, and deployment/process shape. It intentionally does not repeat API behavior, UI workflows, visual recipes, provider wire details, environment inventories, or test matrices; use the ownership map in `AI_CONTEXT.md`.

AIQSA remains a TypeScript/Node.js Next.js modular monolith targeting a self-hosted 50+ user installation. The current supported topology is a hardened single-host, single-replica runtime. Shared-provider quotas, per-user pressure limits, broader observability, and the 50-user readiness audit remain backlog requirements before broad real-user exposure. Do not split a separate backend, microservice, or frontend runtime without a measured blocker that cannot be solved inside the current boundary.

## System Shape

```text
browser
  -> Next.js pages/layouts and React components
     -> client stores/actions and wire-response validation
  -> Next.js Route Handlers
     -> auth + handler factories + domain services
     -> repositories -> Prisma -> Postgres
     -> upload storage -> S3/MinIO or filesystem fallback
     -> provider/tool adapters -> external provider APIs
     -> remote MCP -> external Streamable HTTP server
     -> private ToolHive API -> host Docker daemon -> sibling stdio MCP container
```

The application has five primary code layers:

- `app/` owns page/layout composition and thin HTTP route entry points.
- `components/` owns browser rendering and interaction; it may consume public/domain/client contracts but never server repositories, secrets, or provider transports.
- `lib/contracts/` owns client-safe shared wire types and runtime decoders; it is a dependency leaf and must not import browser, Prisma, Node-only, or server implementations.
- `lib/domain/` owns provider-neutral pure rules and data transformations.
- `lib/server/` owns auth, repositories, storage, run orchestration, provider/tool adapters, and other Node-only behavior.

Compact semantic ownership:

| Area | Owner |
| --- | --- |
| HTTP entry points | `app/api/` |
| Browser UI and feature state | `components/` |
| Shared client-safe wire contracts | `lib/contracts/` |
| Pure provider-neutral rules | `lib/domain/` |
| Auth, persistence, MCP policy/runtime, providers, uploads, and runs | `lib/server/` |
| Schema, migrations, installation bootstrap, and deterministic test seed | `prisma/` |
| Product and integration tests | colocated `*.test.*` plus `tests/e2e/` |
| Small operational helpers | `scripts/` |
| Current architecture/workflow and task ledgers | `agent_docs/` |

Route handlers resolve runtime dependencies and compose handler/repository/adapter boundaries. Business behavior belongs below the route file. Provider-specific wire shapes stay inside `lib/server/providers/`; React never calls a provider directly. Shared wire contracts flow from `lib/contracts/` into domain/server/browser consumers without importing any consumer back into that leaf.

`lib/server/mcp/` is the separate MCP policy, persistence, OAuth, and runtime boundary. It owns typed remote/npm/PyPI/OCI source and slot validation, effective direct/group access, encrypted configuration/token envelopes, MCP-specific handler/repository contracts, and narrow wrappers around the pinned official MCP SDK plus ToolHive. `Full access` uses ordinary materialized group grants for every server: installation repair covers existing rows, a database insert trigger covers future rows, and application mutation refuses changes to that system grant. The generated grant contains no personal-slot permission, so personal values and OAuth identity remain direct-user authority. Remote Streamable HTTP requests pass through the dedicated SSRF-safe fetch boundary; local stdio sessions use ToolHive-created sibling containers and private proxies. The process-local runtime coordinator reconciles database-owned desired generations into live sessions, inventories, and readiness at node boot, on authenticated activity, after runtime-affecting MCP mutations, and in a periodic sweep. It also drains a deleted server's accepted generations before physically removing its tombstoned live configuration graph; run-owned bindings/calls and immutable safe snapshots remain independent. Runtime generations and accepted run snapshots retain only safe credential-source/account-label evidence alongside revision/tool fingerprints; executable configuration and secret values remain server-only. `lib/contracts/mcp.ts` remains client-safe and contains no executable endpoint credentials or server-only launch authority.

`lib/server/admin/providers/` owns administrator provider lifecycle orchestration and persistence; `lib/domain/providerCredentialResolution.ts` owns the pure direct-user, active-group, then allowed-default credential precedence; and `lib/server/providerRuntime/` owns transactional run admission, immutable binding resolution, and adapter construction. `lib/server/auth/` owns ordinary exact provider/model/search grants plus `Group.systemRole = full_access`; that role is a semantic current/future entitlement wildcard consumed by catalog/admin projections, Quick preservation, and atomic run admission, not a provider credential selector or materialized `AccessGrant`. `ProviderUserCredentialAssignment` and `ProviderGroupCredentialAssignment` remain separate connection-local relations. `lib/server/admin/runProfiles/` owns the separate fixed three-slot profile configuration and its atomic stable-deployment mapping, while `lib/server/catalog/` owns the entitlement-safe user projection. Wire adapters in `lib/server/providers/` stay Prisma-free. `lib/server/email/` independently owns the singleton SMTP draft/active lifecycle, bounded transport, and per-send database resolution. The provider and email control planes use the shared purpose/owner/value-bound secret-envelope boundary and expose only write actions plus safe metadata to browser contracts; run profiles contain no secrets.

Catalog, current-user settings, chat/thread, model-run read, and admin endpoints compile their browser and server consumers against that shared leaf. Runtime decoders for shared response envelopes live beside those wire types; feature-only request/result helpers stay with the owning frontend feature, while untrusted HTTP validation and repository-only `Date`/Prisma inputs remain server-side. Common session/admin/origin error types compose through `lib/contracts/http.ts` instead of being copied between endpoint families.

The stable dependency directions above are executable in `eslint.config.mjs`: components cannot reach server/Prisma/Node-only modules (including `app/api` and repository `prisma/` paths), shared contracts and pure domain modules cannot depend back on consumers, Prisma, or runtime frameworks, API routes cannot import browser components, provider adapters cannot reach Prisma, browser/app, or run-handler/repository owners, and the app shell cannot depend on the admin feature. `tests/harness/import-boundaries.test.ts` exercises forbidden package/alias/baseUrl/relative/dot-segment imports and supported directions so changes to these gates fail visibly instead of silently narrowing valid architecture.

## Runtime And Deployment Boundary

Docker Compose is the supported local and single-host installation topology:

- default `docker-compose.yml` owns the persistent operator installation: a small non-root `app` standalone runtime, one-shot non-root `migrate-bootstrap` tools service, internal Postgres, internal MinIO/bucket initialization, and a pinned ToolHive controller on a private MCP network;
- the tools service applies committed migrations, performs the atomic stopped control-plane/envelope cutover, and runs the fail-closed idempotent installation bootstrap before the app becomes healthy; it is also the explicit command-override owner for manual/cron retention, while the runtime contains neither migration source nor Prisma CLI;
- named Postgres, MinIO, and ToolHive volumes preserve relational state, private objects, and disposable MCP runtime state across container rebuilds and ordinary `git pull` plus `docker compose up -d --build` updates;
- explicit `docker-compose.dev.yml` owns bind-mounted development and test execution, deterministic seed/auth/Fake QSA switches, and separate disposable volumes;
- MinIO/S3 owns private upload objects, with a filesystem fallback only when S3 configuration is absent outside the bundled stack;
- only ToolHive mounts the host Docker socket and creates dynamic sibling MCP containers outside the Compose project. The app reaches its unauthenticated control/proxy endpoints only through the internal `mcp-control` network; an on-demand profiled maintenance service lists or removes only exact AIQSA-owned workloads.

Configuration and exposure rules are owned by `ENV_VARIABLES.md` and `SECURITY.md`. The default app publication is loopback HTTP, so a clone can run without a domain, active LLM provider, SMTP, OAuth, or reverse proxy. Provider and SMTP operational configuration is database-owned and changes live; their legacy environment values are visible only to the stopped migration-tools boundary and never to `app`. An exposed installation may place the same canonical stack behind the host TLS proxy without selecting another environment tier. Postgres, MinIO, ToolHive, and MCP proxies have no host publications. Process liveness is separate from readiness: readiness checks explicit runtime security configuration, Postgres, and the configured private bucket, while optional provider, SMTP, and MCP/ToolHive failure remains feature-local rather than a core dependency failure. `ops/backup/` owns the coordinated write-quiesced database/object backup plus guarded disposable-target restore, and `ops/nginx/` owns the optional SSE/upload-aware single-host proxy template.

Local verification always names `docker-compose.dev.yml` and may mutate or reset only that stack's development database and bucket. It has no crash recovery, parallel-run, or data-preservation contract. This is the accepted developer-workflow tradeoff under ADR 0015 as amended by ADR 0020; it grants no authority over the default operator installation. Installation state is protected by stable named volumes, pre-migration coordinated backups, committed `migrate deploy` migrations, the non-demo installation bootstrap, guarded restore, and optional commit-tagged application/tools images. Quotas, broader resource controls, observability, and 50-user load evidence remain separate launch-scale work.

The current run-cancellation controller registry is process-local. Durable database status and the per-chat active-run uniqueness constraint survive restarts, but live abort ownership does not cross replicas. ADR 0005 owns that accepted limitation; multi-replica/HA work remains backlog scope rather than a reason to split the monolith now.

## Persistence And Ownership

Postgres with Prisma is authoritative for users, auth/session state, entitlements, workspace/conversation data, runs/events/usage, provider/model/credential configuration and exact run bindings, the three system run-profile mappings, SMTP configuration/health, prompt/catalog and MCP configuration, MCP runtime evidence, and public snapshot records. Schema changes land as committed migrations and runtime deployment uses `prisma migrate deploy`.

Core ownership rules:

- private rows are resolved through the authenticated current user; request-supplied ownership is never trusted;
- catalog exposure is backend-filtered and run entitlements are revalidated immediately before provider execution;
- administrator run-profile targets use stable deployment IDs, but the current-user catalog emits a concrete target only when that same deployment is entitled and currently available; otherwise it emits a generic unavailable profile without target identity;
- a chat is a message DAG with a persisted active leaf; the server, not the browser, assembles the trusted branch context;
- composite database relations require every message parent and active-leaf pointer to remain inside its owning chat, while grant-shape checks require one principal and one provider/model/search target;
- one active run is allowed per chat while different chats may run concurrently;
- uploads remain private storage objects and are resolved into provider payloads only after ownership/capability checks;
- a public share is a sanitized immutable snapshot, never a pointer that exposes live private chat state;
- normalized operational previews/events are persisted, while raw provider payloads are not stored locally by default.

Exact table constraints, migration rules, retention, branch repair, usage accounting, attachment processing, and share sanitization live in `BACKEND.md`; security limits and privacy boundaries live in `SECURITY.md`.

## Run Data Flow

```text
authenticated mutation
  -> ownership/catalog/control/attachment validation
  -> server-owned branch context + context-budget preparation
  -> normalized provider-neutral run request
  -> provider/tool adapter execution
  -> normalized SSE events and artifacts
  -> status-guarded persistence/finalization
  -> foreground-only transient chat/thread synchronization
```

`lib/server/runs/runPreparation.ts` is the single server-only preparation boundary for send and regenerate. Route handlers retain config/auth, orphan reconciliation, owned-source lookup, and the active-run gate, then pass an explicit send or regeneration source into the shared entitlement/content/capability/prompt/context/parameter/search/attachment/budget/preview pipeline. Its `PreparedRun` is a defensively cloned, deeply frozen plain-data snapshot containing only validated server-owned context plus the ephemeral provider payload; adapter service references stay outside that owned graph. Persistence and execution receive isolated mutable materializations of the snapshot rather than rebuilding or revalidating it. `runContextBudget.ts` owns the common initial/tool-round budget calculation. Provider adapters translate their provider wire/transport/parser responsibilities and return normalized events/results. Tool execution remains behind provider-neutral tool contracts.

MCP preparation resolves every enabled and currently granted server to one ready runtime generation, namespaces its complete tool inventory, and snapshots the accepted revisions, fingerprints, and tool definitions into the normalized run request. Send and regenerate persist the corresponding runtime-generation bindings inside the same transaction as run creation; guarded inserts recheck access, active revision, desired generation, readiness, fingerprint, and inventory freshness so a stale plan aborts atomically instead of silently dropping tools.

Provider preparation carries only opaque deployment/search IDs and provider-neutral data. The run-creation `REPEATABLE READ` transaction revalidates grants, memberships, enabled connection/model/credential state, deterministic direct-user/group/default credential resolution, and current activation-time catalog evidence, then persists exact answer/search `ProviderRunBinding` snapshots with the run. Execution, cancellation, and recoverable native background work use those saved snapshots and credential versions rather than re-resolving current provider configuration.

`lib/server/runs/runExecution.ts` owns foreground provider/tool dispatch, the process-local controller registry, live SSE delivery, batched token persistence, transient `chat_update`, and foreground failure/terminal coordination. `providerToolLoop.ts` and `toolLoop.ts` are the shared provider-neutral continuation boundary for Perplexity and MCP tools: provider adapters only translate canonical definitions/calls/results, while the loop persists each requested batch before bounded parallel dispatch, preserves provider order, and repeats until a final answer or a configured limit. `ModelRunToolCall` rows plus the small `ModelRun.toolLoopState` checkpoint let `runRecovery.ts` reuse completed results, claim pending calls, and resume a provider round only from a durable native handle; a call left running across a crash is deliberately reported as outcome-unknown instead of being repeated. `toolInspection.ts` projects both live artifact events and authenticated durable rows into one bounded/redacted tool-activity contract, so chat and model-run reloads do not depend on the event append winning the call-persistence race. Provisional streamed text is reset with the persisted `message_reset` event before a tool batch. `runFinalization.ts` owns sequence-collision retry, stored-event append, usage/cost normalization, and the status-guarded completion primitive shared by foreground execution and provider refresh. `runRecovery.ts` owns boot-orphan sweep, provider-backed refresh, checkpointed tool-loop continuation, and stale-run reconciliation through an injected controller-registry view. HTTP handlers compose those boundaries around route-owned auth/source/gate/insert/default/cancel behavior; they do not implement the provider loop or terminal writer logic. Send/regenerate create transactions reuse `lib/server/settings/settingsTransaction.ts`, so their accepted defaults and run graph share one locked commit before execution. First-message title derivation is a pure local policy applied by that transaction, outside provider adapters and provider accounting.

`lib/server/providers/openaiResponses.ts` is the stable OpenAI adapter facade. It composes provider-specific request/preview building, response/SSE normalization, fetch transport, and create/retrieve/poll/refresh/cancel lifecycle modules; none of those lower boundaries imports the run engine, repository, HTTP route handlers, or browser code. Runtime construction and standalone smoke consumers depend only on the facade.

`lib/server/providers/openRouterChat.ts` is the corresponding stable OpenRouter answer/search facade. Request and always-redacted preview construction, JSON/SSE normalization, fetch transport, and real/fake Perplexity search execution have separate provider-specific owners. The Perplexity boundary consumes the same OpenRouter request/response primitives but does not own or import the provider-neutral tool executor or run engine.

`lib/server/runs/runRepositoryContract.ts` is the neutral server-only owner of run persistence records, repository injection, and the active-run conflict error. HTTP orchestration and Prisma persistence both depend on that boundary; persistence does not import the handler implementation.

Foreground token delivery may be finer-grained than persistence and React updates: token events are batched at storage/UI boundaries, while terminal completion is won through guarded persistence so only one writer finalizes usage/message/run state. `BACKEND.md` owns exact lifecycle semantics, `QSA_PIPELINE.md` owns product meaning, and `FRONTEND.md` owns browser reconciliation.

## Frontend Boundary

The browser preserves an exact API summary/detail boundary: workspace/list/create/update/branch mutations use `WorkspaceChatSummaryWire` with required `messageCount` and `pinned` and no thread fields; only authenticated chat detail and transient terminal `chat_update` carry messages and usage. `WorkspaceChatSummary` contains list metadata only, while `threadStore` owns keyed per-chat message/active-leaf/usage snapshots and `runSurfaceStore` owns keyed compacted Events/latest-run inspection snapshots. `composerSessionStore` independently owns draft/edit/attachment state for each saved chat plus distinct blank-root and blank-folder sessions. Optimistic rows, id reconciliation, token flushes, failures, persisted-run fetches, and final status update only the explicit source chat key; upload/edit/send operations likewise retain a source session token across awaits. Send snapshots and clears its input atomically, upload and send exclude each other, and a failed send restores the captured input only when no newer composer work exists. A successful first-send creation transfers its captured blank session to the new chat key, and keyed operation feedback never becomes a cross-chat singleton. Terminal `chat_update` patches summary metadata and detail fields through owner-specific projections. Cached inactive threads, run surfaces, and composer sessions survive navigation and blank-workspace transitions, while stale detail responses merge against concurrent cache changes. `PowerAppShell` assembles exactly seven named session/workspace/thread/composer/details/settings/overlays view contracts; the root view no longer inherits leaf prop surfaces or accepts raw root setters. Next-run controls, keyed run producers, and local overlay/menu state retain focused owners, while leaf adapters receive only their selected feature projection.

UI behavior and state ownership are defined only in `FRONTEND.md`. Visual tokens and recipes are defined only in `DESIGN_SYSTEM.md`. Theme preference is browser-local with a cookie-backed server first paint; it is not conversation/account data.

## Change Rules

- Preserve dependency direction; do not import server-only modules into client bundles.
- Add behavior to existing domain/handler/repository/adapter boundaries before inventing another runtime.
- Prefer small behavior-preserving vertical slices and keep each intermediate state runnable or verifiable.
- Treat cross-user ownership, run finalization, migrations, uploads, and public snapshots as high-risk boundaries requiring direct tests.
- Update this document only when topology, module ownership, dependency direction, deployment/process shape, or a durable data boundary changes. Update the subject owner for behavior-level changes.
