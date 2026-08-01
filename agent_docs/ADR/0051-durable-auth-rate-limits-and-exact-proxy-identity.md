# ADR 0051: Durable Auth Rate Limits And Exact Proxy Identity

Status: Accepted
Amends: 0008-multi-user-auth-direction, 0020-unified-installation-and-isolated-development

## Context

Password login used one process-local fixed-window map. When Next route handlers
could not obtain a trusted client address, every request used the same
`unknown-client` client bucket. Ten failures for unrelated email addresses could
therefore block every password login for fifteen minutes. Process restart and a
second application process also produced independent admission state.

Forwarding-header trust selected one entry from a variable-length chain and fell
back to `X-Real-IP`. That made the configured proxy count an approximation rather
than an exact transport boundary.

## Decision

PostgreSQL owns authentication fixed-window buckets. Consumption is one atomic
`INSERT ... ON CONFLICT ... DO UPDATE` operation; all application processes and
reconstructed limiter instances observe the same counter and expiry. The table
stores only a domain-separated HMAC-SHA-256 bucket identifier plus bounded
counter/timestamps. The HMAC uses the installation session secret, so raw IP,
email, and token values are absent from persistence. Expired rows are removed
opportunistically through the indexed expiry field.

Email/account and opaque-token admission keys are independent of client
identity. A client-only bucket is additional and exists only when an exact
trusted `X-Forwarded-For` chain is present. Missing or invalid client identity
never becomes a shared sentinel. Bootstrap recovery retains its own
installation-scoped bucket because it protects one installation credential and
cannot block ordinary account login.

`AIQSA_TRUSTED_PROXY_COUNT` is the exact expected count of canonical IP entries,
bounded from one through eight. The first entry is the client selected from that
fully validated chain. Headers are ignored when trust is disabled; missing,
extra, empty, malformed, or overlong chains produce no client identity, and
`X-Real-IP` is not a fallback. The bundled one-hop Nginx boundary overwrites
untrusted forwarding headers and sends exactly one client address.

A non-loopback application base URL requires a valid enabled trusted-proxy
configuration for readiness, and the supported Compose runtime reports the
host publication address so readiness can require that it remains loopback.
Direct loopback installations may leave proxy trust disabled. This does not
make the overall runtime multi-replica/HA: it only makes authentication
admission safe across processes and restarts.

## Consequences

- Public deployments must keep the app loopback-bound behind an overwriting
  trusted proxy and declare the exact chain length.
- Password spraying from one known client remains client-bounded, while attacks
  on one account remain account-bounded across changing or unavailable clients.
- Changing the session secret intentionally changes bucket HMAC identities at
  the same time that it invalidates existing signed auth state.
- Authentication now depends on the already-required PostgreSQL readiness
  boundary instead of silently degrading to process-local protection.
