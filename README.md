<div align="center">

<img src="public/icon.svg" width="88" alt="AIQSA logo">

# AIQSA

**Self-hosted, model-agnostic AI workspace for teams.**

One conversation-first interface for OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, and OpenAI-compatible models, with MCP tools, web search, private Knowledge bases, and Memory. Runs on your own infrastructure with Docker Compose.

<p>
  <a href="https://github.com/insciqq/AIQSA/releases/latest"><img src="https://img.shields.io/github/v/release/insciqq/AIQSA?display_name=tag&color=38dfd0&labelColor=0c1517" alt="Latest release"></a>
  <a href="https://github.com/insciqq/AIQSA/actions/workflows/ci.yml"><img src="https://github.com/insciqq/AIQSA/actions/workflows/ci.yml/badge.svg" alt="Hermetic checks"></a>
  <a href="https://github.com/insciqq/AIQSA/actions/workflows/release.yml"><img src="https://github.com/insciqq/AIQSA/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="https://github.com/insciqq/AIQSA/pkgs/container/aiqsa"><img src="https://img.shields.io/badge/ghcr.io-insciqq%2Faiqsa-2496ED?logo=docker&logoColor=white" alt="Docker image"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/insciqq/AIQSA?color=blue" alt="License: AGPL-3.0"></a>
</p>

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#integrations">Integrations</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#deployment-notes">Deployment</a> ·
  <a href="#development">Development</a> ·
  <a href="#contributing">Contributing</a>
</p>

</div>

<br>

![AIQSA chat workspace: model picker, composer with Workspace, Search, Knowledge, and MCP controls, and the chat sidebar with workspaces and projects](.github/assets/aiqsa-chat.png)

<br>

AIQSA is a multi-user web interface for working with large language models without tying an installation to one vendor. Pick the exact model for each message, add MCP tools, Knowledge, Memory, or web search only when they help, and keep conversations, Projects, Assistants, and files in one workspace that you host yourself.

The interface keeps control explicit and the conversation calm. You choose the model and optional capabilities before sending, see concise live status while work is in progress, and get the answer with Sources, generated outputs, and direct follow-up actions. Provider requests, retrieval internals, and tool traces stay private operational data instead of becoming a second inspection UI.

## Why AIQSA

- **Any provider, one interface.** Native adapters for OpenAI, Anthropic, Gemini, DeepSeek, and OpenRouter, plus any OpenAI-compatible endpoint. Switch models per message.
- **Capabilities are opt-in.** Enable MCP servers, an ordered web-search plan, Knowledge bases, or Memory per message instead of forcing every conversation through the same pipeline.
- **Conversation-first answers.** Read the response, open Sources or generated files when present, then continue, branch, or regenerate. No execution dashboard to navigate.
- **Built for operator-managed teams.** Accounts, invitations, access groups, provider credentials, model availability, search integrations, SMTP, and MCP servers are managed from the Control Center.
- **Your data stays yours.** Workspace state lives in PostgreSQL and private S3-compatible storage. Only the content selected for a run is sent to the provider and tools used by that run.

## Features

<table>
<tr>
<td width="50%" valign="top">

**Conversations**<br>
Branchable message history, Projects with role-based access, nested folders, private attachments, chat continuation summaries, and sanitized read-only share links.

</td>
<td width="50%" valign="top">

**Exact model control**<br>
Per-model parameters, optional reasoning and streaming settings where a provider supports them, and a server-filtered catalog so the browser can never select a hidden or unavailable target.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Knowledge**<br>
Private Knowledge bases with hybrid vector and lexical retrieval over native document text and printed Russian/English text recognized from scanned PDFs and images. Optional hosted reranking.

</td>
<td width="50%" valign="top">

**Web search**<br>
Ordered search plans with up to three sources per message, compatibility checks, normalized citations, and answer-bound Sources.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**MCP tools**<br>
Remote Streamable HTTP servers or ToolHive-managed npm, PyPI, and OCI servers in sibling containers. OAuth flows, readiness checks, per-user enablement, and approval before protected tool execution.

</td>
<td width="50%" valign="top">

**Memory**<br>
Explicitly saved facts and retained-chat recall with private management, lifecycle, and deletion controls. The same facts are available to external MCP clients such as Claude Code and Codex CLI.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Assistants**<br>
Save a model, instructions, run controls, Search plan, MCP allowlist, and starter prompts as one versioned, shareable object with exact revision provenance on every run.

