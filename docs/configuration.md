# Configuration

AIQSA reads operator settings from `.env` through Docker Compose. Start from the example and keep the resulting file private:

```bash
cp .env.example .env
chmod 600 .env
```

Fill every value marked required. LLM providers and email delivery are configured after sign-in and do not require a restart. Rebuild/restart the stack only after changing infrastructure or root-of-trust settings:

```bash
docker compose up -d --build
```

## Required settings

### Application and initial administrator

| Variable | Purpose |
| --- | --- |
| `AIQSA_AUTH_SESSION_SECRET` | High-entropy key used to sign browser sessions. Generate one with `openssl rand -hex 32`. |
| `AIQSA_ENCRYPTION_KEY` | Base64-encoded 32-byte key for purpose-bound MCP, provider, and SMTP secret envelopes. Generate one with `openssl rand -base64 32`, back it up separately, and do not reuse the session secret. |
| `AIQSA_INITIAL_ADMIN_EMAIL` | Email of the first administrator and the stable adoption key on later starts. |
| `AIQSA_INITIAL_ADMIN_PASSWORD` | Initial password. Required only while the database is empty. |
| `AIQSA_INITIAL_ADMIN_DISPLAY_NAME` | Optional display name; defaults to `Administrator`. |
| `AIQSA_INITIAL_ADMIN_USER_ID` | Optional UUID. Leave blank to generate one on first start. |

The startup job applies committed database migrations and bootstraps an empty installation. Later runs preserve users, passwords, settings, grants, chats, and uploads while synchronizing code-owned catalog metadata. After the first successful sign-in, you may remove `AIQSA_INITIAL_ADMIN_PASSWORD` from `.env`; keep `AIQSA_INITIAL_ADMIN_EMAIL` unchanged.

### Database and object storage

The default Compose stack includes PostgreSQL and private MinIO storage.

| Variable | Default or requirement |
| --- | --- |
| `AIQSA_POSTGRES_DB` | Database name; default `aiqsa`. |
| `AIQSA_POSTGRES_USER` | Database user; default `aiqsa`. |
| `AIQSA_POSTGRES_PASSWORD` | Required unique database password. |
| `AIQSA_S3_ENDPOINT` | Internal S3 endpoint; default `http://minio:9000`. |
| `AIQSA_S3_REGION` | S3 region; default `us-east-1`. |
| `AIQSA_S3_BUCKET` | Private upload bucket; default `aiqsa-uploads`. |
| `AIQSA_S3_ACCESS_KEY_ID` | Object-storage access key; default `aiqsa`. |
| `AIQSA_S3_SECRET_ACCESS_KEY` | Required unique object-storage secret. |

Use URI-safe hexadecimal secrets such as `openssl rand -hex 32`. The bundled
Compose stack constructs its internal database URL from these values. After an
installation contains data, do not casually change the PostgreSQL database,
user, password, S3 bucket, or volume selection: PostgreSQL initialization
credentials are not reapplied to an existing volume, and another bucket or
volume appears as an empty data set. Rotate them only as an explicit datastore
migration with a verified backup.

PostgreSQL and MinIO data use named Docker volumes. Do not use `docker compose down -v` unless you intentionally want to delete the installation data.

### AI providers

Sign in as the initial administrator and open `Control Center -> Providers`. For the normal OpenAI, Anthropic, or OpenRouter setup, stay in **Personal setup**: choose the provider, paste its API key, select **Test & Save**, and then use **Start chatting** from the Ready result. If the key cannot use the recommended model, AIQSA asks for one model choice before retrying the same atomic save. A single administrator does not need to create a group or visit Model access for this path. The key is write-only, and a failed test or save does not partially replace the last working configuration.

Open **Advanced configuration** only for custom endpoints, multiple credentials, group-specific authentication policy, explicit deployments/routing, activation lifecycle, diagnostics, or Run profiles. Connections, models, routing, credentials, activation evidence, and stored diagnostics live in PostgreSQL. Changes apply to future runs without rebuilding or restarting AIQSA, and provider secrets remain write-only in the UI.

For advanced OpenRouter routing, load the account-filtered model list, choose a model, optionally choose ordered downstream providers, and activate the tested draft. Activation checks each referenced default/group key once against its account model catalog; there is no manual model-by-key test matrix. `Check model route` is an optional diagnostic. `Automatic` lets OpenRouter route with AIQSA's fixed privacy defaults; `Only selected providers` denies fallback outside the chosen list. Custom OpenAI-compatible deployments require an explicit `Responses` or `Chat Completions` protocol choice and a standard authenticated Models endpoint for key validation.

Model/search grants and provider credentials are separate. `Model access` decides what a user may select. A connection may use one default administrator-owned credential, or administrators may assign different credentials to groups. Overlapping group assignments to different credentials fail closed instead of choosing one silently.

