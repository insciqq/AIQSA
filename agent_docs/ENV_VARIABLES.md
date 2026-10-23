---
paths:
  - ".env.example"
  - "compose.yaml"
  - "compose.json-file-logging.yaml"
  - "docker-compose.dev.yml"
  - "aiqsa.sh"
---
# Environment

Environment variables, secrets and key rotation, and Compose topology selection. `.env.example`, the Compose files and the parsers with their tests define keys, defaults, validation and ceilings; change them together. Operator-facing explanations belong in `SELF_HOSTING.md`.

## Where configuration lives

- `./aiqsa.sh configure` creates secrets once and never rewrites existing `.env` bytes. Malformed security settings fail closed, and missing optional configuration (SMTP, OAuth, parsers, Memory) never weakens authentication or readiness.
- Provider and Search credentials and other mutable configuration live in encrypted database records, not in the environment. Sign-in methods are configured in the admin panel; `AIQSA_GOOGLE_OAUTH_*` and `AIQSA_YANDEX_OAUTH_*` only apply while no admin configuration of that provider is active. Bootstrap, session, proxy and base URL settings are environment-only.
- Each container role gets only the authority it uses: parsers have no data or provider credentials, the runner only its internal token and runtime policy, maintenance no object or provider credentials, restore review no provider credentials. Keep it that way when editing Compose files.
- Test authentication, fake providers, demo credentials and the deterministic runtime turn on only when every disposable, non-production gate is set, and never against persistent data. Telegram's test update route and the loopback-only `AIQSA_TELEGRAM_API_ORIGIN` are such fakes.
- Accepted risk: each host added to `AIQSA_ARTIFACT_LIBRARY_HOSTS` or `AIQSA_ARTIFACT_IMAGE_HOSTS` widens model-controlled URL egress (`lib/server/artifacts/resourcePolicy.ts`); the operator accepts that disclosure.
- `AIQSA_NATIVE_ENGINE_USERS` is the native agent engine's allowlist (operator decision 2026-10-23): the runs of listed users that the engine can run use it, from every entry point (`lib/server/engine/routing.ts`); `*` is everyone, the switch. Startup logs only its mode and size.

## Secrets and rotation

- Keep `.env` out of Git, images, logs, transcripts and support bundles. Production provisioning and rotation belong to the infrastructure operator.
- Session and flow signing, `AIQSA_ENCRYPTION_KEY`, the Memory fingerprint and routing keys and the Workspace token are independent; never derive one from another. The encryption and Memory keys are backed up separately from data.
- Replacing `AIQSA_ENCRYPTION_KEY` without a migration makes every encrypted provider, SMTP, MCP, OAuth, TOTP and sign-in secret unreadable.
- Memory fingerprint rotation is additive, and a missing historical key version blocks the affected state. Rotating the routing key requires a full rebuild of the derived lexical index before readiness; mixed keys are never a fallback. The routing key also derives, under its own label, the gateway routing keys of native runs' model calls (`lib/server/providers/gatewayRouting.ts`); rotating it costs them only prompt-cache hits.
- The trusted base URL decides callback and email origins, cookie defaults and same-origin policy; request Host and forwarding headers never select it. Changing it is an identity and security migration.

## Running Compose

- Each checkout owns its ignored `.env` and private Compose overrides. Preserve its project name, ports, keys and volumes.
- When `.env` defines `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, use plain `docker compose`. An explicit `-f`, including inside npm scripts, replaces that selection, so use it only for a deliberately chosen topology. `-p` cannot isolate external volumes, and stable volume names prove nothing about isolation.
- Environment changes apply only when containers are recreated (`docker compose up -d`); a restart keeps the old environment.
- Production logs go to the host journal. Hosts without journald select `compose.json-file-logging.yaml` through `COMPOSE_FILE`; the log driver cannot be switched by variable interpolation because Docker rejects json-file options for journald.
- The Memory lexical backend rollout belongs to infrastructure; PostgreSQL is the default and rollback target. The coordinator lease governs replay safety, not provider timeouts: a shorter lease can wrongly mark healthy calls outcome-unknown, a longer one delays crash recovery.
