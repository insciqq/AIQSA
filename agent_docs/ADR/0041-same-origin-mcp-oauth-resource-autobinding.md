# ADR 0041: Same-Origin MCP OAuth Resource Autobinding

Status: Accepted
Amends: 0021-admin-managed-mcp-tools-and-isolated-runtime, 0040-brokered-saas-oauth-behind-generic-remote-mcp

## Context

An MCP Streamable HTTP endpoint and its OAuth protected-resource identifier are
both URLs, but they are not required to have the same path. For example, a
server may accept MCP traffic at `/mcp` while publishing an origin-root
protected resource, while another server may use `/mcp` for both. Requiring an
administrator to copy the metadata value into a second field made ordinary
same-origin setup fail with `mcp_oauth_policy_forbidden` until the operator
manually compared discovery documents.

The browser handoff also used a same-origin POST form whose successful response
was a `303` to the remote authorization endpoint. AIQSA deliberately restricts
CSP `form-action` to itself, so a browser correctly blocked that cross-origin
form redirect even though the server-side OAuth start had succeeded.

Neither issue justifies recognizing a service hostname, path, scope, or brand.
The safe default can be derived from standards metadata and the already
reviewed MCP endpoint origin.

## Decision

- A remote OAuth MCP draft may leave `protectedResource` empty. This means
  `auto_same_origin`, not an unbounded trust decision. The source URL is the
  initial discovery target only.
- After RFC 9728 discovery, AIQSA canonicalizes the metadata `resource` and
  binds it only when its origin exactly equals the configured MCP source
  origin. Userinfo, query, fragment, malformed URLs, and cross-origin resources
  fail closed.
- An explicitly configured protected resource retains the previous exact-match
  contract. A legitimately cross-origin resource therefore still requires the
  administrator to supply and review the exact override.
- The auto policy fingerprint identifies the stable same-origin binding rule
  plus source URL, rather than whichever same-origin path was returned during
  one discovery. Callback settlement rebinds from the flow's stored discovery
  state and still rejects client, redirect, scope, origin, configuration, or
  explicit-policy drift.
- Authorization-server origins remain a separate allowlist. An empty list
  means only the MCP source origin; resource autobinding never trusts a
  separately hosted issuer or an upstream SaaS identity provider.
- Browser Connect/Reconnect actions are ordinary authenticated same-origin GET
  navigations to the OAuth-start routes. The routes retain POST compatibility
  for existing clients, while the UI no longer asks a CSP-restricted form
  submission to follow the remote redirect. Callbacks remain GET.
- UI copy calls the field a **Protected resource override (optional)** and does
  not expose a provider-specific preset. AIQSA adds no service hostname, MCP
  path, organization, tool, or scope branch.

## Consequences

- Entering a standards-conforming same-origin MCP URL is sufficient for AIQSA
  to use either an origin-root or path-aware canonical resource without manual
  correction.
- Same-origin discovery remains useful but not authoritative for issuer trust;
  cross-origin resource and authorization-server changes still require
  explicit administrator review.
- A successful OAuth start can navigate the browser to remote consent without
  weakening the application-wide `form-action 'self'` policy.
- Existing encrypted explicit-policy envelopes remain backward compatible
  because missing `resourceMode` continues to mean exact explicit policy.

## Required Verification

Deterministic coverage must prove same-origin path replacement, origin-root
binding, malformed/cross-origin rejection, exact explicit matching, stable auto
fingerprints, callback rebinding, and unchanged issuer-origin enforcement.
Component/route coverage must prove that Connect and Reconnect are navigable
links, that authenticated GET and compatibility POST start the same generic
flow, and that no service-specific identifier enters source or UI code.
