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
AIQSA_MEMORY_FINGERPRINT_KEYRING=
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
`--admin-email`), and generates the initial password plus the five required
secrets with OpenSSL. The completed file is published only after preparation
succeeds and has mode `0600`. An existing target of any kind is a successful
no-op: the helper does not read it, alter permissions, replace values, or repair
partial configuration. Consequently the helper is run instead of a preceding
`cp .env.example .env`; manual creation remains supported.

`AIQSA_AUTH_SESSION_SECRET`, `AIQSA_ENCRYPTION_KEY`,
`AIQSA_MEMORY_FINGERPRINT_KEYRING`, the PostgreSQL password, and the S3/MinIO
secret must be deployment-specific high-entropy values.
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

## Memory Suppression Fingerprint Keyring

`AIQSA_MEMORY_FINGERPRINT_KEYRING` is a required installation secret with this
strict comma-separated grammar:

```text
current=<key-id>,<key-id>=<canonical-base64-32-byte-key>[,<key-id>=<canonical-base64-32-byte-key>...]
```

The `current` declaration is first and occurs once. Key IDs match
`[a-z][a-z0-9_-]{0,63}`, except for the reserved name `current`; every ID and
key value is unique, and the named current key must exist. Values use padded
standard Base64 and decode to exactly 32 bytes. Whitespace, malformed entries,
low-diversity key material, duplicate names/material, an absent current key,
or more than 256 keys make Memory configuration unavailable without echoing
the value. Root `prepare-secrets.sh` creates the initial `v1` key with OpenSSL.

This keyring is used only for domain-separated HMAC-SHA-256 suppression
fingerprints and is cryptographically independent from
`AIQSA_ENCRYPTION_KEY`. New fingerprints use only the current ID; verification
selects the exact `fingerprintKeyVersion` stored with an existing suppression
row. To rotate, generate another independent 32-byte key, add it under a new
ID, change `current` to that ID, and deploy the complete keyring atomically to
every Memory writer. Retain every prior ID still referenced by suppression
rows. Removing or losing one blocks automatic extraction, resume, redream,
rebuild, and restore promotion; it never resets the barrier or resumes
learning.

Key values never belong in PostgreSQL, events, exports, logs, metrics, error
payloads, fixtures, or ordinary database/object backup bundles. Database rows
and those bundles may contain only the non-secret key IDs needed for preflight.
Back up the complete keyring in encrypted access-restricted secret storage,
separately from application data, and test that recovery provides every
distinct required ID before starting automatic Memory work. Core web readiness
remains independent while Memory reports a feature-local blocked status.
Compose forwards the complete keyring to the web role, the standalone Memory
worker, and the one-shot tools role used for restore preflight. The worker
refuses startup when configuration is invalid or a referenced historical ID is
missing; this does not become a web dependency.

## Memory Egress Consent Ownership

```text
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN
```

This installation policy accepts exact uppercase `ADMIN` or `PER_USER` and
defaults to `ADMIN` when absent or blank. `ADMIN` treats administrator-connected
Memory utility destinations as installation-owned: ordinary users see only a
passive status and cannot perform the account consent mutation. An active
administrator reviews and optimistically acknowledges the current secret-free
destination fingerprint in Control Center → Memory. Until the exact logical
role/destination has been acknowledged, only affected external Memory work
waits; local CRUD/Forget and lexical retrieval continue. A successful
acknowledgment kicks coordinator reconciliation. `PER_USER` preserves
account-level acceptance of the current aggregate utility fingerprint. In both
modes, destination fingerprints, per-call execution bindings, immediate drift
reauthorization, `WAITING_FOR_EGRESS_CONSENT`, and no-silent-fallback remain
authoritative.

An invalid non-blank value fails safely to `PER_USER`, so a typo cannot silently
relax an intended account-level consent boundary. Compose forwards the policy to
the app and standalone Memory worker; development fixes it to `ADMIN` unless a
test constructs an explicit `PER_USER` dependency. This setting changes consent
ownership only. It does not weaken storage-time secret screening, Temporary-chat
isolation, or the rule that Memory cannot authorize actions or select tools and
credentials.