</td>
<td width="50%" valign="top">

**Workspace (optional)**<br>
Let the model run commands and work with files inside an isolated micro-VM sandbox (Microsandbox on KVM), enabled per installation through the `workspace` Compose profile.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Administration**<br>
Multi-user accounts, invitations, access rules and groups, optional Google and Yandex sign-in, usage views, and a Control Center for providers, models, search, SMTP, and MCP.

</td>
<td width="50%" valign="top">

**Interface**<br>
System, light, and dark themes, responsive desktop and mobile layouts, code and math rendering, and private S3-compatible uploads.

</td>
</tr>
</table>

## Quick start

You need Docker Engine with the Docker Compose plugin and OpenSSL.

```bash
git clone https://github.com/insciqq/AIQSA.git aiqsa
cd aiqsa
bash prepare-secrets.sh
docker compose pull --ignore-buildable
docker compose build docling
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the initial administrator. In **Control Center → Providers**, choose a provider, paste its API key, and select **Test & Save**. Provider keys, SMTP, search integrations, and MCP definitions are stored in the database and normally need no restart.

The setup helper asks only for the initial administrator email, generates the password and installation secrets, writes `.env` with mode `0600`, and prints the administrator password once. Save it in a password manager. For unattended setup:

```bash
bash prepare-secrets.sh --admin-email owner@example.com
```

To configure manually, copy `.env.example` to `.env`, set mode `0600`, and replace every required placeholder. Never commit `.env`. The complete environment contract is in [`agent_docs/ENV_VARIABLES.md`](agent_docs/ENV_VARIABLES.md).

> [!IMPORTANT]
> PostgreSQL and uploaded objects live in named Docker volumes and survive normal rebuilds and updates. Never run `docker compose down -v` unless permanent deletion of installation data is intended.

The Docling parser image is built locally from a digest-pinned upstream image with checksum-pinned English/Cyrillic OCR assets. The build needs registry and model download access; document conversion afterwards uses the sealed local assets only.

## Integrations

| Area | Supported today |
| --- | --- |
| **Model providers** | OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, and any OpenAI-compatible endpoint |
| **Web search** | OpenAI web search, Anthropic web search, Gemini Google Search grounding, DeepSeek web search, and Perplexity Sonar through OpenRouter |
| **Tools** | Remote MCP servers over Streamable HTTP, and npm, PyPI, or digest-pinned OCI MCP servers run by ToolHive |
| **Documents** | PDF, office, and text formats through Docling and Apache Tika, with printed Russian/English OCR for scans and images |
| **Sign-in** | Email and password with invitations, plus optional Google and Yandex OAuth |
| **Storage** | PostgreSQL with pgvector, S3-compatible object storage (bundled MinIO), and OpenSearch for rebuildable lexical indexes |
| **Delivery** | Multi-platform images on GHCR with immutable digests, a companion pgvector PostgreSQL image, and a guarded tagged-release update workflow |

## Architecture

AIQSA is a TypeScript / Next.js modular monolith: browser UI, authenticated route handlers, domain logic, persistence, and external adapters ship as one application. The supported production shape is a single-host, single-replica Docker Compose installation in which the app is the only public boundary.

```mermaid
flowchart TB
  subgraph users [" "]
    direction LR
    Browser["Browser"]
    Clients["External MCP clients<br/>Claude Code, Codex CLI, …"]
  end

  App["AIQSA app · Next.js / Node.js"]

  subgraph private ["Private networks, no public ports"]
    direction LR
    PG[("PostgreSQL<br/>+ pgvector")]
    S3[("MinIO /<br/>S3 storage")]
    OS[("OpenSearch<br/>lexical index")]
    Parsers["Docling / Tika<br/>parsers"]
    ToolHive["ToolHive<br/>MCP runtime"]
    WS["Workspace runner<br/>micro-VM sandbox"]
  end

  subgraph external ["External services, bounded adapters only"]
    direction LR
    Providers[["Model providers<br/>+ provider web search"]]
    Remote[["Remote MCP servers"]]
  end

  Browser --> App
  Clients -- "/mcp" --> App
  App --> PG & S3 & OS & Parsers & ToolHive
  App -. "optional profile" .-> WS
  App --> Providers & Remote
