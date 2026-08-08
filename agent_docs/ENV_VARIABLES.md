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

`AIQSA_AUTH_SESSION_SECRET`, `AIQSA_ENCRYPTION_KEY`, the PostgreSQL password,
and the S3/MinIO secret must be deployment-specific high-entropy values.
Generate the session secret with `openssl rand -hex 32` or stronger and the
encrypted-state key with `openssl rand -base64 32`; the latter must decode to
exactly 32 bytes. Back it up separately from Postgres. Changing or losing it
requires an offline migration or re-entry of affected encrypted values.
Compose derives the internal `DATABASE_URL`, `POSTGRES_*`, `MINIO_ROOT_*`, and
`S3_*` values from these canonical inputs; operators do not duplicate the
connection string. [HTTP and auth security](security/HTTP_AND_AUTH.md) owns
cryptographic purpose separation and derived-key use.

Use URI-safe hexadecimal database/storage secrets because Compose constructs the internal database URL without percent-encoding. Once a persistent volume contains data, changing database initialization credentials does not rewrite that database, and changing the bucket/volume selection exposes a different empty namespace. Such changes require an explicit backed-up datastore migration, not an ordinary env edit.

Fresh installation and core readiness do not require a real LLM provider or SMTP. The initial administrator configures them after sign-in.

The installation bootstrap always requires a valid
`AIQSA_INITIAL_ADMIN_EMAIL`. On an empty database it also requires
`AIQSA_INITIAL_ADMIN_PASSWORD`, defaults the display name to `Administrator`,
and generates a UUID when `AIQSA_INITIAL_ADMIN_USER_ID` is blank. Later starts
use the stable email and optional explicit UUID to identify adoption. Remove the
plaintext initial password after first success but keep the email stable;
[persistence and retention](backend/PERSISTENCE_AND_RETENTION.md) owns the
transactional fresh/adopted behavior and preservation set.

## Address, Cookies, And Proxy Trust

```text
AIQSA_APP_BASE_URL=http://localhost:3000
AIQSA_BIND_ADDRESS=127.0.0.1
AIQSA_PORT=3000
AIQSA_COOKIE_SECURE=
AIQSA_TRUST_PROXY_HEADERS=
AIQSA_TRUSTED_PROXY_COUNT=
```

`AIQSA_APP_BASE_URL` is the browser-visible origin used for auth links, callback construction, origin checks, and runtime security headers. `AIQSA_BIND_ADDRESS` and `AIQSA_PORT` control the host publication only. A blank `AIQSA_COOKIE_SECURE` derives secure cookies and HSTS from the base-URL protocol; an explicit value must agree with that protocol or readiness fails. Localhost HTTP is supported. Direct non-loopback HTTP is supported for an operator-selected trusted LAN/VPN and produces the value-free startup warning `direct_http_transport`; it has no TLS confidentiality. Internet or encrypted exposure uses an HTTPS base URL, secure cookies, and the loopback bind behind a TLS proxy.

With proxy trust blank or explicitly false, the release runtime ignores `X-Forwarded-For` and `X-Real-IP` and overwrites its private peer stamp before Next.js conversion. Direct loopback keeps the existing no-client-bucket behavior; direct non-loopback derives its client admission key only from the authenticated immediate TCP peer. A random process-local launch key authenticates the stamp; no additional environment variable or operator secret selects this mode. Loopback bind requires a loopback HTTP base URL; non-loopback bind requires a non-loopback HTTP base URL and a valid stamp on the actual readiness request. Missing or invalid required peer identity fails auth admission and readiness closed. Native Linux Docker publication normally preserves a remote source address, but Docker Desktop, rootless/userland forwarding, NAT, VPN, or an undeclared intermediary may expose only a shared gateway; AIQSA cannot infer the end-user topology from address syntax.

`AIQSA_TRUST_PROXY_HEADERS=1` instead authorizes client rate-limit identity only from an `X-Forwarded-For` chain written by trusted proxies that remove the browser-supplied value. `AIQSA_TRUSTED_PROXY_COUNT` defaults to `1` and declares the exact expected number of comma-separated IP entries (maximum eight); the first canonical address is the client. Missing, extra, empty, malformed, or overlong chains create no client bucket, preserving the account/token admission boundaries, and `X-Real-IP` is not a fallback. Proxy mode requires loopback host publication so the trusted edge cannot be bypassed; contradictory topology fails readiness and auth admission closed. The bundled one-hop Nginx template supplies exactly one overwritten client entry.

