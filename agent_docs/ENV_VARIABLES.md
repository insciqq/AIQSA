# ENV_VARIABLES

Owner: Runtime configuration maintainers
Scope: Complete current environment-variable inventory, defaults, validation, switch semantics, and supported installation configuration boundaries.

## Ownership And Naming

This document owns the complete runtime environment contract. `README.md` contains the minimal operator setup and safety flow; `.env.example` contains normal-install settings, comments, and non-secret placeholders.

AIQSA has one operator configuration regardless of where it runs. There is no named local/production environment tier and no duplicated setting family. The same canonical variables configure a loopback laptop install, a private server, or an HTTPS installation behind a proxy. Framework/container variables such as `NODE_ENV`, `DATABASE_URL`, `S3_*`, `POSTGRES_*`, and `MINIO_*` are internal wiring unless a command runs outside Compose.

## Required Installation Inputs

```text
AIQSA_AUTH_SESSION_SECRET=
AIQSA_ENCRYPTION_KEY=
AIQSA_INITIAL_ADMIN_EMAIL=
AIQSA_INITIAL_ADMIN_PASSWORD=
AIQSA_INITIAL_ADMIN_DISPLAY_NAME=Administrator
AIQSA_INITIAL_ADMIN_USER_ID=
AIQSA_POSTGRES_DB=aiqsa
AIQSA_POSTGRES_USER=aiqsa
AIQSA_POSTGRES_PASSWORD=
AIQSA_S3_ENDPOINT=http://minio:9000
AIQSA_S3_REGION=us-east-1
AIQSA_S3_BUCKET=aiqsa-uploads
AIQSA_S3_ACCESS_KEY_ID=aiqsa
AIQSA_S3_SECRET_ACCESS_KEY=
```

For a fresh checkout, root `prepare-secrets.sh` is the canonical convenience
path. It creates `.env` from `.env.example` only when the target does not exist,
prompts for `AIQSA_INITIAL_ADMIN_EMAIL` in an interactive terminal (or accepts
`--admin-email`), and generates the initial password plus the four required
secrets with OpenSSL. The completed file is published only after preparation
succeeds and has mode `0600`. An existing target of any kind is a successful
no-op: the helper does not read it, alter permissions, replace values, or repair
partial configuration. Consequently the helper is run instead of a preceding
`cp .env.example .env`; manual creation remains supported.

`AIQSA_AUTH_SESSION_SECRET`, `AIQSA_ENCRYPTION_KEY`, the PostgreSQL password, and the S3/MinIO secret must be deployment-specific high-entropy values. Generate the session secret with `openssl rand -hex 32` or stronger and the encrypted-state key with `openssl rand -base64 32`. Quick Setup derives its state-fence HMAC key from `AIQSA_AUTH_SESSION_SECRET` under the fixed `aiqsa:provider-quick-setup-state-token-key:v1` domain, so no additional environment value is required and changing the session secret invalidates outstanding Quick Setup fences. `AIQSA_ENCRYPTION_KEY` must decode to exactly 32 bytes; purpose/owner/value-bound envelopes use it for MCP values and OAuth tokens, administrator-owned provider credentials, and the SMTP password. It is never reused for sessions or flow signing. Back it up separately from Postgres. Changing or losing it requires an offline migration or re-entry of affected encrypted values. Compose derives the internal `DATABASE_URL`, `POSTGRES_*`, `MINIO_ROOT_*`, and `S3_*` values from these canonical inputs; operators do not duplicate the connection string.

Use URI-safe hexadecimal database/storage secrets because Compose constructs the internal database URL without percent-encoding. Once a persistent volume contains data, changing database initialization credentials does not rewrite that database, and changing the bucket/volume selection exposes a different empty namespace. Such changes require an explicit backed-up datastore migration, not an ordinary env edit.

Fresh installation and core readiness do not require a real LLM provider or SMTP. The initial administrator configures them after sign-in.

