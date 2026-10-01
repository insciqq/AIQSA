import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersonalMcp,
  loadPersonalMcpConnections,
  PersonalMcpApiError,
  personalMcpAuthorizationValue,
  replacePersonalMcpCredentials
} from "./personalMcpApi";

afterEach(() => vi.unstubAllGlobals());

function server(overrides: Record<string, unknown> = {}) {
  return {
    accountLabel: null, authHeaderName: null, authMode: "none",
    availableTools: [{ description: "Echo", name: "echo" }, { description: null, name: "write" }],
    description: "Synthetic personal MCP", enabled: true, fields: [], id: "personal-1", knownToolCount: 1,
    name: "Synthetic personal MCP", oauthAvailable: false, oauthState: null, readiness: "ready", runtimeErrorCode: null,
    sourceType: "personal", tools: [{ description: "Echo", name: "echo" }], userDisabledToolNames: ["write"],
    ...overrides
  };
}

function serve(body: unknown, init: ResponseInit = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, init)));
}

describe("Personal MCP API decoding", () => {
  it("rejects a malformed server instead of treating it as an empty catalog", async () => {
    serve({ servers: [{}] });
    await expect(loadPersonalMcpConnections()).rejects.toMatchObject({ code: "mcp_response_invalid", status: 502 });
  });

  it("decodes readiness, the runtime code, the auth mode and the switched-off tools", async () => {
    serve({ servers: [server({
      authHeaderName: "X-API-Key", authMode: "static", readiness: "unavailable", runtimeErrorCode: "mcp_authorization_required"
    })] });
    await expect(loadPersonalMcpConnections()).resolves.toEqual([expect.objectContaining({
      authHeaderName: "X-API-Key",
      authMode: "static",
      availableTools: [{ description: "Echo", name: "echo" }, { description: null, name: "write" }],
      readiness: "unavailable",
      runtimeErrorCode: "mcp_authorization_required",
      userDisabledToolNames: ["write"]
    })]);
  });

  it.each(["mcp_internal_address_forbidden", "mcp_local_network_disabled", "mcp_tool_disabled", "mcp_tool_definition_changed"])(
    "accepts the registry runtime code %s",
    async (runtimeErrorCode) => {
      serve({ servers: [server({ readiness: "unavailable", runtimeErrorCode })] });
      await expect(loadPersonalMcpConnections()).resolves.toEqual([expect.objectContaining({ runtimeErrorCode })]);
    }
  );

  it("derives the auth mode of a row that omits it from its projected slot and OAuth availability", async () => {
    const secret = { configured: true, label: "Authorization header", sensitive: true, slotKey: "authorization", source: "personal", valueType: "secret" };
    serve({ servers: [
      server({ authHeaderName: undefined, authMode: undefined, fields: [secret], id: "static-1" }),
      server({ authHeaderName: undefined, authMode: undefined, id: "oauth-1", oauthAvailable: true, oauthState: "disconnected" }),
      server({ authHeaderName: undefined, authMode: undefined, id: "none-1" })
    ] });
    const loaded = await loadPersonalMcpConnections();
    expect(loaded.map((item) => [item.id, item.authMode, item.authHeaderName])).toEqual([
      ["static-1", "static", null], ["oauth-1", "oauth", null], ["none-1", "none", null]
    ]);
  });

  it.each([
    ["an unknown runtime code", { runtimeErrorCode: "mcp_made_up" }],
    ["an unknown auth mode", { authMode: "basic" }],
    ["an empty header name", { authHeaderName: "" }],
    ["a malformed disabled set", { userDisabledToolNames: ["bad name"] }],
    ["a disabled set that is not a list", { userDisabledToolNames: "write" }],
    ["an oversized disabled set", { userDisabledToolNames: Array.from({ length: 1_025 }, (_, index) => `tool_${index}`) }],
    ["a missing inventory", { availableTools: undefined }],
    ["an installation row", { sourceType: "installation" }]
  ])("rejects %s", async (_label, overrides) => {
    serve({ servers: [server(overrides)] });
    await expect(loadPersonalMcpConnections()).rejects.toMatchObject({ code: "mcp_response_invalid" });
  });
});

