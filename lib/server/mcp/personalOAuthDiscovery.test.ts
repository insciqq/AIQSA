import { describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { preparePersonalMcpOAuthDraft } from "./personalOAuthDiscovery";

const draft: McpDraftConfiguration = {
  auth: { mode: "oauth", allowedAuthorizationServerOrigins: ["http://mcp.example.test"], scopes: [] },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "http://mcp.example.test/mcp" },
  transport: "streamable_http"
};

describe("personal MCP OAuth discovery", () => {
  it("pins advertised authorization and token origins before storing the OAuth policy", async () => {
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({ resource: "http://mcp.example.test/mcp", authorization_servers: ["https://auth.example.test"] });
      }
      return Response.json({
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://tokens.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
        response_types_supported: ["code"]
      });
    });
    expect((await preparePersonalMcpOAuthDraft(draft, { fetch })).auth).toMatchObject({
      allowedAuthorizationServerOrigins: ["https://auth.example.test", "https://tokens.example.test"]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized metadata before parsing it", async () => {
    const fetch = vi.fn(async () => new Response(" ".repeat(512 * 1_024 + 1), { headers: { "content-type": "application/json" } }));
    await expect(preparePersonalMcpOAuthDraft(draft, { fetch })).rejects.toThrow();
  });
});