```

- **PostgreSQL** owns tenancy, conversations, runs, immutable accepted bindings, and recovery state. Vectors live in pgvector.
- **Object storage** owns attachment, Knowledge, and generated Workspace bytes behind relational ownership checks. It is never a public file host.
- **OpenSearch** holds only rebuildable Knowledge and Memory lexical projections; PostgreSQL revalidates every hit before it is used.
- **Sidecars** (parsers, ToolHive, Workspace runner) are bounded helpers on private networks with no database, storage, or provider credentials.

The durable boundaries and their rationale are in [`agent_docs/ARCHITECTURE.md`](agent_docs/ARCHITECTURE.md).

## Personal Memory over MCP

Each user can authorize a compatible external MCP client to use the same Personal Memory facts as the AIQSA Memory UI. Use the installation's public URL with `/mcp`, for example `https://aiqsa.example/mcp`. This is an inbound connection to AIQSA and is separate from the MCP servers that AIQSA calls from its own chats.

```bash
# Claude Code: add the server, then run /mcp inside Claude Code to finish browser authentication
claude mcp add --transport http aiqsa-memory https://aiqsa.example/mcp

# Codex CLI
codex mcp add aiqsa-memory --url https://aiqsa.example/mcp
codex mcp login aiqsa-memory

# Protocol check with MCP Inspector (Streamable HTTP, same /mcp URL, complete its OAuth flow)
npx -y @modelcontextprotocol/inspector
```

The consent page names the client and grants one fact-only permission. The client can discover `add_memory`, `search_memories`, `list_memories`, `get_memory`, `update_memory`, and `delete_memory`. It cannot read chat history, and AIQSA does not run a model or compose answers for these calls; the model in the external client decides when to use the tools. Semantic search may still use AIQSA's configured Memory embedding and score-only reranker routes.

