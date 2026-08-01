# AIQSA

[![Release](https://github.com/insciqq/AIQSA/actions/workflows/release.yml/badge.svg)](https://github.com/insciqq/AIQSA/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/insciqq/AIQSA)](https://github.com/insciqq/AIQSA/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/github/license/insciqq/AIQSA)](LICENSE)

Self-hosted Question → Search → Answer for people and small teams who want an AI workspace with explicit control over providers, models, Search, and run data.

![AIQSA conversation workspace with model and search controls](.github/assets/aiqsa-workspace.png)

AIQSA combines a conversation UI with inspectable execution: users choose a concrete model and an ordered plan of up to three entitled Search engines, then inspect citations, per-engine evidence, reasoning, events, usage, and branch history. Workspace data stays in PostgreSQL and private S3-compatible storage; content selected for a run is sent to the configured answer provider, while client Search receives only a bounded generated query.

## Highlights

- Native OpenAI, Anthropic, Gemini Interactions, and OpenRouter adapters, plus manual OpenAI-compatible Chat endpoints.
- Admin-managed Search integrations, provider/model entitlements, run profiles, SMTP, and MCP servers.
- Branchable conversations, projects, prompt presets, private attachments, and sanitized anonymous snapshots.
- Inspectable citations, reasoning, provider events, request previews, tool activity, and token usage.
- Multi-user accounts, invitations, access rules, optional Google/Yandex sign-in, and an admin console.

## Quick start

You need Docker Engine with the Docker Compose plugin and OpenSSL.

```bash
git clone https://github.com/insciqq/AIQSA.git aiqsa
cd aiqsa
bash prepare-secrets.sh
docker compose pull
docker compose up -d
```

The setup helper asks only for the initial administrator email, generates the initial password and infrastructure secrets, writes `.env` with mode `0600`, and prints the administrator password once. Save that password in a password manager. For unattended setup:

```bash
bash prepare-secrets.sh --admin-email owner@example.com
```

To configure manually instead, copy `.env.example` to `.env`, set mode `0600`, and replace every required placeholder. Never commit `.env`. `agent_docs/ENV_VARIABLES.md` owns the complete current environment contract.

Open [http://localhost:3000](http://localhost:3000) and sign in with the initial administrator. In `Control Center -> Providers`, choose OpenAI, Anthropic, Gemini, or OpenRouter, paste its API key, and select **Test & Save**. Provider keys, SMTP configuration, Search integrations, and MCP definitions are database-managed and normally require no restart.

PostgreSQL and uploaded objects live in named Docker volumes. A normal rebuild or update preserves them. Never run `docker compose down -v` unless permanent deletion of installation data is intentional.

## Exposed installation

The default application is intentionally bound to loopback. For public access, keep that bind, set an HTTPS `AIQSA_APP_BASE_URL`, enable secure cookies and the exact trusted-proxy declaration, and expose only a reverse proxy. Do not publish PostgreSQL, MinIO, ToolHive control, or MCP proxy ports.

The repository includes an [Nginx template and validation procedure](ops/nginx/README.md). For the bundled one-hop template use:

```dotenv
AIQSA_COOKIE_SECURE=1
AIQSA_TRUST_PROXY_HEADERS=1
AIQSA_TRUSTED_PROXY_COUNT=1
```

ToolHive can run administrator-selected npm, PyPI, or digest-pinned OCI MCP servers in sibling containers. ToolHive has trusted access to the host Docker socket, which is effectively host-root authority. Install only reviewed MCP code and grant a server only when its complete tool and external-data behavior is trusted.

## Backups and updates

Back up before an update that may apply migrations:

```bash
ops/backup/create.sh /secure/aiqsa-backups
ops/backup/restore.sh --verify-only /secure/aiqsa-backups/aiqsa-backup-TIMESTAMP
```

Use an existing protected directory, copy verified bundles to encrypted off-host storage, and back up `AIQSA_ENCRYPTION_KEY` separately. The bundled helper supports the bundled private MinIO storage; external S3 requires its own consistent object-backup procedure coordinated with PostgreSQL.

Update an existing checkout with:

```bash
git pull --ff-only
docker compose pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health/ready
```

The startup job applies committed migrations before the application becomes ready. Existing users, settings, chats, and uploaded objects remain in the configured volumes. Pin `AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:X.Y.Z` in `.env` when a fixed release is preferred over `latest`.

For automated backups, use the colocated [systemd timer templates](ops/systemd/README.md). Restore operations accept only explicitly named disposable targets and never overwrite canonical live services.

## Development

Routine deterministic checks need no database, provider key, or external service:

```bash
npm ci
npm run check:hermetic
```

Container parity uses only the separate disposable development topology:

```bash
docker compose -f docker-compose.dev.yml up -d
npm run check:container
```

Never use the default persistent Compose installation as a development or test target. The complete current verification contract is in `agent_docs/TESTING.md`.

AIQSA is pre-1.0 and intended for small, operator-managed, single-replica installations. It is not currently an HA system.

## License

AIQSA is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
