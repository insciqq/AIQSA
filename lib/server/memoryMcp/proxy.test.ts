import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxyWithEnv } from "../../../proxy";

describe("Personal Memory MCP proxy boundary", () => {
  it("passes /mcp to bearer authentication without a browser session", () => {
    const response = proxyWithEnv(
      new NextRequest("https://aiqsa.example/mcp", { method: "POST" }),
      { AIQSA_APP_BASE_URL: "https://aiqsa.example" }
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not accidentally expose similarly prefixed routes", () => {
    const response = proxyWithEnv(
      new NextRequest("https://aiqsa.example/mcp-private"),
      { AIQSA_APP_BASE_URL: "https://aiqsa.example" }
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("sends a logged-out authorization request through normal login without losing it", () => {
    const authorizationUrl = new URL("https://aiqsa.example/oauth/authorize");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", "codex-client");
    authorizationUrl.searchParams.set("redirect_uri", "http://127.0.0.1:43119/callback");
    authorizationUrl.searchParams.set("state", "opaque-client-state");
    authorizationUrl.searchParams.set("code_challenge", "challenge");
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", "https://aiqsa.example/mcp");

    const response = proxyWithEnv(
      new NextRequest(authorizationUrl),
      { AIQSA_APP_BASE_URL: "https://aiqsa.example" }
    );
    const loginUrl = new URL(response.headers.get("location")!);

    expect(response.status).toBe(307);
    expect(loginUrl.pathname).toBe("/login");
    expect(loginUrl.searchParams.get("next")).toBe(
      `${authorizationUrl.pathname}${authorizationUrl.search}`
    );
  });
});