The installation bootstrap always requires a valid `AIQSA_INITIAL_ADMIN_EMAIL`. On an empty database it also requires `AIQSA_INITIAL_ADMIN_PASSWORD`, defaults the display name to `Administrator`, and generates a UUID when `AIQSA_INITIAL_ADMIN_USER_ID` is blank. It creates no demo chat. On every later start it adopts the exact verified password identity by normalized email, optionally enforces the explicit UUID, synchronizes only code-owned catalog metadata, and preserves users, passwords, status/role, settings, grants, chats, and attachments. Remove the plaintext initial password after first success but keep the email stable.

## Address, Cookies, And Proxy Trust

```text
AIQSA_APP_BASE_URL=http://localhost:3000
AIQSA_BIND_ADDRESS=127.0.0.1
AIQSA_PORT=3000
AIQSA_COOKIE_SECURE=
AIQSA_TRUST_PROXY_HEADERS=
AIQSA_TRUSTED_PROXY_COUNT=
```

`AIQSA_APP_BASE_URL` is the browser-visible origin used for auth links, callback construction, origin checks, and runtime security headers. `AIQSA_BIND_ADDRESS` and `AIQSA_PORT` control the host publication only. A blank `AIQSA_COOKIE_SECURE` derives secure cookies and HSTS from the base-URL protocol; an explicit value must agree with that protocol or readiness fails. Localhost HTTP is supported. An exposed installation uses an HTTPS base URL, secure cookies, and retains the loopback bind behind a TLS proxy.

`AIQSA_TRUST_PROXY_HEADERS=1` authorizes client rate-limit identity only from an `X-Forwarded-For` chain written by trusted proxies that remove the browser-supplied value. `AIQSA_TRUSTED_PROXY_COUNT` defaults to `1` and declares the exact expected number of comma-separated IP entries (maximum eight); the first canonical address is the client. Missing, extra, empty, malformed, or overlong chains are unavailable identity, and `X-Real-IP` is not a fallback. Leave both variables blank only for direct loopback access. A non-loopback `AIQSA_APP_BASE_URL` without a valid enabled proxy declaration fails readiness, as does any non-loopback `AIQSA_BIND_ADDRESS`; the supported proxy exposes only itself and reaches AIQSA through loopback.

## Provider Safety Bounds

```text
AIQSA_PROVIDER_RESPONSE_MAX_BYTES=16777216
AIQSA_PROVIDER_TIMEOUT_MS=30000
AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS=30000
AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES=4194304
AIQSA_PROVIDER_STREAM_MAX_BYTES=67108864
AIQSA_PROVIDER_STREAM_MAX_DURATION_MS=600000
AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS=8388608
AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS=660000
```

Provider connections, endpoints, adapter protocols, explicit compatible authentication mode, models, routing, credentials, direct-user/group assignments, activation evidence, stored diagnostics, and enabled state are database-owned and configured through `Control Center -> Providers`. Reviewed Quick and Custom endpoint setup persist neither an unsuccessful key nor failed test evidence. The long-running application receives no provider key/base-URL variables and has no environment fallback. `AIQSA_PROVIDER_TIMEOUT_MS` bounds an ordinary request through its complete buffered response; `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` caps that non-stream body. A successful SSE instead has an independent 30-second idle-read guard, 10-minute absolute deadline, 4 MiB event-frame limit, 64 MiB total raw-wire limit, and 8 Mi-character retained provider-output limit. Activity resets only the idle guard. Stream values accept positive safe decimal integers; invalid or out-of-range values fall back to their defaults. Hard ceilings are 120,000 ms idle, 16 MiB/event, 256 MiB/stream, 660,000 ms absolute duration, and 32 Mi characters retained output; the effective event limit is also clamped to the total stream limit. Client Search calls use the selected immutable Search revision's database-owned timeout instead of `AIQSA_PROVIDER_TIMEOUT_MS`; the Search setting is bounded from 5 seconds through 15 minutes and defaults new integrations to 5 minutes. `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` separately bounds the complete OpenAI background polling lifecycle.

