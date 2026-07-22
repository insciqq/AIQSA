# ENV_VARIABLES

## Ownership And Naming

This document owns the complete runtime environment contract. User-facing setup and examples live in `docs/configuration.md`; `.env.example` contains only normal-install settings and non-secret placeholders.

AIQSA has one operator configuration regardless of where it runs. There is no named local/production environment tier and no duplicated setting family. The same canonical variables configure a loopback laptop install, a private server, or an HTTPS installation behind a proxy. Framework/container variables such as `NODE_ENV`, `DATABASE_URL`, `S3_*`, `POSTGRES_*`, and `MINIO_*` are internal wiring unless a command runs outside Compose.

## Required Installation Inputs

```text
AIQSA_AUTH_SESSION_SECRET=
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
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
```

`AIQSA_AUTH_SESSION_SECRET`, the PostgreSQL password, and the S3/MinIO secret must be deployment-specific high-entropy values. Generate the session secret with `openssl rand -hex 32` or stronger. Compose derives the internal `DATABASE_URL`, `POSTGRES_*`, `MINIO_ROOT_*`, and `S3_*` values from these canonical inputs; operators do not duplicate the connection string.

Use URI-safe hexadecimal database/storage secrets because Compose constructs the internal database URL without percent-encoding. Once a persistent volume contains data, changing database initialization credentials does not rewrite that database, and changing the bucket/volume selection exposes a different empty namespace. Such changes require an explicit backed-up datastore migration, not an ordinary env edit.

At least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` must be usable. Readiness fails when no real provider is configured; deterministic Fake QSA is a development/test facility, not an installation fallback.

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

`AIQSA_APP_BASE_URL` is the browser-visible origin used for auth links, callback construction, origin checks, and runtime security headers. `AIQSA_BIND_ADDRESS` and `AIQSA_PORT` control the host publication only. A blank `AIQSA_COOKIE_SECURE` derives secure cookies and HSTS from the base-URL protocol; an explicit value must agree with that protocol or readiness fails. Localhost HTTP is supported. An exposed installation uses an HTTPS base URL, secure cookies, and normally retains the loopback bind behind a TLS proxy.

`AIQSA_TRUST_PROXY_HEADERS=1` authorizes client rate-limit identity from forwarding headers only when a trusted proxy overwrites them. `AIQSA_TRUSTED_PROXY_COUNT` defaults to `1`, removes that many rightmost trusted `X-Forwarded-For` hops, and selects the next hop; leave both blank for direct access.

## Provider Configuration

```text
OPENAI_BASE_URL=
ANTHROPIC_BASE_URL=
OPENROUTER_BASE_URL=
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=AIQSA
AIQSA_PROVIDER_RESPONSE_MAX_BYTES=16777216
AIQSA_PROVIDER_TIMEOUT_MS=30000
AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS=30000
AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS=660000
```

Blank base-URL overrides select the providers' standard endpoints. Provider keys and endpoints are server-only and must never use a `NEXT_PUBLIC_*` name. The response-size and timeout values bound untrusted buffered responses, complete non-streaming exchanges, streaming idle time, and the absolute OpenAI background polling lifecycle respectively.

`AIQSA_DEFAULT_MODEL` and `AIQSA_DEFAULT_SEARCH_MODEL` are optional explicit provider-smoke inputs only. The application uses persisted catalog/settings choices. Provider-smoke permission is defined in `CRITICAL_INVARIANTS.md`; no routine test makes a paid external call.

## Optional SMTP

```text
AIQSA_SMTP_HOST=
AIQSA_SMTP_PORT=587
AIQSA_SMTP_USER=
AIQSA_SMTP_PASSWORD=
AIQSA_SMTP_FROM=
AIQSA_SMTP_SECURE=0
AIQSA_SMTP_STARTTLS=1
AIQSA_SMTP_CONNECT_TIMEOUT_MS=10000
AIQSA_SMTP_COMMAND_TIMEOUT_MS=15000
AIQSA_SMTP_TOTAL_TIMEOUT_MS=60000
```

SMTP is not required for the initial administrator or local use. It delivers registration-verification, password-reset, and explicitly requested invite mail. `AIQSA_SMTP_SECURE=1` means implicit TLS, normally port 465; `AIQSA_SMTP_STARTTLS=1` requests STARTTLS, normally port 587. Certificate validation is not bypassable through routine env. Missing host/from makes delivery unavailable while preserving the endpoint-specific truthful/generic response rules in `BACKEND.md`.

Timeouts are positive whole milliseconds capped at 600,000. Their defaults bound connection/TLS, each SMTP command, and the complete send. Failure output must never contain credentials, recipients, message bodies, server response bodies, or token-bearing URLs.

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

## Uploads

```text
AIQSA_UPLOAD_MAX_BYTES=25000000
AIQSA_UPLOAD_STORAGE_DIR=.aiqsa/uploads
```

Uploads are full-buffered after size/type preflight; the byte limit is therefore also a per-request application-memory boundary. Keep an exposed proxy body limit slightly above it. The default Compose stack always supplies private S3/MinIO storage. `AIQSA_UPLOAD_STORAGE_DIR` controls the server-only filesystem fallback when S3 variables are absent outside that stack.

Internal storage variables are `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Compose generates them from the canonical `AIQSA_S3_*` values. The bucket must remain private.

The repository `ops/backup/create.sh` helper deliberately supports only the bundled `http://minio:9000` endpoint and fails closed for external S3. External storage needs the provider's consistent backup/versioning process coordinated with the PostgreSQL backup.

## Advanced Compose Inputs

```text
AIQSA_APP_IMAGE=aiqsa-app:local
AIQSA_TOOLS_IMAGE=aiqsa-tools:local
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
```

The app and tools images may be replaced by prebuilt commit-tagged images with `--no-build`. `AIQSA_APP_REVISION` is privacy-safe backup metadata for release trees without `.git`; it is not passed to the web runtime. CPU/memory values are hard container limits and JSON-file logs rotate at the documented bounds.

Stable explicit volume names make normal rebuild/update operations independent of checkout-directory naming. The volume-name overrides exist only to adopt already-existing Docker volumes. Because explicit volume names do not follow `docker compose -p`, every disposable installation smoke must set two unique temporary override values; routine checks instead use the separate dev Compose file.

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
AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS=
```

Exact `AIQSA_TEST_MODE=1` plus non-production `NODE_ENV` authorizes the deterministic seed and Fake QSA adapter. Deterministic auth additionally requires exact `PLAYWRIGHT_TEST_AUTH=1`. The compiled runtime rejects these switches through readiness, and they are absent from `.env.example`. The seed restores the public fixture `operator@aiqsa.local` / `AIQSA-local-2026!` only inside disposable development volumes.

The dev Compose service hardcodes loopback publication and blanks real provider/OAuth credentials even when the normal installation `.env` contains them. A deliberate one-off provider smoke must pass only the required key explicitly to `docker compose -f docker-compose.dev.yml run`.

`NODE_ENV` remains a framework/container-owned value: the built standalone runtime uses `production`, while the supported localhost-vs-HTTPS policy comes from explicit URL/cookie settings rather than a named AIQSA environment tier.

## Rules

- Do not commit `.env` or any real secret.
- Keep `.env.example`, `docs/configuration.md`, Compose passthrough, and this inventory synchronized.
- Do not add environment-tier prefixes or compatibility aliases; migration is a clean canonical cutover.
- Do not expose provider/OAuth/SMTP/storage keys through client bundles.
- Do not point `docker-compose.dev.yml` at installation data.
- Do not make private attachment storage public.