## Memory Scheduler And Background Budgets

```text
AIQSA_MEMORY_JOB_PARALLELISM=2
AIQSA_MEMORY_JOB_PER_USER_PARALLELISM=1
AIQSA_MEMORY_JOB_CLAIMS_PER_PASS=16
AIQSA_MEMORY_DELETION_PARALLELISM=1
AIQSA_MEMORY_DELETION_CLAIMS_PER_PASS=64
AIQSA_MEMORY_BACKGROUND_BUDGET_REFRESH_MS=60000
AIQSA_MEMORY_BACKGROUND_USER_DAILY_CALLS=64
AIQSA_MEMORY_BACKGROUND_USER_DAILY_COST_MICROS=500000
AIQSA_MEMORY_COORDINATOR_INTERVAL_MS=1000
AIQSA_MEMORY_BACKGROUND_INSTALL_DAILY_CALLS=4096
AIQSA_MEMORY_BACKGROUND_INSTALL_DAILY_COST_MICROS=25000000
```

These optional bounded integers configure the feature-local coordinator. The
shipped single-coordinator topology admits two ordinary job handlers, at most
one for the same user, and one independent deletion handler. Claim-pass limits
bound one scheduler tick rather than truncate durable backlog. The job policy
weights safety reconciliation, still gives ordinary and background tiers a
bounded turn, and retains PostgreSQL owner rotation within every tier.

`AIQSA_MEMORY_COORDINATOR_INTERVAL_MS` bounds periodic durable reconciliation
between 1 and 60 seconds. Explicit lifecycle/settings/job kicks remain
immediate. Production compose keeps the one-second worker default; development
compose uses 30 seconds because Next development tracing retains substantially
more state per background pass than the standalone worker.

