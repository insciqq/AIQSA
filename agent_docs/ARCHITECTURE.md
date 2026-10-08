# ARCHITECTURE

Owner: System architecture maintainers
Scope: Dependency direction, deployment shape, and data/egress ownership.

## Architectural Stance

AIQSA is an operator-managed Next.js modular monolith with authenticated users and hardened single-host, single-replica Compose deployment. Process-local cancellation/external sessions preclude replica handover. Revisit admission, scheduling, recovery and isolation before adding replicas, untrusted tenancy or spend/latency guarantees.

Splitting services or adding remote control requires a measured blocker and explicit auth, ownership, network, deployment, recovery and observability design.

## Dependency Direction

Browser UI → client-safe contracts/API clients → authenticated routes → provider-neutral domain/server orchestration → repositories and bounded adapters.

Browser code cannot import server modules, Prisma, credentials, Node-only APIs, or provider transports. Contracts are a dependency leaf; domain rules do not import framework/runtime consumers. Routes compose boundaries; reusable behavior belongs below them. Repositories own durable access and adapters contain external wire formats. Lower layers never import their UI, route, or runtime consumers.

Enforcement: [ESLint](../eslint.config.mjs), [boundary checker](../scripts/eslint/architecture-boundaries.mjs), and imports in [`lib/`](../lib/), [`app/`](../app/), and [`components/`](../components/).

## Supported Deployment Shape

Application code, published images, production [Compose](../compose.yaml), committed migrations, and installation bootstrap belong here. The production stack uses prebuilt images and keeps data in persistent volumes; migrations/bootstrap gate every dependent application role. Ordinary stable updates must work with `docker compose pull && docker compose up -d` without replacing installation secrets or data. Supported installations require KVM for Workspace. [`aiqsa.sh`](../aiqsa.sh) wraps installation, updates and single-host backup/restore (host preflight, one-time `.env` creation, readiness wait, guarded upgrade); `install` refuses hosts without usable KVM, and the CLI never changes host settings, rewrites existing `.env` bytes or runs `down` on the installation. Site-specific proxies, deployment automation, schedules, off-site backups and multi-host recovery remain infrastructure concerns.

[`docker-compose.dev.yml`](../docker-compose.dev.yml) is disposable and must never share persistent-installation state. The application is the public application boundary; data services, parsers and the Workspace runner stay private. Publication and proxy rules belong to [Environment](ENV_VARIABLES.md) and [Security](SECURITY.md).

Sidecars are bounded helpers, never tenancy or durable-state authorities. Optional integration failures remain feature-local unless an explicit contract makes them core readiness dependencies. The Workspace runner owns only guest lifecycle/tool transport; the app retains admission, storage, recovery, and presentation authority. Runtime build owners are [Dockerfile](../Dockerfile) and [`ops/`](../ops/).

## Data And Egress Boundaries

- PostgreSQL is canonical for ownership, control state, accepted bindings, recovery, and output records; [schema and migrations](../prisma/) own exact storage.
- Private object storage owns originals and exported bytes; relational references govern access and lifetime. It is not a public file host.
- OpenSearch is a rebuildable candidate projection, never canonical content or authority. PostgreSQL reauthorizes every hit. Knowledge passage retrieval has no alternate lexical backend; Memory fallback/rollout belongs to [Memory](MEMORY.md) and [Environment](ENV_VARIABLES.md).
- Browsers receive explicit allowlisted projections. Storage objects and upstream formats do not become client contracts by existing.
- External I/O crosses authorized, bounded server adapters. Knowledge embedding/indexing has an independently disclosed installation-profile destination; answer-model selection does not authorize it.
- Artifact vendoring sends model-selected URLs to operator-allowlisted public CDNs at version creation. Restricted grammar cannot prevent URL disclosure. Failures return tool errors; frozen bytes share version lifetime. Offline viewers disclose no IP to CDNs.
- Browser push posts to each subscribed device's browser push service (Google, Mozilla, Apple, Microsoft): one RFC 8291-encrypted, content-free message per notifying run or scheduled settlement (title, fixed outcome copy, same-origin link carrying only the chat id), signed with an installation VAPID key created on first use and stored as an `AIQSA_ENCRYPTION_KEY` envelope. Endpoints must be public HTTPS; delivery is best effort and never retried. Subscriptions are bound to the registering session and deleted on its revocation, notifications off, a 404/410 from the service or repeated failures. Decrypted titles can appear on lock screens.
- Page reading (`fetch_url`) sends one GET with a fixed user agent to the public host of a link the user or the run's own Search supplied, disclosing the installation's address and that URL to the host and its redirects. Failures return tool errors; bounded page text persists only in the run's tool call, deleted with its chat. No administrator switch exists; [Security](SECURITY.md) owns the link and transport rules.
- OIDC sign-in sends discovery, key, token and userinfo requests to the administrator-configured issuer and the endpoints it advertises, which may be on the LAN; bounded bodies, timeouts and the address rules belong to [Sign-in](SIGN_IN.md#openid-connect). Tokens are never persisted, except the encrypted ID token a session keeps for IdP logout.
- LDAP sign-in connects to the administrator-configured directory with the configured service account and the person's password, bounded per operation. The host may be private but never link-local, cloud metadata or an AIQSA service; [Sign-in](SIGN_IN.md#ldap) owns the TLS and credential rules.
- SAML IdP metadata is fetched only when an administrator imports it or tests a configuration with a metadata URL: one bounded GET to that URL with up to three redirects, each hop DNS-pinned and checked, private networks allowed (plain HTTP only there), AIQSA's own services and cloud metadata refused. Sign-in itself makes no server request to the IdP.
- Parsers receive bounded documents without data credentials or durable document state. Workspace receives opaque runtime identity, bounded streams, and allowlisted tools, never application/data credentials. Guest disks are operational state outside backup authority.

No new destination, credential audience, public projection, or durable store is implicit: define its privacy, failure, retention, and operator boundary. Execution semantics belong to [Run contracts](RUN_CONTRACTS.md); lifecycle and recovery operations belong to [Persistence](PERSISTENCE.md).

Observability is a dependency-free server leaf shared by the CJS launcher and application bundles through a process-global AsyncLocalStorage singleton. It owns bounded stdout records and emergency stderr output, never database/provider clients, payload retention, execution policy or a second lifecycle authority. It hands each validated record to at most one in-process observer, which cannot change or delay that output.

The [telemetry owner](../lib/server/telemetry/) is that observer in the application and in the long-running workers that already hold a database client, never the Workspace runner or one-shot scripts. It aggregates records into PostgreSQL operator health telemetry, best effort and memory-bounded: database failure never reaches the logging path. Telemetry never leaves the installation.
