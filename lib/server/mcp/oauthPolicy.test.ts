import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import {
  bindMcpOAuthPolicyResource,
  buildMcpOAuthPolicy,
  mcpOAuthPolicyFingerprint
} from "./oauthPolicy";

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

  it("binds an omitted resource to same-origin discovery without requiring an admin edit", () => {
    const policy = policyFor(oauthDraft([]));
    expect(policy).toMatchObject({
      resource: "https://mcp.example.test/mcp",
      resourceMode: "auto_same_origin"
    });

    const resolved = bindMcpOAuthPolicyResource(policy, "https://mcp.example.test/");
    expect(resolved).toMatchObject({
      resource: "https://mcp.example.test/",
      resourceMode: "auto_same_origin"
    });
    expect(bindMcpOAuthPolicyResource(policy, "https://foreign.example.test/")).toBeNull();
    expect(mcpOAuthPolicyFingerprint(resolved!, "client-1"))
      .toBe(mcpOAuthPolicyFingerprint(policy, "client-1"));
  });

  it("keeps an explicit protected resource exact", () => {
    const draft = oauthDraft([]);
    if (draft.auth.mode !== "oauth") throw new Error("fixture");
    draft.auth.protectedResource = "https://mcp.example.test/mcp";
    const policy = policyFor(draft);

    expect(policy.resourceMode).toBeUndefined();
    expect(bindMcpOAuthPolicyResource(policy, "https://mcp.example.test/mcp")).toEqual(policy);
    expect(bindMcpOAuthPolicyResource(policy, "https://mcp.example.test/")).toBeNull();
  });
});
