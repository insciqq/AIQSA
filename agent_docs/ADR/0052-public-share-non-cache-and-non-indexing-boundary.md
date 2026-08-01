# ADR 0052: Public Share Non-Cache And Non-Indexing Boundary

Status: Accepted
Amends: 0004, 0036

## Context

AIQSA public shares are sanitized immutable snapshots addressed by a secret bearer token. The snapshot contract prevents a share from becoming a pointer into live private chat state, but the successful public API and page responses had no explicit cache or crawler policy. A browser, framework cache, intermediary, or crawler could therefore retain content after the owner revoked the link or its expiry passed.

Crawler directives cannot make a discovered URL secret, and immutable content does not make a revoked bearer capability safe to cache. Revocation and expiry must take effect at the authoritative repository lookup on every request.

## Decision

- Every `GET /api/public-shares/:shareToken` outcome, including success and the generic unavailable response, carries `Cache-Control: private, no-store, max-age=0`, `X-Robots-Tag: noindex, nofollow, noarchive`, and `Referrer-Policy: no-referrer`.
- Every `/s/:shareToken` response path receives the same headers at the application proxy boundary, including framework-generated not-found responses. The page is force-dynamic, has zero revalidation, invokes the server no-store boundary before its repository read, and publishes robots metadata with indexing, following, and cache indexing disabled.
- The API route is force-dynamic with zero revalidation. Both the API and page resolve the token hash and current time against the repository on every request; an expired, revoked, unknown, or malformed capability uses the same unavailable surface and cannot be recovered from framework state.
- Share tokens, titles, and snapshot content do not enter application analytics or ordinary logs. The supported Nginx access-log format intentionally omits the request URI and query, and the share-specific no-referrer policy prevents the bearer path from becoming navigation referrer data. Any future analytics integration must omit or fully redact public-share paths before collection.
- `noindex` and `noarchive` are defense in depth only. Authorization remains possession of a high-entropy bearer token combined with server-side hash lookup, expiry, and revocation. Product copy and documentation must not describe crawler policy as secrecy.

The token generation, hash-only persistence, explicit creation confirmation, immutable sanitized snapshot, expiry, and revocation decisions from ADRs 0004 and 0036 remain unchanged.

## Consequences

- Public shares deliberately trade cacheability for prompt revocation and privacy behavior.
- Both live and unavailable responses are non-cacheable, so a negative response cannot become stale and a previously successful response cannot outlive repository authorization.
- Route, page, and proxy regression tests own the HTTP, metadata, and dynamic-rendering contract without recording real bearer values or snapshot content.
