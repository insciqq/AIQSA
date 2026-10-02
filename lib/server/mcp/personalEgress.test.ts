import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy, proxyWithEnv } from "../../../proxy";
import { SESSION_COOKIE_NAME } from "../auth/constants";
import { PERSONAL_MCP_EGRESS_HEADER, PERSONAL_MCP_EGRESS_VALUE } from "./personalEgress";
import { mcpDestinationSafeFetchOptions } from "./personalNetworkPolicy";
import { createMcpSafeFetch, McpSafeFetchError, type McpPinnedHttpRequest } from "./safeFetch";

const ENV = { AIQSA_APP_BASE_URL: "https://aiqsa.example" };

function marked(pathname: string, init: Readonly<{ method?: string; value?: string }> = {}) {
  return new NextRequest(`https://aiqsa.example${pathname}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session`, [PERSONAL_MCP_EGRESS_HEADER]: init.value ?? PERSONAL_MCP_EGRESS_VALUE },
    method: init.method ?? "GET"
  });
}

describe("AIQSA refuses its own personal MCP egress", () => {
  it.each([
    ["/", "GET"],
    ["/mcp", "POST"],
    ["/api/health/ready", "GET"],
    ["/api/me/mcp-connections", "POST"],
    ["/api/admin/mcp/policy", "PATCH"],
    ["/.well-known/oauth-authorization-server", "GET"]
  ])("refuses %s (%s) before routing, without a body", async (pathname, method) => {
    const response = proxyWithEnv(marked(pathname, { method }), ENV);
    expect(response.status).toBe(421);
    expect(response.headers.get(PERSONAL_MCP_EGRESS_HEADER)).toBe(PERSONAL_MCP_EGRESS_VALUE);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("");
  });

  it("refuses whatever value the marker carries", () => {
    expect(proxyWithEnv(marked("/mcp", { method: "POST", value: "spoofed" }), ENV).status).toBe(421);
  });

  it("refuses before the public artifact rate limit", async () => {
    await expect(proxy(marked("/a/opaque-token"))).resolves.toMatchObject({ status: 421 });
  });

  it("leaves unmarked requests to ordinary routing", () => {
    const response = proxyWithEnv(new NextRequest("https://aiqsa.example/api/health/ready"), ENV);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("closes the loop: a personal request that reaches the app ends with the internal reason", async () => {
    const reached: McpPinnedHttpRequest[] = [];
    // The address policy allows this host (its LAN address is unknown to the
    // container); the pinned request is served by the app's own entry.
    const personalFetch = createMcpSafeFetch({
      ...mcpDestinationSafeFetchOptions({ allowInsecureHttp: true, allowPrivateNetwork: false, personal: true }, async () => null),
      dispatch: async (request) => {
        reached.push(request);
        return proxyWithEnv(new NextRequest(request.url, { headers: request.headers, method: request.method }), ENV);
      },
      lookupHostname: async () => [{ address: "192.168.1.10", family: 4 }]
    });

    const outcome = await personalFetch("http://aiqsa-host.lan:3000/mcp", {
      body: "{}",
      // A static credential header cannot replace or drop the marker.
      headers: { "content-type": "application/json", [PERSONAL_MCP_EGRESS_HEADER]: "" },
      method: "POST"
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(McpSafeFetchError);
    expect(outcome).toMatchObject({ code: "mcp_internal_address_forbidden" });
    expect(reached).toHaveLength(1);
    expect(reached[0]!.headers.get(PERSONAL_MCP_EGRESS_HEADER)).toBe(PERSONAL_MCP_EGRESS_VALUE);
  });
});
