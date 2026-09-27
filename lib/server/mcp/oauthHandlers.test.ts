// @vitest-environment node

import type { AuthenticatedSession } from "@/lib/server/auth/requestAuth";
import { describe, expect, it, vi } from "vitest";

// The start routes are imported only to inspect their method exports.
vi.mock("@/lib/server/auth/defaultAuth", () => ({ resolveRequestAuth: vi.fn() }));
vi.mock("@/lib/server/mcp/defaultActivation", () => ({ settleDefaultMcpOAuth: vi.fn() }));
vi.mock("@/lib/server/mcp/defaultOAuth", () => ({ mcpOAuthService: {} }));
vi.mock("@/lib/server/mcp/defaultRuntime", () => ({ kickDefaultMcpRuntime: vi.fn() }));
import {
  createMcpOAuthCallbackHandler,
  createMcpOAuthDisconnectHandler,
  createMcpOAuthStartHandler,
  type McpOAuthHandlerDeps
} from "./oauthHandlers";
import { signMcpOAuthFlow } from "./oauthFlow";
import type { McpOAuthFlowBinding, McpOAuthService } from "./oauthService";

const NOW = new Date("2026-07-22T15:00:00.000Z");
const SERVER_ID = "server-1";
const SESSION_SECRET = "mcp-oauth-handler-test-session-secret";
const USER: AuthenticatedSession = {
  expiresAt: new Date("2026-07-23T15:00:00.000Z"),
  id: "session-1",
  user: {
    displayName: "MCP User",
    email: "mcp@example.test",
    id: "user-1",
    role: "user",
    status: "active"
  },
  userId: "user-1"
};

function flow(): McpOAuthFlowBinding {
  return {
    clientId: "fixture-client",
    codeVerifier: "fixture-code-verifier",
    configurationIdentity: "revision-1",
    oauthClientId: "oauth-client-1",
    policyFingerprint: "policy-fingerprint",
    purpose: "user",
    redirectUri: `https://aiqsa.example.test/api/me/mcp/${SERVER_ID}/oauth/callback`,
    registrationKey: "registration-key",
    serverId: SERVER_ID,
    state: "fixture-state",
    userId: USER.userId
  };
}

function service(input: Partial<Pick<
  McpOAuthService,
  "completeAuthorization" | "disconnect" | "startAuthorization"
>> = {}): McpOAuthHandlerDeps["service"] {
  return {
    completeAuthorization: vi.fn(async () => ({ id: "connection-1" })) as never,
    disconnect: vi.fn(async () => "disconnected" as const),
    startAuthorization: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.test/authorize?state=fixture-state",
      flow: flow(),
      kind: "redirect" as const
    })),
    ...input
  };
}

function deps(input: Partial<McpOAuthHandlerDeps> = {}): McpOAuthHandlerDeps {
  return {
    getConfig: () => ({
      appBaseUrl: "https://aiqsa.example.test",
      configured: true,
      cookieSecure: true,
      sessionSecret: SESSION_SECRET
    }),
    now: () => NOW,
    randomState: () => "fixture-state",
    resolveAuth: async () => USER,
    service: service(),
    ...input
  };
}

function routeContext() {
  return { params: Promise.resolve({ serverId: SERVER_ID }) };
}