describe("Personal MCP API errors", () => {
  it("keeps issue codes and paths but drops upstream status, operation and endpoint", async () => {
    serve({ error: "mcp_draft_test_failed", issues: [
      { code: "mcp_authorization_required", endpoint: "https://upstream.example/mcp", httpStatus: 401, operation: "initialize", path: "source" },
      { code: "Not A Code", path: "source" }
    ] }, { status: 422 });
    const failure = await createPersonalMcp({ auth: { mode: "none" }, name: "x", url: "https://x.example/mcp" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PersonalMcpApiError);
    expect(failure).toMatchObject({ code: "mcp_draft_test_failed", issues: [{ code: "mcp_authorization_required", path: "source" }], status: 422 });
    expect(JSON.stringify((failure as PersonalMcpApiError).issues)).not.toContain("upstream.example");
  });

  it("reads the retry time of a rate-limited create", async () => {
    serve({ error: "personal_mcp_rate_limited" }, { headers: { "retry-after": "120" }, status: 429 });
    await expect(createPersonalMcp({ auth: { mode: "none" }, name: "x", url: "https://x.example/mcp" }))
      .rejects.toMatchObject({ code: "personal_mcp_rate_limited", retryAfterSeconds: 120 });
  });

  it("returns the exact cross-site origins to confirm and refuses a malformed list", async () => {
    const body = { authorizationOrigins: ["https://login.example"], error: "oauth_authorization_origin_confirmation_required",
      issues: [{ code: "oauth_authorization_origin_confirmation_required", path: "authorizationOriginsAcknowledged" }] };
    serve(body, { status: 422 });
    await expect(createPersonalMcp({ auth: { mode: "oauth" }, name: "x", url: "https://x.example/mcp" }))
      .rejects.toMatchObject({ authorizationOrigins: ["https://login.example"], code: "oauth_authorization_origin_confirmation_required" });
    serve({ ...body, authorizationOrigins: ["https://login.example/path"] }, { status: 422 });
    await expect(createPersonalMcp({ auth: { mode: "oauth" }, name: "x", url: "https://x.example/mcp" }))
      .rejects.toMatchObject({ code: "mcp_response_invalid" });
  });
});

describe("Personal MCP credential replacement", () => {
  it("patches only the credentials and decodes the updated row", async () => {
    const fetchMock = vi.fn(async () => Response.json({ server: server({ authHeaderName: "X-API-Key", authMode: "static" }) }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(replacePersonalMcpCredentials("personal/1", { credentials: { authorization: "raw", headerName: "X-API-Key" } }))
      .resolves.toMatchObject({ authHeaderName: "X-API-Key", authMode: "static", userDisabledToolNames: ["write"] });
    expect(fetchMock).toHaveBeenCalledWith("/api/me/mcp-connections/personal%2F1", expect.objectContaining({
      body: JSON.stringify({ credentials: { authorization: "raw", headerName: "X-API-Key" } }),
      method: "PATCH"
    }));
  });

  it("keeps the field paths of a refused replacement", async () => {
    serve({ error: "header_name_invalid", issues: [{ code: "header_name_invalid", path: "credentials.headerName" }] }, { status: 422 });
    await expect(replacePersonalMcpCredentials("personal-1", { credentials: { authorization: "x", headerName: "Host" } }))
      .rejects.toMatchObject({ code: "header_name_invalid", issues: [{ code: "header_name_invalid", path: "credentials.headerName" }] });
  });
});

describe("personalMcpAuthorizationValue", () => {
  it("prefixes a bare token in the Authorization header only", () => {
    expect(personalMcpAuthorizationValue("Authorization", " ghp_secret \n")).toBe("Bearer ghp_secret");
    expect(personalMcpAuthorizationValue("authorization", "token-1")).toBe("Bearer token-1");
    expect(personalMcpAuthorizationValue("Authorization", "Bearer abc")).toBe("Bearer abc");
    expect(personalMcpAuthorizationValue("Authorization", "Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
    expect(personalMcpAuthorizationValue("X-API-Key", "raw-key")).toBe("raw-key");
    expect(personalMcpAuthorizationValue("X-API-Key", "Bearer raw-key")).toBe("Bearer raw-key");
    expect(personalMcpAuthorizationValue("Authorization", "   ")).toBe("");
  });
});