The two daily limits are soft UTC-day ceilings for `GLOBAL_DREAM` and
`RECALCULATE_WORKING_SET` only. Calls count their persisted execution bindings;
cost uses stored operator-priced estimates in micro-units and remains an
estimate rather than billing truth. Missing cost stays call-bounded. A reached
user or installation limit defers the background job to the next UTC day
without spending a provider retry; unavailable usage accounting defers it for
the refresh interval. Active bounded work can create a small soft-limit
overshoot. Explicit operations, Forget/purge, Temporary/account deletion, and
safety reconciliation never consult these budgets. Invalid values block Memory
coordinator construction with a content-free feature-local error. Compose
forwards one policy to the web status reader and the standalone worker.

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
AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS=660000
AIQSA_PROVIDER_RESPONSE_MAX_BYTES=16777216
AIQSA_PROVIDER_STREAM_MAX_EVENT_BYTES=4194304
AIQSA_PROVIDER_STREAM_MAX_BYTES=67108864
AIQSA_PROVIDER_STREAM_MAX_OUTPUT_CHARS=8388608
```

Provider connections, endpoints, adapter protocols, explicit compatible authentication mode, models, routing, credentials, direct-user/group assignments, activation evidence, stored diagnostics, enabled state, and response deadlines are database-owned and configured through `Control Center -> Providers`. Reviewed Quick and Custom endpoint setup persist neither an unsuccessful key nor failed test evidence. The long-running application receives no provider key/base-URL variables and has no environment fallback.

The connection response deadline is a whole 5–900 seconds in Admin and integer milliseconds in versioned storage/runtime. New and legacy/missing connection values use 300 seconds. A model may override that value in the same range; blank inherits the connection. Accepted `ProviderRunBinding` snapshots retain both versioned configurations, and every answer round resolves `model override ?? connection default` from that immutable snapshot. Buffered bodies, streamed responses, stream idle/absolute guards, and every native OpenAI create/retrieve exchange use that effective ceiling. Connection discovery and diagnostics use the connection value. External provider, reverse-proxy, and platform limits may still end an exchange earlier and are outside this application-owned guarantee.

Native OpenAI non-streaming background polling has a separate complete-lifecycle window because it may require many individually bounded retrieve exchanges. `AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS` defaults to 660,000 ms and accepts a whole decimal value from 5,000 through 86,400,000 ms; invalid, fractional, or out-of-range values use the default. The effective lifecycle window is the greater of this control and the accepted connection/model response deadline, so it can exceed the 900-second response-deadline ceiling but can never undercut one exchange. This is the same variable used by installations before response deadlines moved into Admin; it is supported again without a migration alias.

Client Search retains its immutable revision-owned end-to-end deadline, also bounded from 5 seconds through 15 minutes and defaulting new integrations to 5 minutes. When its technical provider model has an earlier snapshotted response deadline, the effective invocation ceiling is the minimum of the two explicit budgets; Admin shows the Search budget, model deadline, and result.

`AIQSA_PROVIDER_TIMEOUT_MS`, `AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS`, and `AIQSA_PROVIDER_STREAM_MAX_DURATION_MS` are removed controls. Non-empty legacy values are ignored and produce one value-free startup warning with code `provider_timeout_environment_ignored` and variable names only. Compose forwards those names only during migration so an existing installation receives that warning; they are not supported configuration and are absent from `.env.example`.

`AIQSA_PROVIDER_RESPONSE_MAX_BYTES` caps buffered success/error bodies. Streaming keeps independent size/retention bounds of 4 MiB per event frame, 64 MiB total raw wire, and 8 Mi characters of retained provider output by default. Size values accept positive safe decimal integers; invalid or out-of-range values fall back to defaults. Hard ceilings are 16 MiB/event, 256 MiB/stream, and 32 Mi characters retained output, and the effective event limit is clamped to the total stream limit. Ordinary exchange and stream timing derives only from the accepted Admin configuration; the native OpenAI background lifecycle is the explicit exception above.

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

`AIQSA_TOOLHIVE_URL` is internal Compose wiring, not a normal operator endpoint override and not a browser-visible variable. Both Compose files hardcode it to the pinned ToolHive service on the private `mcp-control` network. ToolHive and its dynamic proxy endpoints are not published to the host. Pointing this value at another machine is not a supported remote deployment: the controller API has full unauthenticated Docker authority, workload proxies use dynamic ports, and plain HTTP would expose tool inputs, results, and effective environment values. A future off-host slice requires a dedicated host without AIQSA application data, encrypted private L3 connectivity, strict app-host firewall access to an authenticated controller and controlled proxy range or gateway, encryption for both controller and tool traffic, migration or deterministic rebuild of ToolHive state and generated npm/PyPI images, coordinated maintenance/cleanup, and the same deployment encryption key for the ownership marker. Individually hosted Streamable HTTP MCP servers are the supported remote alternative today. MCP server endpoints, source selectors, OAuth policy, shared values, and user values live in the administrator/user persistence model rather than `.env`.

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
AIQSA_ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS=1000000
AIQSA_KNOWLEDGE_MAX_FILE_BYTES=50000000
AIQSA_KNOWLEDGE_MAX_PAGES=2000
AIQSA_KNOWLEDGE_MAX_NORMALIZED_CHARS=5000000
AIQSA_KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT=10000
```

Auth JSON is capped at 64 KiB and other JSON at 1 MiB before parsing. Uploads
acquire one of four process-local permits, then buffer at most the configured
file limit plus 1 MiB of multipart overhead before platform parsing. Excess
concurrency rejects immediately rather than queueing bodies. Invalid, zero,
fractional, or excessive values fall back to the safe defaults. Upload file
size is hard-capped at 64 MiB, multipart overhead at 8 MiB, and
per-process concurrency at 8; larger configured values fall back to defaults.
Auth JSON is hard-capped at 1 MiB and other JSON at 16 MiB.
Async attachment processing uses the configured parser sidecars and a
terminable local PDF fallback. The fallback examines pages sequentially and
stops at the page, time, or extracted-text ceiling. All three overrides are
reduction-only positive integers: page count falls back to 500, local PDF
timeout to 20,000 ms, and persisted extracted text to 1,000,000 characters
when a value is invalid, zero, fractional, or above its respective ceiling.
Provider-bound text is fitted again at run time from the selected model's
context window; this storage ceiling is not a per-provider request budget.
Keep an exposed proxy upload limit strictly above `AIQSA_UPLOAD_MAX_BYTES +
AIQSA_UPLOAD_MULTIPART_OVERHEAD_BYTES`; application enforcement remains
authoritative. The default Compose stack always supplies private S3/MinIO
storage. `AIQSA_UPLOAD_STORAGE_DIR` controls the server-only filesystem
fallback when S3 variables are absent outside that stack.