Review or revoke a client in **Settings → Connected apps**. Revocation stops future calls for that client and keeps every stored fact. See the [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [MCP Inspector](https://github.com/modelcontextprotocol/inspector) documentation for client-specific behavior.

## Deployment notes

<details>
<summary><strong>Network exposure and reverse proxy</strong></summary>

<br>

The default application is intentionally bound to loopback. A trusted LAN or VPN may publish the app directly without another service by setting `AIQSA_BIND_ADDRESS=0.0.0.0`, using the matching browser-visible HTTP URL, and leaving both proxy variables blank. The release runtime ignores client forwarding headers in this mode and derives login-admission identity from the immediate TCP peer. Direct HTTP is unencrypted and emits a startup warning; an intermediary or NAT may make several users share one peer bucket.

For Internet access or transport security, keep the application bind on loopback, set an HTTPS `AIQSA_APP_BASE_URL`, enable secure cookies and the exact trusted-proxy declaration, and expose only a reverse proxy. Do not publish PostgreSQL, MinIO, ToolHive control, or MCP proxy ports.

The repository includes an [Nginx template and validation procedure](ops/nginx/README.md). For the bundled one-hop template use:

```dotenv
AIQSA_COOKIE_SECURE=1
AIQSA_TRUST_PROXY_HEADERS=1
AIQSA_TRUSTED_PROXY_COUNT=1
```

ToolHive can run administrator-selected npm, PyPI, or digest-pinned OCI MCP servers in sibling containers. ToolHive has trusted access to the host Docker socket, which is effectively host-root authority. Install only reviewed MCP code and grant a server only when its complete tool and external-data behavior is trusted.

</details>

<details>
<summary><strong>Backups and disaster recovery</strong></summary>

<br>

Back up before an update that may apply migrations:

```bash
ops/backup/create.sh /secure/aiqsa-backups
ops/backup/restore.sh --verify-only /secure/aiqsa-backups/aiqsa-backup-TIMESTAMP
```

Use an existing protected directory, copy verified bundles to encrypted off-host storage, and back up `AIQSA_ENCRYPTION_KEY`, `AIQSA_MEMORY_FINGERPRINT_KEYRING`, and `AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY` separately from those bundles. The helper stops and restores the web and Memory-worker roles around a durable lease fence; restore validates only the bundle's non-secret key IDs against the separately recovered keyring. The OpenSearch index is derived and rebuilt after restore rather than backed up. The bundled helper supports the bundled private MinIO storage; external S3 requires its own consistent object-backup procedure coordinated with PostgreSQL.

Disaster recovery is deliberately two-step. Provision a unique private `aiqsa-restore-*` project with [`ops/backup/docker-compose.restore.yml`](ops/backup/docker-compose.restore.yml), restore into its empty Postgres/MinIO services with a new mode-0700 review directory, then reapply any operator-owned post-backup deletion journal. Run `ops/backup/review.sh` with either the applied journal file or an explicit no-journal attestation. The review role has no public port or provider credentials and writes a private promotion receipt only after keys, deletion/account obligations, source barriers, leases, and objects pass. The helpers never start the app or perform production cutover; see each script's `--help` for the exact environment.

For automated backups, use the colocated [systemd timer templates](ops/systemd/README.md). Restore operations accept only unique disposable review projects and never overwrite canonical live services.

</details>

<details>
<summary><strong>Updates and migrations</strong></summary>

<br>

For an existing installation, use the guarded tagged-release workflow whenever the update can cross committed migrations. Release automation must invoke both phases of the tracked cutover gate under the same installation operation lock; inspect its exact fail-closed interface with:

```bash
bash scripts/ops-knowledge-cutover.sh --help
```

The workflow takes the shared deploy/backup/prune operation lock, verifies a fresh backup, stops application writers, and applies migrations before running the resumable V1-to-Source Knowledge backfill. It starts the app and worker only after aggregate reconciliation reports zero discrepancies. Do not replace that sequence with a plain `docker compose up` when upgrading an installation that may contain pre-cutover Knowledge data.

Migration `20260818073000_knowledge_ingestion_v2` rewrites every existing `KnowledgeChunk` row and rebuilds its generated text-search column and GIN index, so the guarded workflow treats it as downtime work. Before migration it rejects open transactions/lock waits and requires PostgreSQL-volume free space of at least 1 GiB or, for a larger chunk relation, three times its current total size plus 512 MiB. A failure before migration restores the previous release and writers. After migration begins, automatic old-code/schema rollback is blocked; the verified backup, pending deployment record, and mode-0600 aggregate cutover evidence remain for operator recovery, while the supported application rollback is a non-destructive Knowledge profile pointer restore.

Existing users, settings, chats, and uploaded objects remain in the configured volumes. Pin `AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:X.Y.Z` in `.env` when a fixed release is preferred over `latest`.

The release pipeline owns a same-Alpine PostgreSQL companion image with pgvector and records its immutable multi-platform digest; Compose adopts that image only after the manifest is published and verified, without changing the existing database volume. An external PostgreSQL deployment used with Knowledge features must make pgvector 0.7 or later available before its schema migration runs; pgvector 0.8.x is recommended for filtered approximate-nearest-neighbor retrieval.

Personal Memory's derived OpenSearch lexical index has a separate [rollout and recovery runbook](ops/opensearch/README.md). Keep reads on `POSTGRES` until its aggregate integrity and shadow qualification gates pass; the runbook covers stable canary progression, immediate rollback, rebuild, restore, deletion verification, and routing-key rotation.

</details>

## Development

Routine deterministic checks need no database, provider key, or external service:

```bash
npm ci
npm run check:hermetic
```

Container parity uses only the separate disposable development topology:

```bash
docker compose -f docker-compose.dev.yml up -d --build
npm run check:container
```

Never use the default persistent Compose installation as a development or test target. The complete verification contract is in [`agent_docs/TESTING.md`](agent_docs/TESTING.md).

| Document | Owns |
| --- | --- |
| [`agent_docs/ARCHITECTURE.md`](agent_docs/ARCHITECTURE.md) | Dependency direction, deployment shape, data and egress boundaries |
| [`agent_docs/ENV_VARIABLES.md`](agent_docs/ENV_VARIABLES.md) | The complete environment and Compose configuration contract |
| [`agent_docs/SECURITY.md`](agent_docs/SECURITY.md) | Threat model, trust boundaries, and dependency-security policy |
| [`agent_docs/TESTING.md`](agent_docs/TESTING.md) | Verification lanes and test-authoring rules |
| [`ops/nginx/README.md`](ops/nginx/README.md) | Reverse-proxy template and validation |
| [`ops/systemd/README.md`](ops/systemd/README.md) | Scheduled backup and prune timers |

## Project status

AIQSA is pre-1.0 and intended for small, operator-managed, single-replica installations. It is not a high-availability system.

The architecture is intended to grow from tool-enabled chat toward agent workflows without presenting planned features as already shipped. Evaluate current releases on the capabilities documented above.

## Contributing

Contributions are welcome. For a substantial product or architecture change, please open an issue first so the intended behavior and scope are clear. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

AIQSA is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
