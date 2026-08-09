# SECURITY — HTTP AND AUTH

Owner: Security and privacy maintainers
Scope: HTTP hardening, proxy trust, sessions, credentials, authentication admission, recovery, and enumeration-resistance boundaries.
Read when: Changing HTTP headers, origins, cookies, proxy identity, passwords, sessions, OAuth, auth admission, recovery, or public auth responses.
Code owners: `lib/server/auth/`, authentication routes, request middleware, and `ops/nginx/`.
Not owned here: Local test-auth fixtures, Compose exposure, MCP runtime trust, upload/provider trust, or dependency policy.

## HTTP And Auth Hardening

AIQSA uses email/password plus optional Google/Yandex OAuth login with opaque HttpOnly session cookies backed by `AuthSession` rows. Normal registration is a verified access request gated by approved exact email/domain rules or admin approval. A one-off invite is a separate proof-bearing onboarding path: its emailed secret link establishes the invited email directly and never relies on browser-supplied email text. OAuth never consumes an invite merely because a provider reports the same email. `/api/auth/token` is an explicit bootstrap recovery route exposed only when `AIQSA_BOOTSTRAP_LOGIN_ENABLED=1` or deterministic local test auth is allowed. Route handlers are the auth boundary; the Next proxy uses cookie presence only for routing convenience.

Session cookies use `HttpOnly` and `SameSite=Lax`. `AIQSA_COOKIE_SECURE` controls their `Secure` attribute and HSTS; when unset, both follow the trusted `AIQSA_APP_BASE_URL` protocol. Plain HTTP localhost therefore remains supported without weakening an HTTPS installation.