`AIQSA_DEFAULT_MODEL` and `AIQSA_DEFAULT_SEARCH_MODEL` are optional explicit provider-smoke inputs only. `GEMINI_API_KEY` and optional `AIQSA_GEMINI_SMOKE_MODEL` are consumed only by `npm run smoke:gemini`; they select the one-off key/model for bounded sanitized native Interactions streaming, function-continuation, and Google Search checks and are not application configuration. `npm run smoke:custom-openai-compatible` uses only its own loopback fixture and no key or external network. The application uses persisted catalog/settings choices. Provider-smoke permission is defined in `CRITICAL_INVARIANTS.md`; no routine test makes a paid external call.

## MCP Runtime Wiring

```text
AIQSA_TOOLHIVE_URL=http://toolhive-runtime:8080
```

`AIQSA_TOOLHIVE_URL` is internal Compose wiring, not a normal operator endpoint override and not a browser-visible variable. Both Compose files hardcode it to the pinned ToolHive service on the private `mcp-control` network. ToolHive and its dynamic proxy endpoints are not published to the host. MCP server endpoints, source selectors, OAuth policy, shared values, and user values live in the administrator/user persistence model rather than `.env`.

Brokered upstream SaaS configuration also does not add AIQSA environment
variables. Its OAuth client id/secret, upstream callback, organization routing,
token encryption keyring, and provider-specific limits belong to the separately
deployed remote MCP. AIQSA configures only the existing generic MCP resource,
authorization-origin allowlist, scopes, grants, and per-user MCP connection.

The long-running app and the maintenance service receive `AIQSA_ENCRYPTION_KEY`. The maintenance CLI derives the same opaque ToolHive ownership marker from that key; changing the key before exact-marker cleanup makes old workloads undiscoverable by the new installation identity.

## SMTP Safety Bounds

```text
AIQSA_SMTP_CONNECT_TIMEOUT_MS=10000
AIQSA_SMTP_COMMAND_TIMEOUT_MS=15000
AIQSA_SMTP_TOTAL_TIMEOUT_MS=60000
```

SMTP host, port, sender, authentication, password, transport, test/active state, and health are database-owned and configured through `Control Center -> Email delivery`. The long-running application receives no SMTP configuration variables and has no environment fallback. SMTP remains optional for bootstrap, login, manual invitation links, and core readiness.

Timeouts are positive whole milliseconds capped at 600,000. Their defaults bound connection/TLS, each SMTP command, and the complete send. Failure output must never contain credentials, recipients, message bodies, server response bodies, or token-bearing URLs.

## Stopped-Cutover Inputs