Knowledge ingestion uses its own whole-library limits rather than the chat
attachment extraction profile. File bytes default to 50,000,000 and may not
exceed 67,108,864; pages default to 2,000 with a 10,000 ceiling; normalized
text defaults to 5,000,000 characters with an 8,000,000 ceiling; and one
document defaults to 10,000 chunks with a 50,000 ceiling. Every override must
be a positive whole decimal integer within its ceiling or the corresponding
default is used. The normalized private JSON object has no independent
operator control: its byte cap is derived from the text limit and remains at
or below 64 MiB. Knowledge upload envelopes still use the shared multipart
headroom and process-local upload concurrency controls. The shipped Nginx
template keeps ordinary requests at 2 MiB, Chat attachment multipart at 32 MiB,
and only the two Knowledge document POST shapes at an 80 MiB envelope. Nginx
`m` values are binary MiB-style units; the larger proxy envelope covers the
67,108,864-byte application hard ceiling plus framing and is not the product
default.

## Document Parser Sidecars

```text
AIQSA_DOCLING_URL=http://docling:5001
AIQSA_DOCLING_REQUEST_MAX_BYTES=
AIQSA_DOCLING_RESPONSE_MAX_BYTES=33554432
AIQSA_DOCLING_TIMEOUT_MS=300000
AIQSA_TIKA_URL=http://tika:9998
AIQSA_TIKA_REQUEST_MAX_BYTES=
AIQSA_TIKA_RESPONSE_MAX_BYTES=16777216
AIQSA_TIKA_TIMEOUT_MS=120000
```

The two URLs are server-only parser base endpoints. Both Compose files hardcode
them to services on the internal `parser-control` network: Tika is directly
digest-pinned, while Docling is built locally from the exact digest-pinned
v1.21.0 base and checksum-pinned EasyOCR English/Cyrillic model assets;
they are not browser-visible or ordinary `.env` overrides. A process launched
outside Compose configures either engine by supplying its URL; an absent,
blank, malformed, credential-bearing, query-bearing, or fragment-bearing URL
leaves that engine disabled without affecting app readiness. HTTP is accepted
for the private sibling network and HTTPS for an operator-supplied external
deployment. Parsed file bytes cross only the configured server boundary.

Request caps apply to the raw file before any sidecar call. When unset or
invalid, each inherits its caller's effective accepted-file cap:
`AIQSA_UPLOAD_MAX_BYTES` for Chat attachments (normally 25,000,000 bytes) and
`AIQSA_KNOWLEDGE_MAX_FILE_BYTES` for Knowledge ingestion (normally 50,000,000
bytes). An explicit valid engine override wins globally, and no
request cap may exceed 67,108,864 bytes. Leave the engine values blank to keep
parser admission aligned automatically; a lower explicit value deliberately
rejects larger otherwise-accepted files for that engine. Response
bodies are streamed and capped before JSON decoding: Docling defaults to 32
MiB and Tika to 16 MiB, each with a 64 MiB hard ceiling. Client deadlines
default to five minutes for Docling and two minutes for Tika and have a
15-minute ceiling. Every numeric override must be a positive whole decimal
integer within its ceiling; otherwise that engine's safe default applies.
Docling's bundled synchronous worker wait is 290 seconds, slightly below the
default client deadline. A sidecar failure stays feature-local and surfaces
only the stable parser error taxonomy.

