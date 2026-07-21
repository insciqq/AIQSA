# ENV_VARIABLES

`.env.example` contains non-secret local placeholders. Docker Compose provides local app/Postgres/MinIO defaults for the dev stack and passes provider API keys through from the operator's environment when present. The `app-prod` profile uses separate prod-profile Postgres/MinIO services and requires explicit `AIQSA_PROD_*` credentials from env.

## Runtime

Core:

```text
DATABASE_URL=
AIQSA_PROD_POSTGRES_DB=
AIQSA_PROD_POSTGRES_USER=
AIQSA_PROD_POSTGRES_PASSWORD=
AIQSA_PROD_DATABASE_URL=
AIQSA_INITIAL_ADMIN_EMAIL=
AIQSA_INITIAL_ADMIN_DISPLAY_NAME=
AIQSA_INITIAL_ADMIN_USER_ID=
AIQSA_INITIAL_ADMIN_PASSWORD=
AUTH_SESSION_SECRET=
AIQSA_BOOTSTRAP_AUTH_TOKEN=
AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256=
AIQSA_BOOTSTRAP_LOGIN_ENABLED=
AIQSA_BOOTSTRAP_USER_ID=00000000-0000-4000-8000-000000000001
APP_ENV=local
AIQSA_APP_BASE_URL=http://localhost:3000
AIQSA_DEV_BIND_ADDRESS=127.0.0.1
AIQSA_COOKIE_SECURE=
AIQSA_GOOGLE_OAUTH_CLIENT_ID=
AIQSA_GOOGLE_OAUTH_CLIENT_SECRET=
AIQSA_YANDEX_OAUTH_CLIENT_ID=
AIQSA_YANDEX_OAUTH_CLIENT_SECRET=
AIQSA_TRUST_PROXY_HEADERS=
AIQSA_TRUSTED_PROXY_COUNT=
```

`AUTH_SESSION_SECRET` must be a high-entropy secret for any exposed runtime; use `openssl rand -hex 32` or stronger. `AIQSA_BOOTSTRAP_AUTH_TOKEN` is optional admin recovery access, not normal login; if configured, it must also be high entropy. `AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256` can store the SHA-256 hash instead of the plaintext token. `AIQSA_BOOTSTRAP_LOGIN_ENABLED=1` exposes `POST /api/auth/token` for a temporary recovery window; leave it unset for normal operation and unset it again after recovery. If recovery login is enabled and the configured bootstrap token hash equals the deterministic dev token outside `APP_ENV=local`, startup logs a warning.

`AIQSA_COOKIE_SECURE` explicitly controls the `Secure` attribute on auth cookies and the HSTS header. Truthy values are `1`, `true`, `yes`, and `on`; falsey values are `0`, `false`, `no`, and `off`. When unset, cookies/HSTS are secure for `APP_ENV` values other than `local`, or for `NODE_ENV=production` when `APP_ENV` is unset. Local Docker Compose defaults to `APP_ENV=local`.

Exact `APP_ENV=local` also authorizes the disposable demo seed; an unset or different value, and every production `NODE_ENV`, makes that seed fail before a database query. The seed restores the committed fixture credential `operator@aiqsa.local` / `AIQSA-local-2026!` on every run. There is deliberately no environment override for this public local-test credential, and production initialization remains owned by the explicit `AIQSA_INITIAL_ADMIN_*` inputs.

`AIQSA_TRUST_PROXY_HEADERS=1` allows auth login rate limiting to key clients by trusted proxy headers. Leave it unset unless AIQSA is behind a trusted reverse proxy that strips or overwrites client-supplied forwarding headers. When enabled, `AIQSA_TRUSTED_PROXY_COUNT` defaults to `1`; it strips that many rightmost `X-Forwarded-For` hops and uses the rightmost remaining untrusted client hop, falling back to trusted `X-Real-IP` when no untrusted XFF hop remains.

