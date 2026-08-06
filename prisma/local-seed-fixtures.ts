import type { McpDraftConfiguration } from "../lib/contracts/mcp";

export const LOCAL_MCP_MEMBER = Object.freeze({
  displayName: "MCP Member",
  email: "mcp-member@aiqsa.local",
  id: "00000000-0000-4000-8000-000000000002",
  password: "AIQSA-mcp-member-2026!"
});

export const LOCAL_RESTRICTED_MEMBER = Object.freeze({
  displayName: "Restricted Member",
  email: "restricted-member@aiqsa.local",
  id: "00000000-0000-4000-8000-000000000003",
  password: "AIQSA-restricted-member-2026!"
});

export const LOCAL_ORDINARY_USERS = Object.freeze([
  LOCAL_MCP_MEMBER,
  LOCAL_RESTRICTED_MEMBER
]);

export const LOCAL_MCP_FIXTURE_GROUP = Object.freeze({
  id: "00000000-0000-4000-8000-000000000011",
  name: "dev-mcp-members"
});

export const LOCAL_SHARED_MCP_FIXTURE = Object.freeze({
  description: "Development fixture granted to both ordinary users through their group.",
  displayName: "Fixture Shared MCP",
  id: "00000000-0000-4000-8000-000000000501",
  namespace: "dev_fixture_shared",
  revisionId: "00000000-0000-4000-8000-000000000511",
  toolName: "fixture_shared_tool"
});

export const LOCAL_PRIVATE_MCP_FIXTURE = Object.freeze({
  description: "Development fixture granted only to the MCP Member account.",
  displayName: "Fixture Private MCP",
  id: "00000000-0000-4000-8000-000000000502",
  namespace: "dev_fixture_private",
  revisionId: "00000000-0000-4000-8000-000000000512",
  toolName: "fixture_private_tool"
});

export const LOCAL_SHARED_MCP_DRAFT: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
  slots: [
    {
      description: "Only a direct user grant may expose and change this development fixture field.",
      label: "Fixture workspace",
      maxLength: 64,
      minLength: 1,
      policy: { kind: "personal", required: true },
      sensitive: false,
      slotKey: "workspace",
      target: { kind: "header", name: "X-AIQSA-Workspace" },
      valueType: "string"
    }
  ],
  source: { kind: "remote", url: "https://shared.mcp-fixture.invalid/mcp" },
  transport: "streamable_http"
};

export const LOCAL_PRIVATE_MCP_DRAFT: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
  slots: [],
  source: { kind: "remote", url: "https://private.mcp-fixture.invalid/mcp" },
  transport: "streamable_http"
};

export const LOCAL_MCP_FIXTURE_TESTED_AT = "2026-07-23T00:00:00.000Z";
