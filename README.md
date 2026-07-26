# AIQSA

Self-hosted Question → Search → Answer for people and small teams who want an AI workspace with explicit control over providers, models, search, and run data.

![AIQSA conversation workspace with model and search controls](docs/assets/aiqsa-workspace.png)

AIQSA combines a conversation UI with inspectable execution: users can choose a concrete model and search strategy for each run, then review citations, reasoning, events, usage, and branch history. Workspace data stays in your PostgreSQL database and private S3-compatible storage; content selected for a run is sent to the configured AI provider.

## Highlights

- OpenAI, Anthropic, and OpenRouter provider adapters.
- Optional OpenAI web search and Perplexity search through OpenRouter.
- Branchable conversations, saved chats, projects, prompt presets, and attachments.
- Inspectable citations, reasoning, provider events, request previews, and token usage.
- Multi-user accounts, invitations, access rules, model entitlements, and an admin console.
- Admin-managed MCP servers with per-user/group access, personal credentials, multi-server tool use, and isolated local workloads.
- Optional Google and Yandex sign-in.

## Quick start

You need Docker Engine with the Docker Compose plugin.

Copy the HTTPS or SSH clone URL from this repository's **Code** menu. This can
be the upstream repository or your own fork. Then clone it into a stable local
directory name:

```bash
git clone REPOSITORY_URL aiqsa
cd aiqsa
cp .env.example .env
```

Replace `REPOSITORY_URL` with the copied clone URL.

Edit `.env` and fill every value marked **required**. In particular, set:

- a random `AIQSA_AUTH_SESSION_SECRET` (for example, from `openssl rand -hex 32`);
- a base64 32-byte `AIQSA_ENCRYPTION_KEY` (for example, from `openssl rand -base64 32`);
- the initial administrator email and password;
- unique PostgreSQL and object-storage passwords.

Then start AIQSA:

```bash
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the initial administrator account from `.env`.

Then open `Control Center -> Providers`. For OpenAI, Anthropic, or OpenRouter, choose the provider, paste its API key, and select **Test & Save**; the Ready result links straight back to chat. The normal single-administrator path does not require Groups or Model access. Provider keys and SMTP settings are database-managed and are not normal `.env` inputs.

That is enough for local use. A domain, SMTP server, and OAuth credentials are optional. PostgreSQL and uploaded objects live in named Docker volumes, so a normal rebuild or update does not erase them.

The bundled ToolHive service lets an administrator add remote, npm, PyPI, or digest-pinned OCI MCP servers without changing the one-command bootstrap. Local MCPs run in sibling containers, but ToolHive has trusted access to the host Docker socket; install only MCP code you trust. See [configuration](docs/configuration.md#mcp-servers) before enabling local MCPs.

## Updating

AIQSA is built from the current Git checkout and does not update itself. From
the existing installation directory, create a verified backup, pull the branch
configured for that clone, and rebuild the stack:

```bash
ops/backup/create.sh /secure/aiqsa-backups
git pull --ff-only
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health/ready
```

Use an existing protected directory instead of the example backup path. The
startup job applies committed database migrations before the application
becomes ready. The local `.env`, existing users, chats, settings, and uploaded
objects remain in the installation and named Docker volumes. Review release
notes and changes to `.env.example` before large version jumps or when new
configuration is required.

Stopping the stack first is normally unnecessary. Never run
`docker compose down -v` during an update: `-v` deletes the persistent database
and object-storage volumes. See [Deployment and updates](docs/deployment.md) for
backup, migration, recovery, and older-installation guidance.

## Documentation

- [Configuration](docs/configuration.md) — providers, MCP servers, SMTP, OAuth, networking, and all operator settings.
- [Deployment and updates](docs/deployment.md) — running on a server, TLS, backups, and safe updates.
- [Development](docs/development.md) — the separate disposable development and test stack.

AIQSA is pre-1.0 and intended for small, operator-managed installations. It is not currently an HA system and does not provide per-user provider keys or billing.

## License

AIQSA is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
