import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../../auth/config";
import { createFixedWindowLoginRateLimiter } from "../../auth/rateLimit";
import {
  createInboundMcpAuthorizationHandlers,
  createInboundMcpRegistrationHandler,
  createInboundMcpRevocationHandler,
  createInboundMcpTokenHandler
} from "./handlers";
import { inboundMcpOAuthConfiguration } from "./service";

const config = getAuthConfig({
  AIQSA_APP_BASE_URL: "http://localhost:3000",
  AIQSA_AUTH_SESSION_SECRET: "test-secret"
});
const configuration = inboundMcpOAuthConfiguration(
  "http://localhost:3000",
  "test"
);

function service() {
  return {
    approveAuthorization: vi.fn(async () => `aiqsa_mc_${"A".repeat(43)}`),
    configuration,
    denyAuthorization: vi.fn(async () => undefined),
    listConnectedApps: vi.fn(async () => []),
    prepareAuthorization: vi.fn(async () => ({
      clientName: "Client <one>",
      clientOrigin: "https://client.example",
      consentToken: `abcdefghi.${"A".repeat(43)}`
    })),
    registerClient: vi.fn(async () => ({
      application_type: "native" as const,
      client_id: "aiqsa_dcr_client",
      client_id_issued_at: 1_788_400_800,
      client_name: "Codex CLI",
      grant_types: ["authorization_code", "refresh_token"] as const,
      redirect_uris: ["http://127.0.0.1:43119/callback"],
      response_types: ["code"] as const,
      token_endpoint_auth_method: "none" as const
    })),
    resolveAccessToken: vi.fn(async () => null),
    revokeConnectedApp: vi.fn(async () => true),
    revokeToken: vi.fn(async () => undefined),
    token: vi.fn(async () => ({
      access_token: `aiqsa_ma_${"A".repeat(43)}`,
      expires_in: 3600,
      refresh_token: `aiqsa_mr_${"B".repeat(43)}`,
      token_type: "Bearer" as const
    }))
  };
}

function authorizationUrl() {
  const url = new URL("http://localhost:3000/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: "https://client.example/oauth/client.json",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:43119/callback",
    resource: "http://localhost:3000/mcp",
    response_type: "code",
    state: "client-state"
  }).toString();
  return url;
}