Provider safety bounds are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIQSA_PROVIDER_TIMEOUT_MS` | `30000` | Complete non-streaming exchange timeout. |
| `AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS` | `30000` | Maximum pause between streaming chunks. |
| `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` | `16777216` | Maximum untrusted provider response body. |
| `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` | `660000` | Overall OpenAI background-response polling deadline. |

## MCP servers

MCP is installation-managed. An administrator uses `Control Center -> MCP servers` to create a draft, test its exact configuration and discovered tools, activate it, and grant the whole server to users or groups. Direct user access can additionally permit specific administrator-declared personal fields. Ordinary users can only enable entitled servers, fill those fields, or connect their own external OAuth identity under `Settings -> MCP & tools`; they cannot change endpoints, packages, commands, scopes, or tool grants.

The initial source matrix supports:

- remote Streamable HTTP endpoints, with static headers or per-user OAuth;
- npm packages materialized through an exact-version `npx://` image;
- PyPI packages materialized through an exact-version `uvx://` image;
- digest-pinned OCI stdio images using the image's declared entrypoint.

`Paste MCP config` recognizes direct URLs and common `npx`, `uvx`/`pipx`, and `docker`/`podman` shapes, then shows the normalized draft before it is saved. Package selectors are resolved during draft testing; active revisions run the recorded artifact rather than resolving a mutable selector on every start. Updates are explicit. OCI command/entrypoint overrides and legacy HTTP+SSE are not part of the initial matrix.

All valid tools exposed by a granted server are available; there is no per-tool allowlist or confirmation layer. A user may enable several servers at once, and the model may pass conversation-derived data or one tool's output into another enabled tool. Grant only servers whose complete behavior and external data policy you trust.

Remote MCP traffic is sent directly by AIQSA through its reviewed client boundary. Local package/OCI servers run as ToolHive-managed sibling containers. ToolHive is pinned and reachable only on a private Compose network, but it receives `/var/run/docker.sock`; control of that socket is effectively control of the Docker host. The application can call ToolHive's private unauthenticated API, so an application compromise is transitively a host compromise. This is an accepted small-installation trust model, not a sandbox against a malicious administrator or MCP package.

AIQSA encrypts shared values, personal values, and OAuth tokens in PostgreSQL with `AIQSA_ENCRYPTION_KEY`. For a local MCP, the exact effective values are then sent to ToolHive as ordinary environment variables and remain inspectable in ToolHive state and Docker container metadata by trusted application/host/Docker administrators. Docker does not encrypt those values. Remote static and OAuth credentials are not sent to ToolHive in normal operation.

MCP failures do not make core application readiness fail. The user surface reports each server as disabled, needing setup/authorization, queued/starting, ready/idle, requiring reauthorization, or unavailable. Enabled but unready servers block a new run instead of being silently omitted. Startup and normal authenticated activity prewarm enabled servers; several ready servers contribute their complete current tool inventories to the same run. Settings prevents a known combined inventory above 128 tools, while Send performs the authoritative freshness/schema/context check.

Dynamic MCP workload containers are not Compose project members. AIQSA normally reconciles and drains its exact opaque ownership group, while the maintenance command provides a planned uninstall/recovery path. Keep the stack running and preview first:

```bash
docker compose run --rm mcp-maintenance
```

Delete only exact AIQSA-owned ToolHive workloads and their empty ownership group with:

```bash
docker compose run --rm mcp-maintenance --execute
```

Both commands require the installation's current `AIQSA_ENCRYPTION_KEY`; a different key derives a different ownership marker and cannot identify the old workloads. The command never deletes an unknown group member. It does not remove cached local images, PostgreSQL records, or unrelated containers.

## Local address and cookies

The defaults require no domain:

```dotenv
AIQSA_APP_BASE_URL=http://localhost:3000
AIQSA_BIND_ADDRESS=127.0.0.1
AIQSA_PORT=3000
AIQSA_COOKIE_SECURE=
```

`AIQSA_APP_BASE_URL` is the browser-visible origin used for authentication links and OAuth callbacks. `AIQSA_BIND_ADDRESS` and `AIQSA_PORT` control only the host address published by Docker.

When `AIQSA_COOKIE_SECURE` is blank, AIQSA derives it from the base URL: HTTPS enables secure cookies and HTTP disables them. An explicit value must agree with the URL or readiness fails. Keep the default loopback bind unless a reverse proxy or trusted private network is providing access.

## Email (optional)

SMTP is not needed for the initial administrator or normal local use. Open `Control Center -> Email delivery`, save a draft, send its one-off test to an explicit recipient, and activate the tested version. Choose implicit TLS, required STARTTLS, or the explicitly warned credential-free internal plaintext mode. The password is write-only; saving an omitted password preserves it, replacement is explicit, and clearing is confirmation-gated.

Activation and Disable affect the next send without restart. A failed draft test does not disturb the active version. Without active SMTP, password-reset and verification messages cannot be delivered, while an administrator can still copy newly created invitation links manually.

The optional `AIQSA_SMTP_CONNECT_TIMEOUT_MS`, `AIQSA_SMTP_COMMAND_TIMEOUT_MS`, and `AIQSA_SMTP_TOTAL_TIMEOUT_MS` values default to 10,000, 15,000, and 60,000 milliseconds respectively.

## Upgrading legacy provider/SMTP environment settings

