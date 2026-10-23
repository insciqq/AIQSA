---
paths:
  - "Dockerfile"
  - "ops/**"
  - "eslint.config.mjs"
  - "scripts/eslint/**"
  - "lib/server/observability/**"
  - "lib/server/telemetry/**"
  - "lib/server/push/**"
  - "instrumentation.ts"
---
# Architecture

Process and deployment shape, dependency direction, and every place data leaves the installation. Build inputs live in `Dockerfile`, `ops/` and `compose.yaml`; `eslint.config.mjs` and `scripts/eslint/architecture-boundaries.mjs` enforce import boundaries.

## Shape

- AIQSA is a Next.js modular monolith on one host with one application replica. Cancellation, external sessions, the AIQSA Connect relay, pending SAML requests and the sign-in method snapshot live in process memory, so replicas, untrusted tenancy or spend and latency guarantees first need a new design for admission, scheduling, recovery and isolation.
- Splitting out a service or adding remote control needs a measured blocker and an explicit design for auth, ownership, network, deployment, recovery and observability.
- Dependency direction: browser UI → client-safe contracts (`lib/contracts/`, a leaf) → authenticated routes → provider-neutral server orchestration → repositories and adapters. Routes only compose; repositories own durable access; adapters own external wire formats. Lower layers never import their consumers.

## Deployment

- Production runs prebuilt images from `compose.yaml` with data in persistent volumes; migrations and bootstrap gate every role that depends on them. An update is `docker compose pull && docker compose up -d` and never replaces secrets or data.
- Workspace requires KVM, and `aiqsa.sh install` refuses hosts without it. The CLI never changes host settings, never rewrites existing `.env` bytes and never runs `down` on the installation.
- Site-specific proxies, deployment automation, schedules, off-site backups and multi-host recovery belong to infrastructure and stay out of this repository, as do real installation targets and credentials.
- `docker-compose.dev.yml` is disposable and never shares state with a persistent installation.
- Only the application is public; data services, parsers and the Workspace runner stay on private networks.
- Sidecars are bounded helpers, never tenancy or durable-state authorities, and an optional integration failing stays local to its feature. The Workspace runner owns only guest lifecycle and tool transport; the application keeps admission, storage, recovery and presentation.
- Companion images under `ops/` build reproducibly with pins compatible with the application runtime; validate image changes on disposable targets.

## Data stores

PostgreSQL is canonical and the only search store: the separate search index service was removed (operator decision 2026-10-23). Object storage is private, never a public file host. Browsers receive explicit allowlisted projections, never storage objects or upstream formats. See `agent_docs/PERSISTENCE.md`.

## Where data leaves the installation

Every external destination is listed here with its privacy decision. A new destination, credential audience, public projection or durable store starts with an entry here: what is sent, to whom, what happens on failure, and how long it is kept.

- **Model providers.** Content goes only to the destination an admitted run bound (`agent_docs/PROVIDERS.md`), including the values of saved secrets the agent reads (accepted risk, `agent_docs/SECURITY.md`).
- **Artifact CDNs.** Model-chosen library and image URLs are fetched from operator-allowlisted public CDNs when a version is created, and frozen with it. Accepted risk: a URL can itself carry data. Offline viewers disclose nothing to CDNs.
- **Artifact contents** (operator decision 2026-10-08). An artifact holds only what its page shows: data sources become JSON extracted in Workspace, office documents are converted for viewing, and originals enter only on the user's explicit request, because a published artifact gives every viewer all of its files.
- **Artifact downloads** (operator decision 2026-10-11) leave only through the viewer, never by weakening its CSP or sandbox.
- **Browser push.** One encrypted, content-free message per notification (title, fixed outcome text, a link carrying only the chat id) to the device's push service; never retried. Accepted risk: decrypted titles can appear on lock screens.
- **Telegram** (operator decision 2026-10-19, not disclosed in the product). Answers, files, MCP approval details and scheduled task results of users linked to the installation's bot are sent to Telegram.
- **Page reading (`fetch_url`).** One GET to the public host of a link the user or the run's own Search supplied, disclosing the installation's address and that URL. There is no administrator switch; rules are in `agent_docs/SECURITY.md`.
- **Sign-in providers.** OIDC, LDAP and SAML metadata requests go only to administrator-configured endpoints, which may be on the LAN (`agent_docs/SIGN_IN.md`).
- **AIQSA Connect.** Clients reach only the app origin; terminal traffic is relayed in memory and never stored.
- **Parsers and Workspace.** Parsers receive bounded documents without credentials. Workspace guests receive an opaque runtime identity and allowlisted tools, never application or data credentials.
- Operator telemetry never leaves the installation.

## Observability

- `lib/server/observability/` is a dependency-free leaf shared by the CommonJS launcher and the application bundles through a process-global AsyncLocalStorage singleton. It writes bounded stdout records and must never import database or provider clients, retain payloads or decide execution policy.
- It hands each record to at most one in-process observer that cannot change or delay output: `lib/server/telemetry/`, which runs in the application and long-running workers that already hold a database client, never in the Workspace runner or one-shot scripts. Its aggregation into PostgreSQL is best effort, and a database failure never reaches the logging path.