function cookieHeader(response: Response): string {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function startLocation(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  const body = await response.json() as { location?: unknown };
  expect(Object.keys(body)).toEqual(["location"]);
  return new URL(String(body.location));
}

const START_ROUTES = [
  ["user connect", "https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect", false, "user"],
  ["user reconnect", "https://aiqsa.example.test/api/me/mcp/server-1/oauth/reconnect", true, "user"],
  ["validation connect", "https://aiqsa.example.test/api/admin/mcp/server-1/oauth/validation/connect", false, "validation"],
  ["validation reconnect", "https://aiqsa.example.test/api/admin/mcp/server-1/oauth/validation/reconnect", true, "validation"]
] as const;
const ADMIN: AuthenticatedSession = { ...USER, user: { ...USER.user, role: "admin" } };

describe("MCP OAuth web handlers", () => {
  it("signs the server-side flow fixture", async () => {
    await expect(signMcpOAuthFlow({
      flow: flow(),
      now: NOW,
      sessionSecret: SESSION_SECRET
    })).resolves.toMatch(/^ey/u);
  });

  it.each(START_ROUTES)("starts a %s flow over POST with a signed HttpOnly cookie and no token response", async (_label, url, forceReconnect, purpose) => {
    const operations = service();
    const handler = createMcpOAuthStartHandler(deps({
      resolveAuth: async () => purpose === "validation" ? ADMIN : USER,
      service: operations
    }), { forceReconnect, purpose });
    const response = await handler(new Request(url, { method: "POST" }), routeContext());
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect((await startLocation(response)).toString()).toBe(
      "https://auth.example.test/authorize?state=fixture-state"
    );
    expect(operations.startAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      forceReconnect,
      purpose,
      serverId: SERVER_ID,
      userId: USER.userId
    }));
  });

  it.each(START_ROUTES)("GET start does not call settleAuthorization or startAuthorization on %s", async (_label, url, forceReconnect, purpose) => {
    const operations = service({
      startAuthorization: vi.fn(async () => ({ configurationIdentity: "revision-1", kind: "already_connected" as const }))
    });
    const settleAuthorization = vi.fn(async () => ({ kind: "ok" as const }));
    const onRuntimeChanged = vi.fn();
    const resolveAuth = vi.fn(async () => purpose === "validation" ? ADMIN : USER);
    const handler = createMcpOAuthStartHandler(deps({
      onRuntimeChanged,
      resolveAuth,
      service: operations,
      settleAuthorization
    }), { forceReconnect, purpose });
    const response = await handler(new Request(`${url}?return=%2Fc%2Fchat-1`), routeContext());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(operations.startAuthorization).not.toHaveBeenCalled();
    expect(settleAuthorization).not.toHaveBeenCalled();
    expect(onRuntimeChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["user connect", () => import("@/app/api/me/mcp/[serverId]/oauth/connect/route")],
    ["user reconnect", () => import("@/app/api/me/mcp/[serverId]/oauth/reconnect/route")],
    ["validation connect", () => import("@/app/api/admin/mcp/[serverId]/oauth/validation/connect/route")],
    ["validation reconnect", () => import("@/app/api/admin/mcp/[serverId]/oauth/validation/reconnect/route")]
  ])("exposes the %s start route only over POST", async (_label, load) => {
    const route: Record<string, unknown> = await load();
    expect(typeof route.POST).toBe("function");
    expect(route.GET).toBeUndefined();
  });

  it("rejects state mismatch before exchanging a code and consumes the cookie", async () => {
    const operations = service();
    const start = createMcpOAuthStartHandler(deps({ service: operations }), {
      forceReconnect: false,
      purpose: "user"
    });
    const startResponse = await start(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect", { method: "POST" }),
      routeContext()
    );
    const callback = createMcpOAuthCallbackHandler(deps({ service: operations }), "user");
    const response = await callback(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback?state=wrong&code=secret-code",
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=failed");
    expect(response.headers.get("location")).not.toContain("secret-code");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(operations.completeAuthorization).not.toHaveBeenCalled();
  });

  it("exchanges a valid callback server-side and redirects with only safe status", async () => {
    const operations = service();
    const settleAuthorization = vi.fn(async () => ({ kind: "ok" as const }));
    const onRuntimeChanged = vi.fn();
    const handlerDeps = deps({ onRuntimeChanged, service: operations, settleAuthorization });
    const start = createMcpOAuthStartHandler(handlerDeps, {
      forceReconnect: true,
      purpose: "user"
    });
    const startResponse = await start(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/reconnect", { method: "POST" }),
      routeContext()
    );
    const callback = createMcpOAuthCallbackHandler(handlerDeps, "user");
    const response = await callback(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback" +
        "?state=fixture-state&code=secret-code&iss=https%3A%2F%2Fauth.example.test",
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());
    expect(operations.completeAuthorization).toHaveBeenCalledWith({
      authorizationCode: "secret-code",
      flow: flow(),
      issuer: "https://auth.example.test"
    });
    expect(settleAuthorization).toHaveBeenCalledWith({
      configurationIdentity: flow().configurationIdentity,
      purpose: "user",
      serverId: SERVER_ID,
      userId: USER.userId
    });
    expect(onRuntimeChanged).toHaveBeenCalledWith(USER.userId);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("oauth=connected");
    expect(new URL(location).searchParams.get("library")).toBe("mcp");
    expect(new URL(location).searchParams.has("settings")).toBe(false);
    expect(location).toContain(`server=${SERVER_ID}`);
    expect(location).not.toContain("secret-code");
    expect(location).not.toContain("fixture-code-verifier");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["duplicate", "&iss=https%3A%2F%2Fauth.example.test&iss=https%3A%2F%2Fother.example.test"],
    ["oversized", `&iss=${"a".repeat(8_193)}`]
  ])("rejects a %s callback issuer before exchanging the code", async (_label, issuerQuery) => {
    const operations = service();
    const handlerDeps = deps({ service: operations });
    const start = createMcpOAuthStartHandler(handlerDeps, {
      forceReconnect: true,
      purpose: "user"
    });
    const startResponse = await start(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/reconnect", { method: "POST" }),
      routeContext()
    );
    const callback = createMcpOAuthCallbackHandler(handlerDeps, "user");
    const response = await callback(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback" +
        `?state=fixture-state&code=secret-code${issuerQuery}`,
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=failed");
    expect(operations.completeAuthorization).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("returns a safe failed callback outcome when automatic enablement fails", async () => {
    const operations = service();
    const settleAuthorization = vi.fn(async () => ({ kind: "failed" as const }));
    const onRuntimeChanged = vi.fn();
    const handlerDeps = deps({ onRuntimeChanged, service: operations, settleAuthorization });
    const start = createMcpOAuthStartHandler(handlerDeps, {
      forceReconnect: true,
      purpose: "user"
    });
    const startResponse = await start(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/reconnect", { method: "POST" }),
      routeContext()
    );
    const callback = createMcpOAuthCallbackHandler(handlerDeps, "user");
    const response = await callback(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback?state=fixture-state&code=secret-code",
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());

    expect(operations.completeAuthorization).toHaveBeenCalledOnce();
    expect(settleAuthorization).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("oauth=failed");
    expect(location).not.toContain("secret-code");
    expect(location).not.toContain("fixture-code-verifier");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(onRuntimeChanged).not.toHaveBeenCalled();
  });

  it("settles an existing connection instead of leaving its server disabled", async () => {
    const operations = service({
      startAuthorization: vi.fn(async () => ({
        configurationIdentity: "revision-1",
        kind: "already_connected" as const
      }))
    });
    const settleAuthorization = vi.fn(async () => ({ kind: "ok" as const }));
    const onRuntimeChanged = vi.fn();
    const start = createMcpOAuthStartHandler(deps({
      onRuntimeChanged,
      service: operations,
      settleAuthorization
    }), { forceReconnect: false, purpose: "user" });

    const response = await start(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect", { method: "POST" }),
      routeContext()
    );

    const location = await startLocation(response);
    expect(location.origin).toBe("https://aiqsa.example.test");
    expect(location.searchParams.get("oauth")).toBe("connected");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(settleAuthorization).toHaveBeenCalledWith({
      configurationIdentity: "revision-1",
      purpose: "user",
      serverId: SERVER_ID,
      userId: USER.userId
    });
    expect(onRuntimeChanged).toHaveBeenCalledWith(USER.userId);
  });

  it.each([
    ["connected", "code=secret-code", "connected"],
    ["cancelled", "error=access_denied", "cancelled"],
    ["failed", "error=server_error", "failed"]
  ])("returns a %s personal authorization to the chat it started from", async (_label, outcomeQuery, outcome) => {
    const handlerDeps = deps({ service: service(), settleAuthorization: vi.fn(async () => ({ kind: "ok" as const })) });
    const start = createMcpOAuthStartHandler(handlerDeps, { forceReconnect: false, purpose: "user" });
    const startResponse = await start(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect?return=%2Fp%2Fproject-1%2Fc%2Fchat-1",
      { method: "POST" }
    ), routeContext());
    expect((await startLocation(startResponse)).toString()).toBe("https://auth.example.test/authorize?state=fixture-state");
    const callback = createMcpOAuthCallbackHandler(handlerDeps, "user");
    const response = await callback(new Request(
      `https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback?state=fixture-state&${outcomeQuery}`,
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://aiqsa.example.test");
    expect(location.pathname).toBe("/p/project-1/c/chat-1");
    expect(Object.fromEntries(location.searchParams)).toEqual({ library: "mcp", oauth: outcome, server: SERVER_ID });
  });

  it.each([
    "https%3A%2F%2Fevil.example.test%2Fc%2Fchat-1",
    "%2F%2Fevil.example.test%2Fc%2Fchat-1",
    "%2Fadmin",
    "%2Fc%2Fchat-1%3Flibrary%3Dartifacts",
    "%2Fapi%2Fme%2Fmcp%2Fserver-1%2Foauth%2Fconnect"
  ])("falls back to the new chat for the tampered return %s", async (returnValue) => {
    const operations = service({
      startAuthorization: vi.fn(async () => ({ configurationIdentity: "revision-1", kind: "already_connected" as const }))
    });
    const start = createMcpOAuthStartHandler(deps({ service: operations }), { forceReconnect: false, purpose: "user" });
    const response = await start(new Request(
      `https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect?return=${returnValue}`,
      { method: "POST" }
    ), routeContext());
    const location = await startLocation(response);
    expect(location.origin).toBe("https://aiqsa.example.test");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("oauth")).toBe("connected");
  });

  it("returns an already connected authorization to its chat and ignores a foreign flow's return", async () => {
    const connected = service({
      startAuthorization: vi.fn(async () => ({ configurationIdentity: "revision-1", kind: "already_connected" as const }))
    });
    const start = createMcpOAuthStartHandler(deps({ service: connected }), { forceReconnect: false, purpose: "user" });
    const response = await start(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect?return=%2Fc%2Fchat-1",
      { method: "POST" }
    ), routeContext());
    expect((await startLocation(response)).pathname).toBe("/c/chat-1");

    const foreignCookie = `aiqsa_mcp_oauth_flow=${await signMcpOAuthFlow({
      flow: { ...flow(), userId: "someone-else" },
      now: NOW,
      returnPath: "/c/foreign-chat",
      sessionSecret: SESSION_SECRET
    })}`;
    const callback = createMcpOAuthCallbackHandler(deps(), "user");
    const failed = await callback(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback?state=fixture-state&code=secret-code",
      { headers: { cookie: foreignCookie } }
    ), routeContext());
    const location = new URL(failed.headers.get("location") ?? "");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("oauth")).toBe("failed");
  });

  it("keeps administrator validation outcomes in Control Center", async () => {
    const operations = service({
      startAuthorization: vi.fn(async () => ({ configurationIdentity: "revision-1", kind: "already_connected" as const }))
    });
    const start = createMcpOAuthStartHandler(deps({ resolveAuth: async () => ADMIN, service: operations }), {
      forceReconnect: false,
      purpose: "validation"
    });
    const response = await start(new Request(
      "https://aiqsa.example.test/api/admin/mcp/server-1/oauth/validation/connect?return=%2Fc%2Fchat-1",
      { method: "POST" }
    ), routeContext());
    const location = await startLocation(response);
    expect(location.pathname).toBe("/admin");
    expect(Object.fromEntries(location.searchParams)).toEqual({ oauth: "connected", section: "mcp", server: SERVER_ID });
  });

  it("keeps administrator validation routes unavailable to ordinary users", async () => {
    const operations = service();
    const start = createMcpOAuthStartHandler(deps({ service: operations }), {
      forceReconnect: false,
      purpose: "validation"
    });
    const response = await start(
      new Request("https://aiqsa.example.test/api/admin/mcp/server-1/oauth/validation/connect", {
        method: "POST"
      }),
      routeContext()
    );
    expect(response.status).toBe(403);
    expect(operations.startAuthorization).not.toHaveBeenCalled();
  });

  it("disconnects idempotently without exposing stored credentials", async () => {
    const operations = service({ disconnect: vi.fn(async () => "not_found" as const) });
    const disconnect = createMcpOAuthDisconnectHandler(deps({ service: operations }), "user");
    const response = await disconnect(new Request(
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/disconnect",
      { method: "POST" }
    ), routeContext());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "disconnected" });
    expect(JSON.stringify(body)).not.toContain("token");
  });
});