The one-shot `migrate-bootstrap` tools boundary recognizes legacy `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, and `AIQSA_SMTP_HOST`, `AIQSA_SMTP_PORT`, `AIQSA_SMTP_USER`, `AIQSA_SMTP_PASSWORD`, `AIQSA_SMTP_FROM`, `AIQSA_SMTP_SECURE`, `AIQSA_SMTP_STARTTLS` only to migrate an older stopped installation. It validates and imports complete values as disabled, untested encrypted drafts under the installation lock. These names are not normal runtime settings, are absent from `.env.example`, never reach `app`, and must be removed from the private `.env` after the successful cutover. Partial/invalid input aborts the atomic cutover with a value-free field-class error.

## Optional OAuth

```text
AIQSA_GOOGLE_OAUTH_CLIENT_ID=
AIQSA_GOOGLE_OAUTH_CLIENT_SECRET=
AIQSA_YANDEX_OAUTH_CLIENT_ID=
AIQSA_YANDEX_OAUTH_CLIENT_SECRET=
```

Each provider is enabled only when its client id and secret are both usable. Callback URLs are derived from `AIQSA_APP_BASE_URL`:

- `/api/auth/oauth/google/callback`
- `/api/auth/oauth/yandex/callback`

There is no separate redirect variable. AIQSA stores only the stable provider identity metadata, not OAuth access/refresh tokens. Missing or partial credentials hide the provider and its routes return not found.

These Google/Yandex variables are login identity only. They are not reused for
remote MCP authorization or delegated access to an upstream SaaS; a brokered
MCP runs its own independent consent flow.

## Uploads

```text
AIQSA_AUTH_REQUEST_BODY_MAX_BYTES=65536
AIQSA_JSON_REQUEST_BODY_MAX_BYTES=1048576
AIQSA_UPLOAD_MAX_BYTES=25000000
AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES=1048576
AIQSA_UPLOAD_MAX_CONCURRENCY=4
AIQSA_UPLOAD_STORAGE_DIR=.aiqsa/uploads
AIQSA_PDF_MAX_PAGES=500
AIQSA_PDF_EXTRACTION_TIMEOUT_MS=20000
AIQSA_PDF_EXTRACTED_TEXT_MAX_CHARS=20000
```

Auth JSON is capped at 64 KiB and other JSON at 1 MiB before parsing. Uploads
acquire one of four process-local permits, then buffer at most the configured
file limit plus 1 MiB of multipart overhead before platform parsing. Excess
concurrency rejects immediately rather than queueing bodies. Invalid, zero,
fractional, or excessive values fall back to the safe defaults. Upload file
size is hard-capped at 64 MiB, multipart overhead at 8 MiB, and
per-process concurrency at 8; larger configured values fall back to defaults.
Auth JSON is hard-capped at 1 MiB and other JSON at 16 MiB.
PDF extraction examines pages sequentially in a terminable worker and stops as
soon as it proves the configured extracted-text limit was exceeded. The three
PDF overrides are reduction-only positive integers: page count falls back to
500, timeout to 20,000 ms, and exposed/persisted text to 20,000 characters
when a value is invalid, zero, fractional, or above that respective ceiling.
Keep an exposed proxy upload limit strictly above `AIQSA_UPLOAD_MAX_BYTES +
AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES`; application enforcement remains
authoritative. The default Compose stack always supplies private S3/MinIO
storage. `AIQSA_UPLOAD_STORAGE_DIR` controls the server-only filesystem
fallback when S3 variables are absent outside that stack.

Internal storage variables are `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Compose generates them from the canonical `AIQSA_S3_*` values. The bucket must remain private.

The repository `ops/backup/create.sh` helper deliberately supports only the bundled `http://minio:9000` endpoint and fails closed for external S3. External storage needs the provider's consistent backup/versioning process coordinated with the PostgreSQL backup.

## Run Attachment Materialization

```text
AIQSA_RUN_ATTACHMENT_MAX_COUNT=20
AIQSA_RUN_ATTACHMENT_MAX_MATERIALIZED_BYTES=67108864
AIQSA_RUN_ATTACHMENT_MAX_ENCODED_BYTES=100663296
AIQSA_RUN_ATTACHMENT_READ_CONCURRENCY=2
```

These values bound one run without limiting simultaneous runs in different
chats. The source-object budget defaults to 64 MiB, the estimated encoded
provider payload to 96 MiB, and object-storage reads to two at a time. The
authenticated current-user catalog exposes only the effective count, source,
and encoded byte limits; read concurrency remains server-only. Server admission
and bounded reads remain authoritative when a client has no current catalog.

Overrides must be positive whole decimal integers. Invalid, zero, negative,
fractional, or out-of-range values fall back independently to their defaults.
The hard ceilings are 100 attachments, 268435456 source bytes (256 MiB),
402653184 encoded bytes (384 MiB), and eight concurrent reads. The count cap
bounds per-run metadata work, while the byte ceilings keep one run below the
default 2 GiB application memory limit even with base64 and transient runtime
overhead; the concurrency cap prevents an operator typo from turning one run
into unbounded storage fan-out.

## Advanced Compose Inputs

