# Configuration

AIQSA reads operator settings from `.env` through Docker Compose. Start from the example and keep the resulting file private:

```bash
cp .env.example .env
chmod 600 .env
```

Fill every value marked required. Blank optional values disable the corresponding feature. Restart the stack after changing runtime settings:

```bash
docker compose up -d --build
```

## Required settings

### Application and initial administrator

| Variable | Purpose |
| --- | --- |
| `AIQSA_AUTH_SESSION_SECRET` | High-entropy key used to sign browser sessions. Generate one with `openssl rand -hex 32`. |
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

### AI provider

Configure at least one server-wide provider key:

| Variable | Enables |
| --- | --- |
| `OPENAI_API_KEY` | Direct OpenAI models and OpenAI web search. |
| `ANTHROPIC_API_KEY` | Direct Anthropic models. |
| `OPENROUTER_API_KEY` | OpenRouter models and Perplexity search. |

These are installation-wide credentials, not per-user keys. Blank `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, and `OPENROUTER_BASE_URL` values use each provider's standard endpoint. A custom base URL must expose a compatible API.

`OPENROUTER_HTTP_REFERER` identifies the AIQSA origin to OpenRouter; set it to the same public origin as `AIQSA_APP_BASE_URL` when the installation is no longer local. `OPENROUTER_APP_TITLE` defaults to `AIQSA`.

Provider safety bounds are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIQSA_PROVIDER_TIMEOUT_MS` | `30000` | Complete non-streaming exchange timeout. |
| `AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS` | `30000` | Maximum pause between streaming chunks. |
| `AIQSA_PROVIDER_RESPONSE_MAX_BYTES` | `16777216` | Maximum untrusted provider response body. |
| `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` | `660000` | Overall OpenAI background-response polling deadline. |

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

SMTP is not needed for the initial administrator or normal local use. Without SMTP, password-reset and verification messages cannot be delivered, while an administrator can still copy newly created invitation links manually.

```dotenv
AIQSA_SMTP_HOST=smtp.example.com
AIQSA_SMTP_PORT=587
AIQSA_SMTP_USER=example-user
AIQSA_SMTP_PASSWORD=example-password
AIQSA_SMTP_FROM=AIQSA <aiqsa@example.com>
AIQSA_SMTP_SECURE=0
AIQSA_SMTP_STARTTLS=1
```

`AIQSA_SMTP_SECURE=1` selects implicit TLS, normally on port 465. `AIQSA_SMTP_STARTTLS=1` requests a STARTTLS upgrade, normally on port 587. Certificate verification remains enabled.

The optional `AIQSA_SMTP_CONNECT_TIMEOUT_MS`, `AIQSA_SMTP_COMMAND_TIMEOUT_MS`, and `AIQSA_SMTP_TOTAL_TIMEOUT_MS` values default to 10,000, 15,000, and 60,000 milliseconds respectively.

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

OAuth is used only for sign-in. AIQSA does not retain provider access or refresh tokens. A public OAuth setup normally needs a domain and HTTPS, but neither is required when OAuth is disabled.

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

`AIQSA_APP_REVISION` is optional release metadata used by backup manifests when the checkout does not contain Git metadata; release automation must export it when invoking the backup helper. The volume-name overrides are for adopting existing Docker volumes during a migration; fresh installations should keep the stable defaults.

## Emergency login

Normal operation must leave `AIQSA_BOOTSTRAP_LOGIN_ENABLED` blank. For a temporary administrator-recovery window, set it to `1`, set `AIQSA_BOOTSTRAP_USER_ID` to the target existing user's UUID, and configure either a high-entropy `AIQSA_BOOTSTRAP_AUTH_TOKEN` or its SHA-256 value in `AIQSA_BOOTSTRAP_AUTH_TOKEN_SHA256`. The recovery UUID is not optional when the initial administrator UUID was generated automatically.

Readiness deliberately remains unhealthy while emergency login is enabled. Disable it and remove the token immediately after recovery.