function authSession() {
  return {
    expiresAt: new Date("2026-09-04T01:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function formRequest(url: string, body: URLSearchParams, origin = "http://localhost:3000") {
  return new Request(url, {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      "sec-fetch-site": origin === "http://localhost:3000" ? "same-origin" : "cross-site"
    },
    method: "POST"
  });
}

describe("inbound Memory MCP OAuth HTTP handlers", () => {
  it("renders bounded consent and redirects an approved request with state and issuer", async () => {
    const oauth = service();
    const handlers = createInboundMcpAuthorizationHandlers({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 10 }),
      resolveAuth: async () => authSession(),
      service: oauth as never
    });
    const getResponse = await handlers.GET(new Request(authorizationUrl()));
    const html = await getResponse.text();
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Client &lt;one&gt;");
    expect(html).toContain("Chat history is not available");
    expect(html).not.toContain("owner@example.test");

    const body = new URLSearchParams(authorizationUrl().searchParams);
    body.set("consent_token", `abcdefghi.${"A".repeat(43)}`);
    body.set("decision", "approve");
    const response = await handlers.POST(formRequest(
      "http://localhost:3000/oauth/authorize",
      body
    ));
    const redirect = new URL(response.headers.get("location")!);
    expect(response.status).toBe(303);
    expect(redirect.origin).toBe("http://127.0.0.1:43119");
    expect(redirect.searchParams.get("code")).toMatch(/^aiqsa_mc_/u);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe("http://localhost:3000");
    expect(oauth.approveAuthorization).toHaveBeenCalledOnce();
  });

  it("rejects a cross-site approval before issuing a code", async () => {
    const oauth = service();
    const handlers = createInboundMcpAuthorizationHandlers({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      resolveAuth: async () => authSession(),
      service: oauth as never
    });
    const body = new URLSearchParams(authorizationUrl().searchParams);
    body.set("consent_token", `abcdefghi.${"A".repeat(43)}`);
    body.set("decision", "approve");
    const response = await handlers.POST(formRequest(
      "http://localhost:3000/oauth/authorize",
      body,
      "https://attacker.example"
    ));
    expect(response.status).toBe(403);
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  it("returns an explicit client denial on cancel and a local retry page for invalid input", async () => {
    const oauth = service();
    const handlers = createInboundMcpAuthorizationHandlers({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      resolveAuth: async () => authSession(),
      service: oauth as never
    });
    const body = new URLSearchParams(authorizationUrl().searchParams);
    body.set("consent_token", `abcdefghi.${"A".repeat(43)}`);
    body.set("decision", "cancel");

    const cancelled = await handlers.POST(formRequest(
      "http://localhost:3000/oauth/authorize",
      body
    ));
    const redirect = new URL(cancelled.headers.get("location")!);
    expect(cancelled.status).toBe(303);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(oauth.denyAuthorization).toHaveBeenCalledOnce();
    expect(oauth.approveAuthorization).not.toHaveBeenCalled();

    const invalid = await handlers.GET(new Request(
      "http://localhost:3000/oauth/authorize?response_type=token"
    ));
    expect(invalid.status).toBe(400);
    await expect(invalid.text()).resolves.toContain(
      "Return to your MCP client and try connecting again."
    );
  });

  it("returns scope-free token responses with no-store headers", async () => {
    const oauth = service();
    const POST = createInboundMcpTokenHandler({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      service: oauth as never
    });
    const body = new URLSearchParams({
      client_id: "aiqsa_dcr_client",
      code: `aiqsa_mc_${"A".repeat(43)}`,
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:43119/callback",
      resource: "http://localhost:3000/mcp"
    });
    const response = await POST(formRequest("http://localhost:3000/oauth/token", body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      expires_in: 3600,
      token_type: "Bearer"
    });

    body.set("scope", "memory:write");
    const invalidScope = await POST(formRequest("http://localhost:3000/oauth/token", body));
    await expect(invalidScope.json()).resolves.toEqual({ error: "invalid_scope" });
    expect(oauth.token).toHaveBeenCalledTimes(1);
  });

  it("keeps code exchange and refresh in separate bounded rate-limit buckets", async () => {
    const oauth = service();
    const POST = createInboundMcpTokenHandler({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 1 }),
      service: oauth as never
    });
    const credential = `aiqsa_mc_${"A".repeat(43)}`;
    const codeExchange = new URLSearchParams({
      client_id: "aiqsa_dcr_client",
      code: credential,
      code_verifier: "v".repeat(43),
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:43119/callback",
      resource: "http://localhost:3000/mcp"
    });
    const refresh = new URLSearchParams({
      client_id: "aiqsa_dcr_client",
      grant_type: "refresh_token",
      refresh_token: credential,
      resource: "http://localhost:3000/mcp"
    });

    expect((await POST(formRequest(
      "http://localhost:3000/oauth/token",
      codeExchange
    ))).status).toBe(200);
    expect((await POST(formRequest(
      "http://localhost:3000/oauth/token",
      refresh
    ))).status).toBe(200);
    const limited = await POST(formRequest(
      "http://localhost:3000/oauth/token",
      refresh
    ));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");
    expect(oauth.token).toHaveBeenCalledTimes(2);
  });

  it("registers public clients without secrets and revokes unknown tokens idempotently", async () => {
    const oauth = service();
    const register = createInboundMcpRegistrationHandler({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      service: oauth as never
    });
    const registration = await register(new Request("http://localhost:3000/oauth/register", {
      body: JSON.stringify({
        application_type: "native",
        client_name: "Codex CLI",
        redirect_uris: ["http://127.0.0.1:43119/callback"]
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(registration.status).toBe(201);
    const registrationBody = await registration.json();
    expect(registrationBody).not.toHaveProperty("client_secret");

    const revoke = createInboundMcpRevocationHandler({
      getConfig: () => config,
      rateLimiter: createFixedWindowLoginRateLimiter(),
      service: oauth as never
    });
    const revocation = await revoke(formRequest(
      "http://localhost:3000/oauth/revoke",
      new URLSearchParams({
        client_id: "aiqsa_dcr_client",
        token: `aiqsa_mr_${"A".repeat(43)}`
      })
    ));
    expect(revocation.status).toBe(200);
    expect(await revocation.text()).toBe("");
    expect(oauth.revokeToken).toHaveBeenCalledOnce();
  });
});
