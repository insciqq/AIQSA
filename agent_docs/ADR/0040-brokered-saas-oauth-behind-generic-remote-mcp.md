# ADR 0040: Brokered SaaS OAuth Stays Behind The Generic Remote MCP Boundary

Status: Accepted
Amends: 0021-admin-managed-mcp-tools-and-isolated-runtime

Amendment note: ADR 0041 permits generic same-origin protected-resource
autobinding when the administrator leaves the override empty and uses browser
GET navigation for the remote OAuth handoff. Explicit and cross-origin policy
remain exact.

## Context

ADR 0021 made administrator-managed remote MCP servers and per-user MCP OAuth a
generic AIQSA capability. Hosted Notion is its reference service: AIQSA acts as
an MCP client, discovers the protected resource and authorization server, and
stores one encrypted MCP connection for each AIQSA user. That contract must
also support a remote MCP server which is itself an OAuth client of another
SaaS API.

Yandex Tracker is the first concrete interoperability target for this topology.
A user authenticated to AIQSA through Yandex has a verified AIQSA identity, but
the login email and login token are not Tracker authorization. Tracker performs
API operations under the account represented by its own OAuth or IAM token and
applies that account's Tracker permissions. Reusing the login application,
mapping email to a shared robot, or accepting an AIQSA-signed identity at the
Tracker API would either fail authorization or perform work under the wrong
actor and permission set.

Tracker-specific routes, scopes, organization headers, tools, credentials and
token refresh rules do not belong in the AIQSA modular monolith. Putting them
there would create a second integration framework beside MCP and would require
another AIQSA release whenever the external service changes. The intended
product experience is instead the same as another hosted OAuth MCP: an
administrator activates a reviewed remote MCP definition, an entitled user
selects **Connect**, completes the external consent flow, and then uses the
server's tools through the ordinary provider-neutral tool loop.

