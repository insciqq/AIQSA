/**
 * Synthetic `/api/me/mcp-connections` for the Settings → Connections gallery
 * states. It answers in the browser, so a state renders without a session or
 * a real MCP server. The submitted URL's host picks an error scenario:
 *
 * - `confirm.example`: cross-site OAuth confirmation, accepted once acknowledged;
 * - `limit.example`, `rate.example`: connection limit and rate limit;
 * - `internal.example`, `lan.example`: AIQSA-internal address, local network turned off;
 * - `token.example`: the server rejects the token;
 * - `insecure-oauth.example`: an https server that signs in over http.
 *
 * A replacement token containing "reject" is refused by the synthetic server.
 */
export type PersonalMcpFixtureScenario = "empty" | "error" | "rows";

type Row = Record<string, unknown> & { id: string; name: string };

const CROSS_SITE_ORIGIN = "https://login.confirm-auth.example";

function tools(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    description: index % 3 === 0 ? `Searches synthetic documents, collection ${index + 1}.` : null,
    name: `docs_tool_${String(index + 1).padStart(2, "0")}`
  }));
}

function row(overrides: Partial<Row> & { id: string; name: string }): Row {
  const available = (overrides.availableTools as ReturnType<typeof tools> | undefined) ?? tools(2);
  const disabled = (overrides.userDisabledToolNames as string[] | undefined) ?? [];
  return {
    accountLabel: null,
    authHeaderName: null,
    authMode: "none",
    availableTools: available,
    description: "",
    enabled: true,
    endpoint: `https://${overrides.id}.example/mcp`,
    fields: [],
    knownToolCount: available.length - disabled.length,
    oauthAvailable: false,
    oauthState: null,
    readiness: "ready",
    runtimeErrorCode: null,
    sourceType: "personal",
    tools: available.filter((tool) => !disabled.includes(tool.name)),
    userDisabledToolNames: disabled,
    ...overrides
  };
}

function scenarioRows(): Row[] {
  const docs = tools(20);
  return [
    row({
      authHeaderName: "Authorization", authMode: "static", availableTools: docs, id: "docs-search", name: "Docs search",
      userDisabledToolNames: ["docs_tool_04", "docs_tool_11"]
    }),
    row({
      authMode: "oauth", endpoint: "https://mcp.notion.example/mcp", id: "notion", name: "Notion", oauthAvailable: true,
      oauthState: "reauthorization_required", readiness: "reauthorization_required"
    }),
    row({ endpoint: "http://192.168.1.20:8080/mcp", id: "home-lab", name: "Home lab", readiness: "unavailable", runtimeErrorCode: "mcp_local_network_disabled" }),
    row({ endpoint: "http://localhost:3000/mcp", id: "local-tools", name: "Local tools", readiness: "unavailable", runtimeErrorCode: "mcp_internal_address_forbidden" }),
    row({
      authHeaderName: "Authorization", authMode: "static", endpoint: "https://api.github.example/mcp", id: "github", name: "GitHub",
      readiness: "unavailable", runtimeErrorCode: "mcp_authorization_required"
    }),
    row({ id: "tracker", name: "Tracker", readiness: "starting" }),
    row({
      authMode: "oauth", endpoint: "https://changed-signin.example/mcp", id: "changed-signin", name: "Changed sign-in",
      oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization"
    })
  ];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });
}

function hostOf(url: unknown): string {
  try { return typeof url === "string" ? new URL(url).hostname : ""; } catch { return ""; }
}

