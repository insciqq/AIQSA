import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import { buildMcpOAuthPolicy } from "./oauthPolicy";

function oauthDraft(allowedAuthorizationServerOrigins: string[]): McpDraftConfiguration {
  return {
    auth: {
      allowedAuthorizationServerOrigins,
      mode: "oauth",
      scopes: []
    },
    runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
    slots: [],
    source: { kind: "remote", url: "https://mcp.example.test/mcp" },
    transport: "streamable_http"
  };
}

function policyFor(draft: McpDraftConfiguration) {
  return buildMcpOAuthPolicy({
    configurationIdentity: "draft-hash",
    draft,
    purpose: "validation",
    redirectUri: "https://aiqsa.example.test/api/admin/mcp/server-1/oauth/validation/callback",
    serverId: "server-1",
    userId: "admin-1"
  });
}

describe("MCP OAuth policy", () => {
  it("treats an empty authorization allowlist as same-origin only", () => {
    expect(policyFor(oauthDraft([])).allowedAuthorizationServerOrigins)
      .toEqual(["https://mcp.example.test"]);
  });

  it("preserves an explicit cross-origin authorization policy", () => {
    expect(policyFor(oauthDraft(["https://login.example.test"])).allowedAuthorizationServerOrigins)
      .toEqual(["https://login.example.test"]);
  });
});