An existing Apache-2.0 project,
[aikts/yandex-tracker-mcp](https://github.com/aikts/yandex-tracker-mcp), already
provides a substantial Tracker v3 tool surface, Streamable HTTP, MCP OAuth,
dynamic client registration, read-only operation, organization selection and
encrypted Redis storage. It is a better base than a new in-repository Tracker
implementation. Its current OAuth provider nevertheless returns the upstream
Yandex access and refresh tokens as the tokens presented by the MCP client and
later forwards that access token to Tracker. The current
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
explicitly forbids upstream token passthrough: an MCP access token must be
issued for and validated by the MCP resource, while a separate upstream token
remains private to the MCP server. Disconnect/revocation, two-layer refresh and
audience isolation therefore need to be completed before treating that server
as a production OAuth boundary.

The existing AIQSA grant contract also matters. An MCP server is trusted as one
unit and every valid tool it exposes is available to the model; AIQSA currently
has no per-call approval layer and does not treat MCP tool annotations as an
authorization boundary. A Tracker server with write scope can create, edit,
transition, comment on, or delete external state. The first end-to-end slice
must therefore prove the identity and OAuth topology with read-only tools
instead of coupling protocol validation to an unreviewed write rollout.

## Decision

### Keep service knowledge outside AIQSA

- AIQSA continues to implement one provider-neutral remote MCP client. It does
  not add a Yandex Tracker connection type, callback route, database table,
  environment-variable family, organization field, tool schema, query helper,
  account mapper, token endpoint, or branding branch.
- The AIQSA session proves which local user may start or complete an MCP OAuth
  flow. It is not presented to the external SaaS API and does not authorize the
  MCP server to impersonate the user there.
- An administrator supplies only the generic remote MCP definition already
  owned by ADR 0021: canonical Streamable HTTP endpoint, protected-resource
  identity, allowed authorization-server origins, requested MCP scopes,
  internal-network policy and server-level grants. AIQSA treats scope strings,
  account labels, tool names and tool schemas as bounded server-owned MCP data,
  never as provider identifiers to infer from.
- External OAuth client credentials and service-specific non-secret routing
  context live in the independently deployed MCP server. They are never added
  to AIQSA environment configuration, browser contracts, provider prompts or
  run snapshots.
- AIQSA does not vendor, import or runtime-depend on the Tracker fork. The fork
  is one conformance target for the generic remote-MCP contract. Another
  standards-conforming brokered OAuth MCP must be connectable without an AIQSA
  source change.

This amends ADR 0021 by making the brokered OAuth topology and the prohibition
on upstream-token passthrough explicit. It does not change ADR 0021's
installation-owned server definitions, whole-server grants, immutable accepted
run snapshots, or current absence of per-call approval.

### Use two distinct OAuth security domains

The supported flow has two authorization-code exchanges and two unrelated
token families:

```text
browser
  -> AIQSA (authenticated local session)
  -> remote MCP authorization server
  -> upstream SaaS authorization server
  -> remote MCP upstream callback
  -> AIQSA generic MCP callback

AIQSA <---- MCP-audienced access/refresh tokens ----> remote MCP
                                                       |
                                                       +-- private upstream
                                                           access/refresh tokens
                                                           -> SaaS API
```

- The MCP protected resource and authorization server expose the discovery,
  registration and token endpoints required by the current MCP OAuth profile.
  AIQSA uses the pinned official MCP SDK for Protected Resource Metadata,
  Authorization Server Metadata, Authorization Code with S256 PKCE, Resource
  Indicators, Dynamic Client Registration or Client ID Metadata Documents,
  token exchange and refresh.
- The remote MCP issues its own opaque access and rotating refresh tokens. Each
  token is bound to the exact MCP client, canonical MCP resource, granted MCP
  scopes, external subject and expiry. The MCP validates those properties on
  every request before resolving any upstream credential.
- The upstream OAuth server separately issues access and refresh tokens to the
  MCP server's confidential OAuth application. Those tokens are encrypted in
  the MCP store, keyed to one external subject and MCP authorization grant, and
  are never returned to AIQSA, a browser, an MCP tool result or a model.
- The downstream MCP scopes may map to a least-privilege set of upstream scopes,
  but the two grants are distinct records. Refreshing or revoking one layer
  never silently substitutes a token from another user, client, resource or
  scope set.
- Both authorization legs use random exact state, short-lived single-use codes,
  exact registered redirects and PKCE S256 where the upstream supports it.
  Token exchange occurs only on a server boundary; codes, verifiers, client
  secrets and raw provider errors do not enter callback output or logs.
- Downstream refresh is serialized per MCP grant and rotates the MCP refresh
  token atomically. Upstream refresh is independently serialized per external
  grant and atomically persists every replacement returned by the provider.
  Concurrent tool calls share the winning refresh rather than racing token
  versions.
- MCP disconnect first prevents new MCP calls, then revokes downstream tokens
  and best-effort revokes the corresponding upstream grant after in-flight work
  drains. Unrecoverable `invalid_grant`, subject mismatch, scope loss or client
  mismatch becomes reauthorization-required; it never falls back to a shared
  integration identity.

### Keep callbacks and discovery generic

- AIQSA's browser callback remains
  `/api/me/mcp/:serverId/oauth/callback`, derived from the trusted
  `AIQSA_APP_BASE_URL`. It is registered with the MCP authorization server,
  dynamically where supported, and is not registered with the upstream SaaS.
- A brokered MCP owns its separate upstream callback, such as
  `/oauth/yandex/callback`, derived from the MCP server's canonical public URL.
  That callback is registered in the upstream OAuth application. AIQSA neither
  serves nor understands it.
- Production MCP resource, discovery, authorization, token, callback and
  revocation endpoints use HTTPS. Plain HTTP loopback is allowed only for local
  development. The browser and AIQSA server process must resolve and reach one
  consistent public MCP issuer/resource identity; a container-only hostname is
  not used as a browser callback identity.
- The upstream identity-provider origin is not added to AIQSA's allowed MCP
  authorization-server origins. AIQSA redirects the browser only to the
  discovered and administrator-reviewed MCP authorization endpoint; subsequent
  upstream consent redirects are owned by that MCP endpoint.
- Endpoint paths and protected-resource identifiers remain configurable MCP
  policy. AIQSA does not infer a provider from a hostname and does not special
  case `/mcp/`, an upstream callback path, or a server display name.

### Harden generic AIQSA interoperability

AIQSA implementation work is limited to standards conformance and generic
behavior exposed by the brokered topology:

- add a provider-neutral local remote-MCP fixture whose authorization server
  brokers a fake upstream OAuth service and issues a separate MCP token family;
- verify the current SDK wrapper against path-aware Protected Resource
  Metadata, Authorization Server Metadata, Resource Indicators, S256 PKCE,
  dynamic registration, client reuse, exact callbacks, refresh rotation,
  revocation and reauthorization;
- preserve the current administrator-owned allowlist for authorization-server
  origins and the SSRF-safe fetch boundary through discovery, registration,
  token and revocation calls;
- reject resource, issuer, redirect, client, scope or policy-fingerprint drift
  instead of adapting it to a named external provider;
- retain one encrypted per-user MCP connection and one reusable installation
  client registration under the existing MCP persistence model; add no new
  service-specific persistence. If conformance reveals a generic missing field,
  it is added to the generic OAuth policy/connection contract only;
- keep user copy generic: **Connect**, **Reconnect**, **Disconnect**,
  authorization readiness, requested scopes and a bounded external account or
  workspace label. No UI string or branch assumes Notion, Yandex or Tracker;
- keep all MCP access/refresh tokens and dynamic client secrets in the existing
  purpose-bound encrypted envelopes and exact-known-secret redaction boundary;
  token values never enter client-visible APIs, run evidence or logs.

The fixture, not the Tracker fork, is routine AIQSA regression coverage. A
future MCP server using another upstream OAuth provider must exercise the same
tests and product path.

### Maintain a separate public Tracker MCP fork

A public fork of
[aikts/yandex-tracker-mcp](https://github.com/aikts/yandex-tracker-mcp) will be
created outside the AIQSA repository. The fork keeps the Apache-2.0 license and
upstream attribution, records the reviewed upstream base commit, retains an
`upstream` remote, and accepts later upstream updates only through reviewed
merges. AIQSA never follows the fork's mutable default branch or latest tag as
an executable dependency.

The fork work will preserve already useful upstream tools and tests, while
making these production-boundary changes:

1. Replace Yandex-token passthrough with separately generated, audience-bound
   opaque MCP access and refresh tokens.
2. Store Yandex access/refresh tokens only in the MCP server's encrypted
   server-side grant record and associate them with the validated Yandex
   subject, MCP client/grant and upstream scope set.
3. Complete both-layer serialized refresh and rotation, downstream token
   revocation, best-effort Yandex revocation, disconnect cleanup and
   reauthorization-required behavior.
4. Preserve standards-based MCP discovery, Resource Indicators, S256 PKCE and
   dynamic client registration, and add deterministic negative tests for wrong
   audience, client, resource, redirect, state, verifier and subject.
5. Validate the upstream account through the Tracker current-user endpoint
   before making a connection ready. Organization type and ID remain deployment
   configuration; the client sends exactly one of `X-Org-ID` or
   `X-Cloud-Org-ID` according to that configuration, following the
   [Tracker request contract](https://yandex.ru/support/tracker/en/api-ref/common-format).
6. Keep read-only operation as the safe default, request only
   `tracker:read` in that mode, omit write tools from `tools/list`, and retain
   explicit opt-in write mode with `tracker:write` for clients whose product
   policy permits it. Tracker scopes and per-user authorization follow the
   [Tracker API access contract](https://yandex.ru/support/tracker/en/api-ref/access).
7. Keep queue restrictions, pagination and result-size limits server-owned;
   bound descriptions, comments, attachments and error bodies before returning
   them as untrusted MCP output.
8. Require persistent encrypted storage for production, retain in-memory state
   only for deterministic development, and prove that restarts do not exchange
   or orphan one user's grant under another user.
9. Ensure logs, exceptions, health, metadata and tool results contain no OAuth
   code, verifier, client secret, access token, refresh token or unrestricted
   upstream response body.
10. Publish reviewed SemVer releases and a reproducible container artifact from
    the fork after its checks pass. Deployment pins a release or digest; AIQSA
    still connects only to the resulting standards-based remote URL.

Yandex Authorization Code, PKCE, refresh and revoke behavior follows the
provider's official
[code-flow](https://yandex.ru/dev/id/doc/en/codes/code-url),
[refresh](https://yandex.ru/dev/id/doc/en/tokens/refresh-client), and
[revocation](https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate)
contracts. Mutable observations belong in the fork's integration documentation
or AIQSA `PROVIDER_API_NOTES.md`, not as invented constants in AIQSA code.

### Gate write access behind a separate generic product decision

- The first AIQSA end-to-end connection uses the fork's read-only mode and
  offers only read tools. The acceptance scenario is current-user validation
  followed by a bounded search for unresolved tasks assigned to that upstream
  user.
- The public fork may retain and improve its write tools, but the reviewed
  AIQSA deployment does not enable them merely because upstream supports
  `tracker:write`.
- MCP `readOnlyHint`, `destructiveHint`, `idempotentHint` and similar
  annotations remain untrusted descriptive metadata. They do not override the
  administrator's whole-server trust decision or create an authorization
  boundary.
- Adding a generic pause/approve/resume lifecycle for state-changing MCP calls,
  or adding MCP elicitation as an AIQSA product capability, changes accepted-run
  persistence, streaming, recovery and user interaction. It requires a
  separate provider-neutral ADR and implementation. It must not arrive as a
  Tracker-only confirmation dialog.
- Until that generic decision exists, an administrator can still activate a
  separately reviewed write-capable MCP under ADR 0021's explicit whole-server
  trust model, but it is not the default or completion criterion for this
  integration.

### Deployment and secret ownership

- The upstream OAuth application ID/secret, upstream callback base,
  organization selection and MCP-store encryption keys belong only to the MCP
  deployment's secret/configuration boundary. Test values stay in uncommitted
  local configuration and are rotated or removed after the test.
- AIQSA owns only its generic MCP client registration and per-user MCP token
  envelopes. It never receives the upstream client secret or organization
  configuration and cannot reconstruct an upstream token from a local login.
- The Tracker MCP is deployed as an independent remote service or development
  process. It is not added as a required AIQSA Compose service, seed fixture,
  environment variable or release-image dependency. The generic fake OAuth MCP
  remains the only repository-owned routine fixture.
- Local browser testing may use a loopback MCP callback and endpoint when the
  browser, AIQSA and MCP process can reach the same loopback identity. Otherwise
  the operator supplies a reachable HTTPS development origin or reverse proxy;
  AIQSA does not add a provider-specific localhost relay.
- Production backup and restore include the MCP's encrypted grant store and
  encryption keys under that service's own operations contract. AIQSA backups
  contain only AIQSA's encrypted MCP-side tokens and are insufficient to
  reconstruct the upstream grant by themselves.

### Privacy and trust disclosure

- A per-user upstream OAuth token preserves the upstream service's own access
  control and actor attribution; the MCP must not broaden it with a shared
  service token.
- The MCP server remains administrator-trusted code. It sees tool arguments,
  upstream data and upstream tokens, and can transform, log or exfiltrate them
  if compromised. Public source and an audited fork reduce but do not remove
  that trust.
- Tool results, task descriptions and comments are untrusted external content
  and may contain prompt injection. AIQSA continues to bound and redact them,
  but does not claim to make their instructions trustworthy.
- Data returned by the MCP becomes part of the selected model provider's run
  context. User/admin surfaces must make the existing multi-MCP and external
  provider disclosure understandable; OAuth authorization does not imply that
  Tracker content remains inside the Tracker or AIQSA host.
- No acceptance evidence prints task text, comments, user email, organization
  name, token material or raw provider responses. Live smoke output is limited
  to safe identity booleans, counts, task keys/status metadata where explicitly
  approved, and stable error classes.

## Delivery Sequence

1. Create the public fork, preserve upstream provenance, pin the reviewed base,
   and add deterministic tests that expose the current token-passthrough and
   revocation gaps.
2. Implement separate downstream MCP tokens and encrypted upstream grants,
   then complete refresh, revocation, subject binding and multi-user isolation
   in the fork.
3. Add the provider-neutral brokered-OAuth fixture to AIQSA and fix only generic
   MCP OAuth interoperability defects it reveals. No Tracker package or service
   participates in routine AIQSA checks.
4. Run the fork locally in read-only mode, activate it in AIQSA as an ordinary
   remote OAuth MCP, and complete one operator-assisted browser consent flow.
5. Prove current-user lookup and the bounded unresolved-assignee search through
   the normal AIQSA model/tool loop, including reconnect, refresh, disconnect
   and cross-user isolation.
6. Publish a reviewed fork release/container and document independent
   deployment. Production exposure requires HTTPS, persistent encrypted store,
   secret rotation/backup instructions and exact release pinning.
7. Treat state-changing tools and AIQSA per-call approval as a later generic
   product decision rather than extending this read-only completion criterion.

## Consequences

- AIQSA gains a reusable proof that brokered per-user OAuth works for remote MCP
  servers without becoming a Yandex Tracker client or integration marketplace.
- Users consent once through the upstream provider and thereafter use automatic
  refresh; they never obtain or paste a personal Tracker token into AIQSA.
- Tracker operations use the actual user's upstream authorization, permissions
  and actor identity instead of a shared robot inferred from email.
- Service-specific churn, tool growth and OAuth behavior stay in an independently
  releasable MCP repository. AIQSA upgrades its generic MCP client only for MCP
  protocol or security changes.
- Two OAuth layers and an additional encrypted service store increase deployment,
  refresh, revocation, backup and observability work. That complexity is the
  cost of preserving audience boundaries and user attribution.
- The external fork remains a trusted dependency even though it is not linked
  into AIQSA. Administrators must review and pin its deployment just as they
  review every other MCP server and its complete tool set.
- Read-only first limits the initial blast radius. It also means full write
  automation is deliberately not part of this ADR's completion claim.

## Rejected Alternatives

- **Persist broader scopes from AIQSA's Yandex login.** This couples login to
  one integration, requests excessive authority at every sign-in and violates
  the existing identity-only login-token contract.
- **Trust the verified AIQSA email at Tracker.** Email is an AIQSA identity
  assertion, not a Tracker API credential or delegated authorization grant.
- **Build Yandex routes and tools directly into AIQSA.** This duplicates MCP,
  introduces provider-specific persistence and forces AIQSA releases for
  Tracker changes.
- **Use one shared OAuth/IAM token in the MCP.** Calls would use the robot's
  permissions and attribution, and the MCP would have to reproduce Tracker's
  per-user access model.
- **Return the Yandex token as the MCP bearer token.** This is upstream token
  passthrough, removes MCP audience isolation and violates the current MCP
  authorization contract.
- **Vendor the fork or bundle it in the required AIQSA stack.** That creates an
  implementation dependency and a privileged default integration instead of a
  generic administrator-selected remote MCP.
- **Enable read/write for the first smoke.** The OAuth topology can be proven
  with read-only access; accepting state-changing model calls without a generic
  approval contract adds unrelated product risk.

## Required Verification

AIQSA deterministic coverage must prove:

- path-aware protected-resource and authorization-server discovery;
- exact resource and issuer binding, reviewed-origin enforcement and SSRF-safe
  registration/token/revocation requests;
- dynamic client registration or Client ID Metadata Document use, installation
  client reuse and rejection after redirect or policy-fingerprint drift;
- S256 PKCE/state binding, callback user binding, single-use completion and safe
  cancellation/error outcomes;
- encrypted per-user MCP token persistence, serialized refresh rotation,
  disconnect/drain/revocation and reauthorization-required behavior;
- two local users cannot reuse, overwrite, inspect or execute through each
  other's MCP grant;
- the generic UI and APIs expose no provider name, upstream token, OAuth code,
  client secret, verifier or raw account response;
- a brokered fake upstream can complete authorization and one read tool call
  without any provider-specific AIQSA module or configuration field.

The fork's deterministic coverage must prove:

- MCP and Yandex token values are distinct and only MCP-audienced tokens leave
  the MCP token endpoint;
- inbound MCP audience/client/resource/scope/expiry checks fail closed;
- upstream codes, access tokens and refresh tokens remain encrypted and
  server-only through create, refresh, restart, disconnect and revoke;
- concurrent downstream and upstream refresh operations have one winning
  rotation and cannot exchange grants between users;
- state, PKCE, callback, client, subject and organization mismatches fail before
  a Tracker tool becomes ready;
- read-only mode requests only read scope and exposes no write tool, while
  explicit write mode retains complete tool tests without becoming the AIQSA
  default;
- exactly one configured organization-header family is sent and bounded Tracker
  errors/results never reveal credentials or unrestricted bodies;
- persistent-store restart, multi-user isolation, pagination, queue restriction
  and result-size limits remain deterministic.

The opt-in live smoke requires explicit current operator credentials and one
interactive browser consent. It must verify the upstream current user, the
expected organization-header family, a bounded query equivalent to
`Assignee: me() Resolution: empty()`, reconnect/refresh, and disconnect. It
does not run in routine Vitest/Playwright, does not write Tracker state, does not
print private task content or secrets, and is skipped cleanly when external
authority is absent.