```text
AIQSA_IMAGE=ghcr.io/insciqq/aiqsa:latest
AIQSA_APP_REVISION=
AIQSA_APP_CPU_LIMIT=2.0
AIQSA_APP_MEMORY_LIMIT=2g
AIQSA_TOOLS_CPU_LIMIT=1.0
AIQSA_TOOLS_MEMORY_LIMIT=1g
AIQSA_POSTGRES_CPU_LIMIT=1.0
AIQSA_POSTGRES_MEMORY_LIMIT=1g
AIQSA_MINIO_CPU_LIMIT=1.0
AIQSA_MINIO_MEMORY_LIMIT=1g
AIQSA_LOG_MAX_FILES=5
AIQSA_LOG_MAX_SIZE=10m
AIQSA_POSTGRES_VOLUME_NAME=aiqsa_postgres_data
AIQSA_MINIO_VOLUME_NAME=aiqsa_minio_data
AIQSA_TOOLHIVE_VOLUME_NAME=aiqsa_toolhive_data
```

The app, migration/bootstrap, and maintenance services share `AIQSA_IMAGE`. Its default is the public `latest` release; one SemVer or `sha-...` tag in the same `.env` pins every role to one immutable build. `AIQSA_APP_REVISION` is privacy-safe backup metadata for release trees without `.git`; it is not passed to the web runtime. CPU/memory values are hard container limits and JSON-file logs rotate at the documented bounds.

Stable explicit volume names make normal rebuild/update operations independent of checkout-directory naming. The volume-name overrides exist only to adopt already-existing Docker volumes. ToolHive state is sensitive, disposable observed state and is never authoritative for MCP definitions or encrypted credentials. Because explicit volume names do not follow `docker compose -p`, every disposable installation smoke that starts this topology must set unique PostgreSQL, MinIO, and ToolHive volume overrides; routine checks instead use the separate dev Compose file.

## Emergency Recovery

```text
AIQSA_BOOTSTRAP_LOGIN_ENABLED=
AIQSA_BOOTSTRAP_USER_ID=
AIQSA_BOOTSTRAP_AUTH_TOKEN=
AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256=
```

Normal operation leaves recovery login disabled. A temporary recovery window requires the target existing user's UUID and either a high-entropy plaintext token or its SHA-256 hash. Readiness remains unhealthy while the route is enabled. Disable it and remove the token immediately afterward. The generated installation-admin UUID is not the deterministic development fixture UUID, so do not rely on the code fallback when recovery is needed.

## Development/Test-Only Environment

`docker-compose.dev.yml` is a different Compose project and owns these internal switches:

```text
AIQSA_TEST_MODE=1
PLAYWRIGHT_TEST_AUTH=1
AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS=10
```

Exact `AIQSA_TEST_MODE=1` plus non-production `NODE_ENV` authorizes the deterministic seed and Fake QSA adapter. Deterministic auth additionally requires exact `PLAYWRIGHT_TEST_AUTH=1`. The compiled runtime rejects these switches through readiness, and they are absent from `.env.example`. The seed restores the public fixture `operator@aiqsa.local` / `AIQSA-local-2026!` only inside disposable development volumes.

The dev/test fake adapter paces tokens by 10 ms by default so streaming and cancellation remain observable when Playwright reuses the Compose server. Set `AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS=0` explicitly to disable pacing for a one-off development run.

The dev Compose service hardcodes loopback publication and does not inject provider/SMTP or sign-in OAuth credentials from the normal installation `.env`. A deliberate one-off adapter smoke passes only the required key to the standalone smoke command; `smoke:gemini` may read `GEMINI_API_KEY` from the uncommitted local `.env` when launched from the repository. Routine application runtime always resolves provider credentials from its disposable database.

`NODE_ENV` remains a framework/container-owned value: the built standalone runtime uses `production`, while the supported localhost-vs-HTTPS policy comes from explicit URL/cookie settings rather than a named AIQSA environment tier.

## Rules

- Do not commit `.env` or any real secret.
- Keep `.env.example`, the minimal `README.md` operator flow, Compose passthrough, and this inventory synchronized.
- Do not add environment-tier prefixes or compatibility aliases; migration is a clean canonical cutover.
- Do not expose provider/OAuth/SMTP/storage keys through client bundles.
- Do not point `docker-compose.dev.yml` at installation data.
- Do not make private attachment storage public.
