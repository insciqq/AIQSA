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

```bash
git clone https://github.com/insciqq/AIQSA.git
cd aiqsa
cp .env.example .env
```

Edit `.env` and fill every value marked **required**. In particular, set:

- a random `AIQSA_AUTH_SESSION_SECRET` (for example, from `openssl rand -hex 32`);
- a base64 32-byte `AIQSA_ENCRYPTION_KEY` (for example, from `openssl rand -base64 32`);
- the initial administrator email and password;
- unique PostgreSQL and object-storage passwords;
- at least one real provider key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`.

Then start AIQSA:

```bash
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the initial administrator account from `.env`.

That is enough for local use. A domain, SMTP server, and OAuth credentials are optional. PostgreSQL and uploaded objects live in named Docker volumes, so a normal rebuild or update does not erase them.

The bundled ToolHive service lets an administrator add remote, npm, PyPI, or digest-pinned OCI MCP servers without changing the one-command bootstrap. Local MCPs run in sibling containers, but ToolHive has trusted access to the host Docker socket; install only MCP code you trust. See [configuration](docs/configuration.md#mcp-servers) before enabling local MCPs.

## Documentation

- [Configuration](docs/configuration.md) — providers, MCP servers, SMTP, OAuth, networking, and all operator settings.
- [Deployment and updates](docs/deployment.md) — running on a server, TLS, backups, and safe updates.
- [Development](docs/development.md) — the separate disposable development and test stack.

AIQSA is pre-1.0 and intended for small, operator-managed installations. It is not currently an HA system and does not provide per-user provider keys or billing.

## License

AIQSA is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
