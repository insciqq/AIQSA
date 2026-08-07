# MCP OAUTH AND BROKERED SAAS NOTES

Owner: Provider integration maintainers
Scope: Externally mutable official constraints and verified caveats for remote MCP OAuth, hosted Notion, and brokered SaaS targets.
Read when: Changing remote MCP authorization, protected-resource discovery, hosted Notion, upstream OAuth redirects, or external conformance targets.
Code owners: `lib/server/mcp/` and remote MCP administrator setup.
Not owned here: AIQSA MCP policy, persistence, readiness, local ToolHive lifecycle, or tool-loop behavior.

## MCP OAuth, Hosted Notion, And Brokered SaaS

Last verified: 2026-07-29.

Primary references:

- `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- `https://developers.notion.com/docs/mcp`
- `https://mcp.notion.com/mcp`
- `https://yandex.ru/dev/id/doc/en/codes/code-url`
- `https://yandex.ru/dev/id/doc/en/tokens/refresh-client`
- `https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate`
- `https://yandex.ru/support/tracker/ru/api-ref/users/get-user-info`
- `https://yandex.ru/support/tracker/en/user/query-filter`

Externally constrained facts:

- Remote MCP authorization is a protected-resource OAuth flow, not AI-provider sign-in. The specification supports Authorization Code with S256 PKCE, protected-resource and authorization-server discovery, dynamic client registration or Client ID Metadata Documents, refresh, and advertised revocation.
- The hosted Notion endpoint returned the expected protected-resource challenge. Its public metadata advertised the canonical MCP resource, authorization code and refresh grants, S256 PKCE, dynamic registration, Client ID Metadata Documents, introspection, and revocation.
- Same-origin MCP endpoints may publish a canonical resource with a different path from the Streamable HTTP URL: verified services included both an endpoint-path resource and an origin-root resource. Path equality is therefore not portable, while accepting a discovered resource outside the configured endpoint origin would broaden trust.
- Hosted Notion consent or public metadata does not prove post-consent tool discovery and execution. Automation and operator reports must distinguish those boundaries from a successful end-to-end tool call.
- ToolHive v0.40.1's interactive remote OAuth flow owns a local loopback/browser lifecycle.
- A standards-conforming remote MCP may redirect its own authorization endpoint
  through a second upstream OAuth code flow. The MCP resource must issue and
  validate its own resource-audienced tokens rather than passing through the
  upstream token.
- Yandex supports authorization-code PKCE, refresh, and device-bound token
  invalidation. Tracker's current-user endpoint is suitable for binding a
  server-side grant to the authorized subject, and Tracker query syntax supports
  an unresolved current-assignee filter.

Current MCP policy, persistence, source matrix, readiness, and tool-loop behavior are routed by `BACKEND.md` and `SECURITY.md` rather than this mutable external-facts note.