AIQSA's Docling multipart contract always sends `do_ocr=true`,
`force_ocr=false`, `ocr_preset=easyocr`, and ordered `ru`, `en` languages.
`force_ocr=false` preserves usable native PDF text while OCR handles bitmap
regions and image-only pages. The derived image verifies and preloads every OCR
asset at build time and runs with model-download paths offline. This guarantees
searchable printed Russian/English text, not handwriting or the meaning of
photographs, charts, and diagrams. Empty or unusable OCR output fails Knowledge
ingestion instead of creating an empty ready version. The 50,000,000-byte
admission default is not a latency SLA: high-resolution or high-page scans may
reach the existing 290/300-second synchronous boundary and fail visibly.

The supported Compose profile gives Docling 2 CPUs and 10 GiB, disables eager
model warm-up, keeps one local conversion worker and one cached option profile,
caps each threaded pipeline queue at one explicit four-page batch, and pins
Docling/OMP inference threads to the two-CPU cgroup. One worker is an
intentional memory-safety boundary: two concurrent EasyOCR/table pipelines
exceeded even a 10 GiB container in verification, while two clients queued
through this profile completed with bounded memory. Database owner rotation
still prevents one bulk import from monopolizing later claims; a second parser
request may wait for the one already in flight. Lowering the 10 GiB default is
unsupported for the Russian/English OCR contract, and raising memory alone does
not authorize more conversion workers.

Internal storage variables are `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Compose generates them from the canonical `AIQSA_S3_*` values. The bucket must remain private.

Core readiness uses non-mutating `HeadBucket` and therefore certifies only
endpoint/bucket reachability plus that operation's authorization. Before using
external S3-compatible storage, and again after changing its endpoint, bucket,
region/path-style behavior, credentials or role, encryption settings, or IAM
policy, the operator must use provider-native tooling with AIQSA's exact
effective configuration to write fresh unique tiny bytes under an
AIQSA-reserved smoke prefix, read the object back and compare the bytes exactly,
delete it, and verify that it is absent. This is a one-time/reconfiguration
deployment proof, not a write added to the recurring readiness loop. Evidence
may record only sanitized success/failure and must not contain credentials,
signed URLs, bearer tokens, reusable object capabilities, or private document
content. Normal integration covers the bundled MinIO service; compatibility and
cleanup evidence for an external backend remain operator-owned.

The repository `ops/backup/create.sh` helper deliberately supports only the bundled `http://minio:9000` endpoint and fails closed for external S3. External storage needs the provider's consistent backup/versioning process coordinated with the PostgreSQL backup.

Recovery uses the separate `ops/backup/docker-compose.restore.yml` with a unique
`COMPOSE_PROJECT_NAME=aiqsa-restore-*`. Ephemeral `AIQSA_RESTORE_POSTGRES_*`,
`AIQSA_RESTORE_S3_*`, and `AIQSA_RESTORE_BUCKET` values address only its
disposable database/object target; restore/review additionally require exact
`AIQSA_RESTORE_DISPOSABLE_TARGET=YES`, service names, and a pre-created
mode-0700 `AIQSA_RESTORE_REVIEW_DIRECTORY`. The operator recovers
`AIQSA_MEMORY_FINGERPRINT_KEYRING` separately and should pin `AIQSA_IMAGE` to
the reviewed compatible release. The restore Compose file has no ports, an
internal network, bounded one-shot tools, and explicitly empty answer/embedding
provider credentials. These recovery variables never authorize production
cutover and do not belong in the normal installation `.env`.

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
AIQSA_MEMORY_WORKER_CPU_LIMIT=1.0
AIQSA_MEMORY_WORKER_MEMORY_LIMIT=1g
AIQSA_TOOLS_CPU_LIMIT=1.0
AIQSA_TOOLS_MEMORY_LIMIT=1g
AIQSA_POSTGRES_CPU_LIMIT=1.0
AIQSA_POSTGRES_MEMORY_LIMIT=1g
AIQSA_MINIO_CPU_LIMIT=1.0
AIQSA_MINIO_MEMORY_LIMIT=1g
AIQSA_DOCLING_CPU_LIMIT=2.0
AIQSA_DOCLING_MEMORY_LIMIT=10g
AIQSA_TIKA_CPU_LIMIT=1.0
AIQSA_TIKA_MEMORY_LIMIT=1g
AIQSA_LOG_MAX_FILES=5
AIQSA_LOG_MAX_SIZE=10m
AIQSA_POSTGRES_VOLUME_NAME=aiqsa_postgres_data
AIQSA_MINIO_VOLUME_NAME=aiqsa_minio_data
AIQSA_TOOLHIVE_VOLUME_NAME=aiqsa_toolhive_data
```

The app, standalone Memory worker, migration/bootstrap, and maintenance services share `AIQSA_IMAGE`. Its default is the public `latest` release; one SemVer or `sha-...` tag in the same `.env` pins every role to one immutable build. `AIQSA_APP_REVISION` is privacy-safe backup metadata for release trees without `.git`; it is not passed to the web runtime. CPU/memory values, including the independent Memory worker, Docling, and Tika budgets, are hard container limits and JSON-file logs rotate at the documented bounds. The checked-in Docling worker/thread profile remains authoritative when memory is overridden.

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
AIQSA_LOCAL_DEV_PROFILE_DISABLED=1
```