ADR 0022/0023 use a full stopped cutover, not a compatibility mode:

1. Stop the old application and take a coordinated PostgreSQL/object-storage backup.
2. Keep the old provider and SMTP variables in the private `.env` for the first upgraded `docker compose up -d --build` only. The one-shot tools container holds the installation lock, upgrades MCP envelopes, and imports complete legacy values as disabled, untested encrypted drafts. It performs no provider/SMTP network request.
3. Sign in and review each imported draft in Control Center. For providers, review the imported endpoint, models, and credential assignments, then Activate; activation validates every referenced imported key, while model/route diagnostics remain optional. For SMTP, run its exact-draft Test and Activate it.
4. Remove the old provider keys/base URLs and SMTP connection/password variables from `.env`; they never enter the application container and are not a fallback.

Partial or structurally invalid legacy input aborts the atomic cutover with a value-free field-class error. Recover by restoring the required pre-cutover backup, correcting the source values, and rerunning; mixed old/new authority is unsupported.

## Google and Yandex sign-in (optional)

Google sign-in is enabled only when both variables are set:

```dotenv
AIQSA_GOOGLE_OAUTH_CLIENT_ID=
AIQSA_GOOGLE_OAUTH_CLIENT_SECRET=
```

Register this callback with Google:

```text
${AIQSA_APP_BASE_URL}/api/auth/oauth/google/callback
```

Yandex follows the same paired rule:

```dotenv
AIQSA_YANDEX_OAUTH_CLIENT_ID=
AIQSA_YANDEX_OAUTH_CLIENT_SECRET=
```

Register `${AIQSA_APP_BASE_URL}/api/auth/oauth/yandex/callback` and grant `login:info` plus `login:email`.

These Google/Yandex credentials are used only for sign-in, and AIQSA does not retain those providers' access or refresh tokens. MCP OAuth is configured independently on each remote MCP server by an administrator; its per-user tokens are encrypted with `AIQSA_ENCRYPTION_KEY`. A public OAuth setup normally needs a domain and HTTPS, but neither is required when OAuth is disabled.

## Reverse proxy (optional)

Set `AIQSA_TRUST_PROXY_HEADERS=1` only when AIQSA is behind a trusted proxy that overwrites client-supplied forwarding headers. `AIQSA_TRUSTED_PROXY_COUNT` defaults to one trusted hop. A direct local installation should leave both blank.

For an HTTPS reverse proxy, use an `https://` base URL, set `AIQSA_COOKIE_SECURE=1`, keep `AIQSA_BIND_ADDRESS=127.0.0.1`, and configure the proxy to forward to `AIQSA_PORT`.

## Upload and container limits

`AIQSA_UPLOAD_MAX_BYTES` defaults to `25000000` bytes. Keep any reverse-proxy request-body limit slightly above it.

The following advanced Compose settings have bounded defaults and normally need no changes:

| Variable | Default |
| --- | --- |
| `AIQSA_APP_IMAGE` | `aiqsa-app:local` |
| `AIQSA_TOOLS_IMAGE` | `aiqsa-tools:local` |
| `AIQSA_APP_REVISION` | blank |
| `AIQSA_APP_CPU_LIMIT` / `AIQSA_APP_MEMORY_LIMIT` | `2.0` / `2g` |
| `AIQSA_TOOLS_CPU_LIMIT` / `AIQSA_TOOLS_MEMORY_LIMIT` | `1.0` / `1g` |
| `AIQSA_POSTGRES_CPU_LIMIT` / `AIQSA_POSTGRES_MEMORY_LIMIT` | `1.0` / `1g` |
| `AIQSA_MINIO_CPU_LIMIT` / `AIQSA_MINIO_MEMORY_LIMIT` | `1.0` / `1g` |
| `AIQSA_LOG_MAX_FILES` / `AIQSA_LOG_MAX_SIZE` | `5` / `10m` |
| `AIQSA_POSTGRES_VOLUME_NAME` | `aiqsa_postgres_data` |
| `AIQSA_MINIO_VOLUME_NAME` | `aiqsa_minio_data` |
| `AIQSA_TOOLHIVE_VOLUME_NAME` | `aiqsa_toolhive_data` |

`AIQSA_APP_REVISION` is optional release metadata used by backup manifests when the checkout does not contain Git metadata; release automation must export it when invoking the backup helper. The volume-name overrides are for adopting existing Docker volumes during a migration; fresh installations should keep the stable defaults. ToolHive state is disposable observed runtime state, not the source of MCP definitions or credentials.

## Emergency login

Normal operation must leave `AIQSA_BOOTSTRAP_LOGIN_ENABLED` blank. For a temporary administrator-recovery window, set it to `1`, set `AIQSA_BOOTSTRAP_USER_ID` to the target existing user's UUID, and configure either a high-entropy `AIQSA_BOOTSTRAP_AUTH_TOKEN` or its SHA-256 value in `AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256`. The recovery UUID is not optional when the initial administrator UUID was generated automatically.

Readiness deliberately remains unhealthy while emergency login is enabled. Disable it and remove the token immediately after recovery.