`AIQSA_PROD_DATABASE_URL` is required by the `app-prod` profile. When using the bundled prod-profile Postgres service, it should point at `postgres-prod:5432` and match `AIQSA_PROD_POSTGRES_DB`, `AIQSA_PROD_POSTGRES_USER`, and `AIQSA_PROD_POSTGRES_PASSWORD`. Those prod Postgres variables have no Compose defaults; generate deployment-specific values instead of reusing local `aiqsa` credentials.

The first production bootstrap requires an explicit valid `AIQSA_INITIAL_ADMIN_EMAIL`, nonblank `AIQSA_INITIAL_ADMIN_DISPLAY_NAME`, canonical random UUID in `AIQSA_INITIAL_ADMIN_USER_ID`, and `AIQSA_INITIAL_ADMIN_PASSWORD`. It runs only after committed migrations, refuses every nonempty database that does not contain that exact adopted user/password identity, and creates no demo chat. After the first successful bootstrap, remove the plaintext password from deployment configuration; keep the other three identity values stable. An adopted rerun does not change the user's password, profile, role/status, settings, folders, prompt, grants, or operator-controlled catalog enablement.

`AIQSA_APP_BASE_URL` is the externally reachable application origin used by auth emails for registration verification, password reset, and invite-acceptance links. It must include scheme and host, for example `https://aiqsa.example.com`; local development may keep `http://localhost:3000`.

`AIQSA_DEV_BIND_ADDRESS` controls only the default development Compose host publications for the app, Postgres, and MinIO. It defaults to `127.0.0.1`, so the public local fixture credentials are not reachable from the LAN. Set an explicit non-loopback address only for a trusted development network with an appropriate host firewall; production continues to use the separate `AIQSA_PROD_BIND_ADDRESS` boundary and internal database/object services.

Google OAuth is enabled only when `AIQSA_GOOGLE_OAUTH_CLIENT_ID` and `AIQSA_GOOGLE_OAUTH_CLIENT_SECRET` are both nonblank. Register the exact callback `${AIQSA_APP_BASE_URL}/api/auth/oauth/google/callback` in the Google web application. Yandex OAuth follows the same paired rule for `AIQSA_YANDEX_OAUTH_CLIENT_ID` / `AIQSA_YANDEX_OAUTH_CLIENT_SECRET`; register `${AIQSA_APP_BASE_URL}/api/auth/oauth/yandex/callback` as the Yandex web-service Redirect URI and grant `login:info` plus `login:email`. Callback URLs are derived from the trusted base URL; there is no separate redirect-URI variable. Missing or partial credentials hide that provider and its route returns not found.

OAuth is login-only. AIQSA does not store provider access/refresh tokens or request offline access. A first verified/provider-authenticated email merges with an existing normalized-email user so password and OAuth entry points share the same data owner; new OAuth users still require the existing exact email/domain access policy. Keep client secrets server-only and never use `NEXT_PUBLIC_*` names.

Production Compose/operator inputs:

```text
AIQSA_APP_IMAGE=aiqsa-app:local
AIQSA_TOOLS_IMAGE=aiqsa-tools:local
AIQSA_APP_REVISION=
AIQSA_PROD_BIND_ADDRESS=127.0.0.1
AIQSA_PROD_APP_PORT=3100
AIQSA_PROD_APP_CPU_LIMIT=2.0
AIQSA_PROD_APP_MEMORY_LIMIT=2g
AIQSA_PROD_TOOLS_CPU_LIMIT=1.0
AIQSA_PROD_TOOLS_MEMORY_LIMIT=1g
AIQSA_PROD_POSTGRES_CPU_LIMIT=1.0
AIQSA_PROD_POSTGRES_MEMORY_LIMIT=1g
AIQSA_PROD_MINIO_CPU_LIMIT=1.0
AIQSA_PROD_MINIO_MEMORY_LIMIT=1g
AIQSA_PROD_LOG_MAX_FILES=5
AIQSA_PROD_LOG_MAX_SIZE=10m
```