Exact `AIQSA_TEST_MODE=1` plus non-production `NODE_ENV` authorizes the deterministic seed and Fake QSA adapter. Deterministic auth additionally requires exact `PLAYWRIGHT_TEST_AUTH=1`. The compiled runtime rejects these switches through readiness, and they are absent from `.env.example`. The seed restores the public fixture `operator@aiqsa.local` / `AIQSA-local-2026!` only inside disposable development volumes.

The repeatable seed has one ignored checkout-local extension point at `.aiqsa/local-dev-profile/post-seed.ts`. It is absent by default and therefore changes nothing for normal checkouts; exact `AIQSA_LOCAL_DEV_PROFILE_DISABLED=1` suppresses even that one file for a seed invocation. This switch is an emergency/testing escape hatch for the development command, not application configuration and not an invitation to pass provider secrets into the long-running runtime.

The dev/test fake adapter paces tokens by 10 ms by default so streaming and cancellation remain observable when Playwright reuses the Compose server. Set `AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS=0` explicitly to disable pacing for a one-off development run.

Dev Compose also honors the canonical `AIQSA_APP_MEMORY_LIMIT`, with a 3 GiB
development default instead of the release stack's 2 GiB default, plus
`AIQSA_APP_CPU_LIMIT`, with a four-CPU default. These are hard cgroup boundaries
for long-lived Turbopack and one-shot app containers. Dev disables Turbopack's
persistent filesystem cache so broad bind-mount changes cannot preserve a stale
compiler loop across restarts. The container check additionally uses a uniquely named fresh one-shot app container with
fixed 4 GiB and two-CPU cgroup boundaries, a 3 GiB Node heap, and one Vitest
worker; a second concurrent check fails to start, and the toolchain never enters
the warmed dev server.

The dev Compose service hardcodes loopback publication and does not inject provider/SMTP or sign-in OAuth credentials from the normal installation `.env`. A deliberate one-off adapter smoke passes only the required key to the standalone smoke command; `smoke:gemini` may read `GEMINI_API_KEY` from the uncommitted local `.env` when launched from the repository. Routine application runtime always resolves provider credentials from its disposable database.

`NODE_ENV` remains a framework/container-owned value: the built standalone runtime uses `production`, while the supported localhost-vs-HTTPS policy comes from explicit URL/cookie settings rather than a named AIQSA environment tier.

## Rules

- Do not commit `.env` or any real secret.
- Keep `.env.example`, the minimal `README.md` operator flow, Compose passthrough, and this inventory synchronized.
- Do not add environment-tier prefixes or compatibility aliases; migration is a clean canonical cutover.
- Do not expose provider/OAuth/SMTP/storage keys through client bundles.
- Do not point `docker-compose.dev.yml` at installation data.
- Do not make private attachment storage public.