/** Replaces `fetch` for the connections routes until the returned restore runs. */
export function installPersonalMcpFixtureApi(scenario: PersonalMcpFixtureScenario): () => void {
  const original = window.fetch;
  let servers: Row[] = scenario === "rows" ? scenarioRows() : [];
  let reads = 0;
  let sequence = 0;
  const handle = async (path: string, init: RequestInit | undefined): Promise<Response | null> => {
    if (!path.startsWith("/api/me/mcp-connections")) return null;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const id = decodeURIComponent(path.split("/")[4] ?? "");
    if (path === "/api/me/mcp-connections" && method === "GET") {
      if (scenario === "error") return json({ error: "mcp_unavailable" }, 503);
      reads += 1;
      // The starting connection settles after a few reads, as a runtime would.
      if (reads > 2) servers = servers.map((item) => item.readiness === "starting" ? { ...item, readiness: "ready" } : item);
      return json({ servers });
    }
    if (path === "/api/me/mcp-connections" && method === "POST") {
      const host = hostOf(body.url);
      const auth = (body.auth ?? {}) as { headerName?: string; mode?: string };
      if (host === "limit.example") return json({ error: "personal_mcp_limit_reached" }, 409);
      if (host === "rate.example") return json({ error: "personal_mcp_rate_limited" }, 429, { "retry-after": "120" });
      if (host === "internal.example") return json({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_internal_address_forbidden", path: "source" }] }, 422);
      if (host === "lan.example") return json({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_local_network_disabled", path: "source" }] }, 422);
      if (host === "token.example") return json({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_authorization_required", path: "oneTimeValues.authorization" }] }, 422);
      if (host === "insecure-oauth.example") return json({ error: "mcp_oauth_insecure_endpoint" }, 422);
      if (host === "confirm.example" && !(body.authorizationOriginsAcknowledged as string[] | undefined)?.includes(CROSS_SITE_ORIGIN)) {
        return json({
          authorizationOrigins: [CROSS_SITE_ORIGIN],
          error: "oauth_authorization_origin_confirmation_required",
          issues: [{ code: "oauth_authorization_origin_confirmation_required", path: "authorizationOriginsAcknowledged" }]
        }, 422);
      }
      sequence += 1;
      const created = row({
        authHeaderName: auth.mode === "static" ? auth.headerName ?? "Authorization" : null,
        authMode: auth.mode ?? "none",
        endpoint: String(body.url),
        id: `created-${sequence}`,
        name: String(body.name),
        ...(auth.mode === "oauth"
          ? { oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization", availableTools: [], userDisabledToolNames: [] }
          : {})
      });
      servers = [created, ...servers];
      return json({ server: created }, 201);
    }
    if (path.endsWith("/oauth/connect") && method === "POST") {
      if (id === "changed-signin") return json({ error: "mcp_oauth_policy_forbidden" }, 422);
      return json({ error: "personal_mcp_rate_limited" }, 429, { "retry-after": "45" });
    }
    const current = servers.find((item) => item.id === id);
    if (!current) return json({ error: "mcp_not_found" }, 404);
    if (method === "DELETE") {
      servers = servers.filter((item) => item.id !== id);
      return json({ server: current });
    }
    if (method === "PATCH") {
      let next: Row = current;
      if (typeof body.enabled === "boolean") next = { ...current, enabled: body.enabled, readiness: body.enabled ? "ready" : "disabled" };
      const tool = body.tool as { enabled: boolean; name: string } | undefined;
      if (tool) {
        const disabled = new Set(current.userDisabledToolNames as string[]);
        if (tool.enabled) disabled.delete(tool.name);
        else disabled.add(tool.name);
        next = row({ ...current, userDisabledToolNames: [...disabled].sort() });
      }
      const credentials = body.credentials as { authorization: string; headerName?: string } | undefined;
      if (credentials) {
        if (current.authMode !== "static") return json({ error: "auth_mode_invalid", issues: [{ code: "auth_mode_invalid", path: "credentials" }] }, 422);
        if (/reject/iu.test(credentials.authorization)) {
          return json({ error: "mcp_draft_test_failed", issues: [{ code: "mcp_authorization_required", path: "credentials.authorization" }] }, 422);
        }
        next = { ...current, authHeaderName: credentials.headerName ?? current.authHeaderName, readiness: "ready", runtimeErrorCode: null };
      }
      servers = servers.map((item) => item.id === id ? next : item);
      return json({ server: next });
    }
    return json({ error: "method_not_allowed" }, 405);
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const answer = url.origin === window.location.origin ? await handle(url.pathname, init) : null;
    return answer ?? original(input, init);
  };
  return () => {
    window.fetch = original;
  };
}