## Provider Safety Bounds

```text
AIQSA_PROVIDER_RESPONSE_MAX_BYTES=16777216
AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES=4194304
AIQSA_PROVIDER_STREAM_MAX_BYTES=67108864
AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS=8388608
```

Provider connections, endpoints, adapter protocols, explicit compatible authentication mode, models, routing, credentials, direct-user/group assignments, activation evidence, stored diagnostics, enabled state, and response deadlines are database-owned and configured through `Control Center -> Providers`. Reviewed Quick and Custom endpoint setup persist neither an unsuccessful key nor failed test evidence. The long-running application receives no provider key/base-URL variables and has no environment fallback.

The connection response deadline is a whole 5–900 seconds in Admin and integer milliseconds in versioned storage/runtime. New and legacy/missing connection values use 300 seconds. A model may override that value in the same range; blank inherits the connection. Accepted `ProviderRunBinding` snapshots retain both versioned configurations, and every answer round resolves `model override ?? connection default` from that immutable snapshot. Buffered bodies, OpenAI background polling, streamed responses, and stream idle/absolute guards use that one effective ceiling; there is no separate installation timing control. Connection discovery and diagnostics use the connection value. External provider, reverse-proxy, and platform limits may still end an exchange earlier and are outside this application-owned guarantee.

Client Search retains its immutable revision-owned end-to-end deadline, also bounded from 5 seconds through 15 minutes and defaulting new integrations to 5 minutes. When its technical provider model has an earlier snapshotted response deadline, the effective invocation ceiling is the minimum of the two explicit budgets; Admin shows the Search budget, model deadline, and result.

`AIQSA_PROVIDER_TIMEOUT_MS`, `AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS`, `AIQSA_PROVIDER_STREAM_MAX_DURATION_MS`, and `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` are removed controls. Non-empty legacy values are ignored and produce one value-free startup warning with code `provider_timeout_environment_ignored` and variable names only. Compose forwards those names only during migration so an existing installation receives that warning; they are not supported configuration and are absent from `.env.example`.

`AIQSA_PROVIDER_RESPONSE_MAX_BYTES` caps buffered success/error bodies. Streaming keeps independent size/retention bounds of 4 MiB per event frame, 64 MiB total raw wire, and 8 Mi characters of retained provider output by default. Size values accept positive safe decimal integers; invalid or out-of-range values fall back to defaults. Hard ceilings are 16 MiB/event, 256 MiB/stream, and 32 Mi characters retained output, and the effective event limit is clamped to the total stream limit. Timing derives only from the accepted Admin configuration.

Embedding calls reuse the same database-owned connection/model deadline and
`AIQSA_PROVIDER_RESPONSE_MAX_BYTES` buffered ceiling, with an additional fixed
16 MiB adapter cap. Their batch count, text length, 2 MiB request cap, and
vector dimensions are code-owned safety/shape contracts; there is no separate
embedding environment-variable family.

`AIQSA_DEFAULT_MODEL`, `AIQSA_DEFAULT_SEARCH_MODEL`, `GEMINI_API_KEY`,
`AIQSA_GEMINI_SMOKE_MODEL`, `ANTHROPIC_API_KEY`, and
`AIQSA_ANTHROPIC_SMOKE_MODEL` are process-local provider-smoke inputs, never
long-running application configuration. The application uses persisted
catalog/settings choices. [Testing](TESTING.md) owns the commands and
provider-specific selector/evidence behavior; `CRITICAL_INVARIANTS.md` owns
permission and secret limits.

## MCP Runtime Wiring

```text
AIQSA_MCP_INITIALIZE_RESPONSE_MAX_BYTES=1048576
AIQSA_MCP_LIST_TOOLS_RESPONSE_MAX_BYTES=16777216
AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES=524288
AIQSA_MCP_UNKNOWN_RESPONSE_MAX_BYTES=1048576
AIQSA_MCP_SSE_EVENT_MAX_BYTES=16777216
AIQSA_TOOLHIVE_URL=http://toolhive-runtime:8080
```