`AIQSA_APP_IMAGE` and `AIQSA_TOOLS_IMAGE` may select prebuilt commit-tagged images for deployment with `--no-build`. `AIQSA_APP_REVISION` is the exact 40-character deployed Git revision recorded in privacy-safe backup manifests when the release directory has no `.git`; it is not passed into the web app. The tools image is one-shot and owns `prisma migrate deploy` plus production bootstrap; the smaller non-root application image contains neither migration source nor the Prisma CLI. Keep the published application address on loopback behind the TLS proxy. CPU/memory values are hard container limits, and JSON-file log rotation defaults to five 10 MB files per production service. Tune them to measured host capacity without removing the bounds.

Framework and container-owned variables are not operator-facing AIQSA inventory. Next.js/npm owns `NODE_ENV`; Compose sets `HOSTNAME` and `NEXT_TELEMETRY_DISABLED` for app containers. The bundled database and object-storage containers receive `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, and `MINIO_ROOT_PASSWORD`; operators configure their `AIQSA_PROD_*` or `S3_*` inputs instead of setting those internal names directly.

SMTP mail:

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

The SMTP variables are used by registration-verification, password-reset, and explicitly requested admin-created invite emails. `AIQSA_SMTP_FROM` is the sender used in those messages. `AIQSA_SMTP_SECURE=1` means implicit TLS/SMTPS, normally port 465. `AIQSA_SMTP_STARTTLS=1` means a STARTTLS upgrade, normally port 587. Certificate verification stays enabled; there is no routine env bypass for invalid certificates. When `AIQSA_SMTP_HOST` or `AIQSA_SMTP_FROM` is absent, password-reset requests keep the generic accepted response but no email is delivered; registration requests that require a new verification email return `verification_email_unavailable` instead of claiming delivery; requested admin invite delivery reports `unavailable` while preserving the created invite URL for manual copy.

`AIQSA_SMTP_CONNECT_TIMEOUT_MS` bounds TCP or implicit-TLS connection, the server greeting, and a STARTTLS handshake; its default is 10,000 ms. `AIQSA_SMTP_COMMAND_TIMEOUT_MS` bounds each SMTP command/response exchange, including EHLO, AUTH, the envelope, DATA acceptance, and QUIT; its default is 15,000 ms. `AIQSA_SMTP_TOTAL_TIMEOUT_MS` is one absolute bound across the complete send and defaults to 60,000 ms. Values must be positive whole milliseconds no greater than 600,000; blank or invalid values use these defaults. The shorter applicable phase or remaining total deadline wins, so partial server progress cannot extend a send indefinitely.

Docker Compose passes `AIQSA_APP_BASE_URL`, the paired Google/Yandex OAuth credentials, and `AIQSA_SMTP_*` through to both app services. The dev service defaults `AIQSA_APP_BASE_URL` to `http://localhost:3000`, SMTP port to `587`, and STARTTLS on; the prod profile leaves OAuth and SMTP credentials empty unless the operator supplies deployment values. Both services retain the documented finite SMTP deadline defaults unless explicitly overridden.

Providers:

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=
OPENROUTER_HTTP_REFERER=http://localhost:3000
OPENROUTER_APP_TITLE=AIQSA
AIQSA_DEFAULT_MODEL=gpt-5.5
AIQSA_DEFAULT_SEARCH_MODEL=perplexity/sonar-pro-search
AIQSA_PROVIDER_RESPONSE_MAX_BYTES=16777216
AIQSA_PROVIDER_TIMEOUT_MS=30000
AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS=30000
AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS=660000
```

Blank `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `OPENROUTER_BASE_URL` values are normalized as unset so adapters use their standard provider endpoints rather than an empty override.

`AIQSA_DEFAULT_MODEL` and `AIQSA_DEFAULT_SEARCH_MODEL` are smoke-script inputs only. They select models for `npm run smoke:openai` and `npm run smoke:openrouter`; the application runtime takes model choices from the persisted catalog and user settings instead.

