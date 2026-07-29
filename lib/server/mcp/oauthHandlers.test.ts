// @vitest-environment node

import type { AuthenticatedSession } from "@/lib/server/auth/requestAuth";
import { describe, expect, it, vi } from "vitest";
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

describe("MCP OAuth web handlers", () => {
  it("signs the server-side flow fixture", async () => {
    await expect(signMcpOAuthFlow({
      flow: flow(),
      now: NOW,
      sessionSecret: SESSION_SECRET
    })).resolves.toMatch(/^ey/u);
  });

  it.each(["GET", "POST"])("starts a user flow over %s with a signed HttpOnly cookie and no token response", async (method) => {
    const operations = service();
    const handler = createMcpOAuthStartHandler(deps({ service: operations }), {
      forceReconnect: false,
      purpose: "user"
    });
    const response = await handler(
      new Request("https://aiqsa.example.test/api/me/mcp/server-1/oauth/connect", { method }),
      routeContext()
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auth.example.test/authorize?state=fixture-state"
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(await response.text()).toBe("");
    expect(operations.startAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      redirectUri: flow().redirectUri,
      serverId: SERVER_ID,
      userId: USER.userId
    }));
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
      "https://aiqsa.example.test/api/me/mcp/server-1/oauth/callback?state=fixture-state&code=secret-code",
      { headers: { cookie: cookieHeader(startResponse) } }
    ), routeContext());
    expect(operations.completeAuthorization).toHaveBeenCalledWith({
      authorizationCode: "secret-code",
      flow: flow()
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
    expect(location).toContain(`server=${SERVER_ID}`);
    expect(location).not.toContain("secret-code");
    expect(location).not.toContain("fixture-code-verifier");
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

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=connected");
    expect(settleAuthorization).toHaveBeenCalledWith({
      configurationIdentity: "revision-1",
      purpose: "user",
      serverId: SERVER_ID,
      userId: USER.userId
    });
    expect(onRuntimeChanged).toHaveBeenCalledWith(USER.userId);
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