Global responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`. The bind-mounted development server keeps a report-only Next-compatible CSP. A compiled runtime with an HTTPS base URL enforces same-origin default/connect/script policy without `unsafe-eval`; it retains the narrowly required Next/style `unsafe-inline` allowances, data/blob image support, and same-origin/blob worker support. HSTS is present only when secure cookies are enabled.

Public-share API and page responses override the global referrer policy with `no-referrer` and always send `Cache-Control: private, no-store, max-age=0` plus `X-Robots-Tag: noindex, nofollow, noarchive`, including generic unavailable/not-found outcomes. The page and API route are explicitly dynamic and zero-revalidation; each request repeats the hash/current-time repository check so revoked or expired content cannot be resurrected from framework or intermediary cache. Page metadata repeats the noindex/nofollow/nocache intent. These crawler directives are defense in depth, not authorization: a public share remains a high-entropy bearer capability protected by hash-only persistence, expiry, and revocation. AIQSA has no public-share analytics, and its supported Nginx access-log format omits URI/query data; future telemetry must omit or fully redact share paths, tokens, titles, and content.

The supported application and structured access logs remain token-free. As an accepted residual for trusted operator-controlled hosts, an exceptional Nginx error diagnostic may nevertheless reproduce a `/s/<token>` request path. Possession of that diagnostic grants the same public-share capability until expiry or revocation, so proxy error logs are restricted sensitive material: minimize retention and readership, do not forward them to third-party aggregation by default, redact share paths before support/report attachment, and revoke or rotate an affected share if its token-bearing diagnostic crossed the trusted operator boundary. This exception is specific to public-share paths in proxy internals and does not permit authorization headers, provider keys, OAuth/session material, MCP secrets, reset/invite links, or other bearer values in logs.

Auth/admin mutations require JSON content. Auth JSON is byte-bounded before parsing at 64 KiB by default and other JSON at 1 MiB; syntactically valid `Content-Length` is an early hint while actual streamed bytes remain authoritative. Client/IP auth admission available from request metadata runs before body consumption, while account/token buckets remain after bounded validated parsing. The proxy rejects foreign browser origins for state-changing `/api` requests. Allowed origins are the request origin, `AIQSA_APP_BASE_URL`, and same-protocol/same-port loopback aliases for local browser tests. Missing `Origin` is allowed only for non-browser clients or `Sec-Fetch-Site: same-origin|none`. This central Origin/Sec-Fetch-Site boundary plus `SameSite=Lax` cookies is the current CSRF protection; there is no separate token protocol without evidence that this boundary is insufficient.

The login `next` value must remain an internal path. The shared sanitizer rejects schemes, protocol-relative paths, backslashes, control characters, whitespace, and other unsafe values before navigation.

Authenticated Chat requests map an HTTP `401` to one deduplicated session-expiry redirect rather than attempting silent refresh. The redirect reuses the sanitized internal `next` contract and exposes only the stable `session_expired` reason. To preserve work across the explicit sign-in round trip, the browser may retain one non-empty active composer text draft, its encoded chat/blank-session key, the current account email, and a timestamp in tab-scoped `sessionStorage` for at most 30 minutes. The returning shell consumes it only for the same account and a still-existing destination, never overwrites an already-edited session, and carries no attachments, tokens, credentials, provider payloads, or other chat content.

OAuth uses authorization code flow with provider-bound random state and PKCE S256. Google additionally requires a random nonce and a `jose`-verified RS256 ID token with the configured audience, accepted Google issuer, valid expiry, matching nonce, stable `sub`, and `email_verified=true`. Yandex profile lookup uses its documented `Authorization: OAuth` scheme, stable `id`, and `default_email`, and requires the returned `client_id` to equal the configured application. Yandex exposes no separate email-verification flag; this small-installation policy deliberately treats `default_email` from that authenticated, client-bound profile as the merge email.

State, provider, nonce, PKCE verifier, and sanitized internal destination live for at most ten minutes in one HMAC-signed HttpOnly `SameSite=Lax` cookie whose `Secure` setting follows the session cookie. Callback state is exact-compared and the cookie is cleared on every callback outcome. Callback URLs derive only from `AIQSA_APP_BASE_URL`, never request Host/proxy headers. The callback stores only the stable provider identity metadata; it does not persist or log authorization codes, access/refresh/ID tokens, PKCE values, client secrets, raw provider errors, or provider response bodies.

After provider proof validation, the callback passes one bounded external
identity into the ordinary authentication transition; it does not implement a
second account owner or token-based session path. Later login must remain bound
to the stable provider subject rather than an untrusted changed email. [Auth and
onboarding](../backend/api/AUTH_AND_ONBOARDING.md) owns the exact first-use
merge, admission, conflict, and session outcomes.

Password, OAuth, onboarding, bootstrap, and reset attempts use atomic PostgreSQL fixed-window admission shared across processes and restart; logical keys persist only as installation-secret HMACs. Each valid OAuth code callback consumes one provider-bound signed-flow bucket before provider I/O, so exactly one exchange attempt can win during the ten-minute flow lifetime, and a separate code-owned per-provider installation bucket bounds pressure from freshly minted flows. Account/token protection is independent of client identity. The additional client bucket uses either an exact trusted proxy chain or the launcher's authenticated socket peer. A valid identity topology is always required, and direct non-loopback mode additionally requires an authenticated peer; direct loopback or an unavailable proxy-chain identity creates no shared `unknown-client` sentinel. Dummy password verification and generic credential/reset responses remain mandatory.

Forwarding headers are ignored unless `AIQSA_TRUST_PROXY_HEADERS=1`. Otherwise the launcher canonicalizes `socket.remoteAddress`, overwrites any client stamp, and authenticates it before Next.js with a versioned domain-separated HMAC under a random process-local launch key. The key is not operator configuration and never enters request metadata. Readiness verifies its own stamp; required auth rejects missing or malformed proof before sensitive work. This proves only the immediate peer: Docker/NAT/VPN intermediaries may aggregate users and cause shared throttling. Address ranges do not prove LAN isolation, and direct HTTP has no confidentiality.

With proxy trust enabled, `AIQSA_TRUSTED_PROXY_COUNT` must equal the complete bounded `X-Forwarded-For` chain and every entry must be a canonicalizable IP. There is no `X-Real-IP` fallback; an unavailable chain adds no client bucket, while account/token buckets remain. The loopback-reached edge must overwrite browser headers; proxy trust on a published non-loopback bind and direct HTTPS are invalid modes that fail auth admission as well as readiness. Public readiness stays generic while logs deduplicate value-free issue codes. This admission boundary does not make multi-replica/HA supported.

Password hashes use versioned `crypto.scrypt` with random salt; session cookies
contain raw random tokens while persistence keeps only SHA-256 hashes. Missing
or ineligible credential identities still exercise the dummy verifier, and
credential/reset responses retain their enumeration-safe timing and copy.
Proof-bearing onboarding and recovery must have one transactional winner: an
invite cannot become a reset path for an established identity, reset cannot
leave sibling proofs or prior sessions usable, and stale activation cannot
overwrite a committed administrator decision. [Auth and onboarding](../backend/api/AUTH_AND_ONBOARDING.md)
owns the exact token, identity, session, and response transitions that realize
those threat properties.

Revoked sessions are retained audit state, not an untyped status flag. A database constraint pairs every `revokedAt` with a non-blank reason, and the `admin_revoke_user`/`admin_revoke_all` reasons additionally require the acting user's foreign key. That actor relation uses restricted deletion so later account cleanup cannot erase attribution; authored revocations therefore count as retained app history for the stale-user deletion guard. Logout and password reset retain their explicit system/user-action reasons without an admin actor. The request-auth session store exposes only exact-token revocation; user-wide revocation remains inside the password-reset and authenticated admin repositories. The attribution migration labels already-unattributed historical admin rows with a `system_legacy_unattributed_*` reason rather than inventing an actor.

Cryptographic purposes stay separated. Quick Setup state fences use a
domain-separated HMAC subkey derived from the session secret and never the
encryption key. The encryption key is dedicated to purpose/owner/value-bound
versioned AES-256-GCM envelopes for provider credentials, SMTP passwords, MCP
values, and OAuth tokens; secret API fields remain write-only. It is never
session or flow-signing material. Memory suppression fingerprints use a third,
independent named HMAC-SHA-256 keyring: key values never enter PostgreSQL,
exports, ordinary backups, or diagnostics, and missing historical versions
fail closed instead of weakening a no-resurrection barrier.
[Environment variables](../ENV_VARIABLES.md) owns both key formats, generation,
rotation, backup, and recovery configuration.

Root `prepare-secrets.sh` is a local first-install helper, not a rotation tool.
It uses OpenSSL for independent random values, stages the complete file with
mode `0600`, and publishes it without replacing an existing path. It never
sources or reads an existing `.env` and never prints session, encryption,
database, object-storage, or Memory fingerprint-keyring secret values. It does
print a newly generated initial administrator password once and stores it in
`.env`; protect terminal
history/output, move that password to a password manager, remove it from `.env`
after successful bootstrap, and back up `AIQSA_ENCRYPTION_KEY` plus
`AIQSA_MEMORY_FINGERPRINT_KEYRING` separately from application data.

Email-verification, password-reset, and invite tokens are high entropy, one time, expiring, and stored only as hashes. Verification consumes sibling tokens while establishing the password, so concurrent links have one winner. Invite acceptance likewise locks the token and any matching identity/user by normalized email before creating the session. The SMTP password is a write-only purpose-bound encrypted value; `AIQSA_APP_BASE_URL` remains the trusted link origin. Each send loads one active database snapshot; connection, command, and complete-send deadlines fail closed and destroy the current socket. Errors never include credentials, AUTH payloads, message bodies, addresses, raw server responses, or token-bearing URLs. Registration and reset return one generic result behind a small SMTP-independent floor; any eligible token is persisted before asynchronous delivery, whose failure remains only in administrator health and sanitized logs. Requested admin invite delivery still reports partial unavailable/failed outcome without discarding the only recoverable URL.

Retention removes only terminal authentication state: sessions stay until at least the configured window after revocation or expiry, and flow tokens stay until at least that window after consumption or expiry. Active/unexpired credentials are never retention candidates; selection and deletion are bounded and the delete repeats the terminal cutoff predicate.

Admin authorization is enforced both when rendering `/admin` and in `/api/admin`/`/api/admin/action`. Non-admin users receive `403`; anonymous or inactive sessions receive the normal unauthenticated response. Admin disable rejects the acting account and locks/rechecks active administrators before mutation, so competing requests cannot disable the final active administrator. Disable/reject status changes and target-session revocation commit atomically. Raw invite tokens leave the server only in the one-time creation response and, when the admin explicitly requests delivery, the matching recipient's SMTP message; persistence and dashboard reads contain hashes only. Hard-delete actions remain blocked for active users, the acting admin, users with owned application data, groups with members/grants, and open or accepted invites. Database constraints enforce valid grant shapes.

Release awareness is a separate read-only administrator boundary. `/api/admin/release` rechecks the active database role before any external request and contacts only the code-owned HTTPS GitHub API path for `insciqq/AIQSA`; no browser, administrator field, environment value, redirect, or release response can select another host/repository. It sends no credential, bounds time and retained fields, constructs the release link under the same repository from a validated SemVer tag, and never logs, persists, or returns the raw GitHub body. Failure is a cached feature-local unavailable state and cannot affect Control Center data, health, readiness, or deployment state.