The five response limits cap remote MCP wire envelopes before the pinned SDK
parses JSON or SSE. Initialize defaults to 1 MiB, paginated tool inventory to
16 MiB per response, tool calls to 512 KiB, and other finite responses to
1 MiB. A persistent GET/session stream has no small cumulative lifetime cap;
each complete SSE event is first capped at 16 MiB, then a response correlated
to initialize, `tools/list`, or `tools/call` receives that operation's stricter
limit. POST SSE remains cumulatively bounded by its originating operation, and
a mixed JSON-RPC batch uses the tightest represented operation limit.
The independent post-parse normalized tool-result limit remains 128 KiB.

Overrides must be positive whole decimal integers. Invalid, zero, fractional,
or excessive values fall back independently to their defaults. Initialize,
tool-call, and unknown-response values have a 16777216-byte hard ceiling;
tool-inventory and SSE-event values have a 67108864-byte hard ceiling. The
outbound JSON-RPC request reader has a fixed 1 MiB safety cap before operation
and bounded request-id classification. [MCP runtime security](security/MCP_RUNTIME.md)
owns overflow transport and redaction behavior; [runs and streaming](backend/RUNS_AND_STREAMING.md)
owns its run-visible error and continuation effects.

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

## Document Parser Sidecars

```text
AIQSA_DOCLING_URL=http://docling:5001
AIQSA_DOCLING_REQUEST_MAX_BYTES=25000000
AIQSA_DOCLING_RESPONSE_MAX_BYTES=33554432
AIQSA_DOCLING_TIMEOUT_MS=300000
AIQSA_TIKA_URL=http://tika:9998
AIQSA_TIKA_REQUEST_MAX_BYTES=25000000
AIQSA_TIKA_RESPONSE_MAX_BYTES=16777216
AIQSA_TIKA_TIMEOUT_MS=120000
```

The two URLs are server-only parser base endpoints. Both Compose files hardcode
them to the digest-pinned services on the internal `parser-control` network;
they are not browser-visible or ordinary `.env` overrides. A process launched
outside Compose configures either engine by supplying its URL; an absent,
blank, malformed, credential-bearing, query-bearing, or fragment-bearing URL
leaves that engine disabled without affecting app readiness. HTTP is accepted
for the private sibling network and HTTPS for an operator-supplied external
deployment. Parsed file bytes cross only the configured server boundary.

Request caps apply to the raw file before any sidecar call. They default to the
25,000,000-byte upload limit and may not exceed 67,108,864 bytes. Response
bodies are streamed and capped before JSON decoding: Docling defaults to 32
MiB and Tika to 16 MiB, each with a 64 MiB hard ceiling. Client deadlines
default to five minutes for Docling and two minutes for Tika and have a
15-minute ceiling. Every numeric override must be a positive whole decimal
integer within its ceiling; otherwise that engine's safe default applies.
Docling's bundled synchronous worker wait is 290 seconds, slightly below the
default client deadline. A sidecar failure stays feature-local and surfaces
only the stable parser error taxonomy.

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
AIQSA_DOCLING_CPU_LIMIT=2.0
AIQSA_DOCLING_MEMORY_LIMIT=4g
AIQSA_TIKA_CPU_LIMIT=1.0
AIQSA_TIKA_MEMORY_LIMIT=1g
AIQSA_LOG_MAX_FILES=5
AIQSA_LOG_MAX_SIZE=10m
AIQSA_POSTGRES_VOLUME_NAME=aiqsa_postgres_data
AIQSA_MINIO_VOLUME_NAME=aiqsa_minio_data
AIQSA_TOOLHIVE_VOLUME_NAME=aiqsa_toolhive_data
```

The app, migration/bootstrap, and maintenance services share `AIQSA_IMAGE`. Its default is the public `latest` release; one SemVer or `sha-...` tag in the same `.env` pins every role to one immutable build. `AIQSA_APP_REVISION` is privacy-safe backup metadata for release trees without `.git`; it is not passed to the web runtime. CPU/memory values, including the independent Docling and Tika budgets, are hard container limits and JSON-file logs rotate at the documented bounds.

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