`AIQSA_PROVIDER_TIMEOUT_MS` bounds the complete provider exchange through JSON or non-2xx error-body consumption, not only time to response headers. `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` caps those untrusted bodies at 16 MiB by default. Successful SSE hands off after headers to caller cancellation plus `AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS`, which bounds idle time between chunks without imposing a short whole-stream deadline. Automatic chat titles are local and use none of these bounds.

`AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` is one absolute deadline across create, waits, retrieves, and retry work for a non-streaming OpenAI background Responses run. The default is 660,000 ms, roughly 11 minutes, to give long PDF/reasoning runs more time than the old five-minute in-code default. OpenAI documents background polling storage as roughly 10 minutes, so very late responses may still need the saved-response-id refresh/recovery path when available.

Uploads and sharing:

```text
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
AIQSA_PROD_S3_ENDPOINT=http://minio-prod:9000
AIQSA_PROD_S3_REGION=us-east-1
AIQSA_PROD_S3_BUCKET=
AIQSA_PROD_S3_ACCESS_KEY_ID=
AIQSA_PROD_S3_SECRET_ACCESS_KEY=
UPLOAD_MAX_BYTES=25000000
AIQSA_UPLOAD_STORAGE_DIR=.aiqsa/uploads
```

Uploads are full-buffered in the route before storage and provider preprocessing; the default `UPLOAD_MAX_BYTES=25000000` is the intended local memory ceiling. The handler checks file size/type before reading file bytes, then validates magic bytes before storage. Keep reverse-proxy body-size limits aligned with `UPLOAD_MAX_BYTES` for exposed deployments.

Current AIQSA upload storage expects the bucket to remain private; the file-system fallback stores objects under `AIQSA_UPLOAD_STORAGE_DIR` and returns `application/octet-stream` for reads.

Both Compose app services pass `AIQSA_UPLOAD_STORAGE_DIR` through; a blank value keeps the `.aiqsa/uploads` application default.

The prod Compose profile reads `AIQSA_PROD_S3_*` for the internal `minio-prod` service and the `app-prod` storage client. `AIQSA_PROD_S3_ACCESS_KEY_ID`, `AIQSA_PROD_S3_SECRET_ACCESS_KEY`, and `AIQSA_PROD_S3_BUCKET` are required and have no weak defaults; `AIQSA_PROD_S3_ENDPOINT` defaults to `http://minio-prod:9000`.

Testing/local switches:

```text
AIQSA_FAKE_PROVIDER=
AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS=
AIQSA_SHOW_FAKE_PROVIDER=
PLAYWRIGHT_TEST_AUTH=1
```

Deterministic auth is enabled only when `PLAYWRIGHT_TEST_AUTH=1`, `APP_ENV=local` exactly, and `NODE_ENV` is not `production`. `NODE_ENV=test` alone and an unset `APP_ENV` do not enable it. Production always ignores the switch. Allowed test auth routes auth emails to the local in-memory sink at `/api/test/auth-mails`; outside allowed test mode that route returns `404`. The Playwright command intentionally uses the shared local Compose database and bucket and may reset or pollute them.

`AIQSA_FAKE_PROVIDER=1` enables deterministic provider execution; `AIQSA_SHOW_FAKE_PROVIDER=1` exposes Fake QSA in the local catalog. Neither bypasses production auth or tenancy checks.

`AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS` controls the deterministic fake provider's per-token delay. Leave it blank for the code/test default; Playwright fills a stable delay when needed for cancel/stream timing coverage.

## Provider Smoke Secrets

- Local `.env` may contain `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and optionally `ANTHROPIC_API_KEY`.
- Provider-smoke permission is defined in `agent_docs/CRITICAL_INVARIANTS.md`.
- Do not print, inspect, persist, or commit secret values from `.env`.

## Rules

- Do not commit `.env`.
- Keep `.env.example` updated when runtime variables change.
- Do not expose provider keys through `NEXT_PUBLIC_*`.
- Prefer fake provider mode for automated tests; do not expose it in regular startup unless explicitly debugging.
- Do not commit bootstrap auth tokens or session secrets.
- Do not make private attachment storage public by default.
