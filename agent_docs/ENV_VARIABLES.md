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

- `./aiqsa.sh configure` creates secrets once and never rewrites existing `.env` bytes. Malformed security settings fail closed, and missing optional configuration (SMTP, OAuth, parsers) never weakens authentication or readiness.
- Provider and Search credentials and other mutable configuration live in encrypted database records, not in the environment. Sign-in methods are configured in the admin panel (`agent_docs/SIGN_IN.md`). Bootstrap, session, proxy and base URL settings are environment-only.
- Each container role gets only the authority it uses: parsers have no data or provider credentials, the runner only its internal token and runtime policy, maintenance no object or provider credentials, restore review no provider credentials. Keep it that way when editing Compose files.
- Test authentication, fake providers, demo credentials and the deterministic runtime turn on only when every disposable, non-production gate is set, and never against persistent data. Telegram's test update route and the loopback-only `AIQSA_TELEGRAM_API_ORIGIN`, `AIQSA_DISCORD_API_ORIGIN` and `AIQSA_DISCORD_GATEWAY_URL` are such fakes.
- `AIQSA_DISCORD_CONNECT_ADDRESS` (optional, operator decision 2026-11-12) is one public IPv4 or IPv6 address every Discord connection goes to, with Discord's own SNI, Host and certificate, for an operator-run SNI forwarder; unset means system DNS, which honours `/etc/hosts` and Compose `extra_hosts`. Any other value stops Discord Connect at start with `discord_connect_address_invalid` rather than falling back to DNS (`agent_docs/ARCHITECTURE.md`).
- Accepted risk: each host added to `AIQSA_ARTIFACT_LIBRARY_HOSTS` or `AIQSA_ARTIFACT_IMAGE_HOSTS` widens model-controlled URL egress (`lib/server/artifacts/resourcePolicy.ts`); the operator accepts that disclosure.

## Secrets and rotation

- Keep `.env` out of Git, images, logs, transcripts and support bundles. Production provisioning and rotation belong to the infrastructure operator.
- Session and flow signing, `AIQSA_ENCRYPTION_KEY`, the gateway routing key and the Workspace token are independent; never derive one from another. The encryption and routing keys are backed up separately from data.
- Replacing `AIQSA_ENCRYPTION_KEY` without a migration makes every encrypted provider, SMTP, MCP, OAuth, TOTP and sign-in secret unreadable.
- `AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY` keeps its name although it no longer keys a search index (decision 2026-10-23), so existing `.env` files and `./aiqsa.sh configure` keep working. It only derives, under its own label, the gateway routing keys of native runs' model calls (`lib/server/providers/gatewayRouting.ts`); rotating it costs them only prompt-cache hits.
- The trusted base URL decides callback and email origins, cookie defaults and same-origin policy; request Host and forwarding headers never select it. Changing it is an identity and security migration.

## Running Compose

- Each checkout owns its ignored `.env` and private Compose overrides. Preserve its project name, ports, keys and volumes.
- When `.env` defines `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`, use plain `docker compose`. An explicit `-f`, including inside npm scripts, replaces that selection, so use it only for a deliberately chosen topology. `-p` cannot isolate external volumes, and stable volume names prove nothing about isolation.
- Environment changes apply only when containers are recreated (`docker compose up -d`); a restart keeps the old environment.
- Production logs go to the host journal. Hosts without journald select `compose.json-file-logging.yaml` through `COMPOSE_FILE`; the log driver cannot be switched by variable interpolation because Docker rejects json-file options for journald.
- Upgraded `.env` files may still set variables of the removed search index service (decision 2026-10-23) and of the old Memory: every `AIQSA_MEMORY_*` key, the fingerprint keyring included, except the routing key above and the worker's resource limits (`AIQSA_MEMORY_WORKER_*`) (decision 2026-11-22). Nothing reads them, and Compose starts with or without them. The background worker keeps its `memory-worker` service name (`agent_docs/ARCHITECTURE.md`).
