import { describe, expect, it } from "vitest";
import type { AdminMcpServer, McpRevisionSummary } from "@/lib/contracts/mcp";
import {
  mcpAccessSummary,
  mcpAuthorizationState,
  mcpConfigurationBuild,
  mcpHasUnappliedCheck,
  mcpHeaderStatus,
  mcpServerStatus,
  mcpToolsSummary,
  readAdminMcpOAuthReturn,
  withoutAdminMcpOAuthReturn
} from "./mcpServerView";

const NOW = new Date("2026-09-07T12:51:00.000Z");
const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b|\bCAS\b|tuple/iu;

function configuration(overrides: Partial<McpRevisionSummary> = {}): McpRevisionSummary {
  return {
    artifactStatus: "not_applicable",
    createdAt: "2026-09-07T10:00:00.000Z",
    draftHash: "hash-1",
    id: "configuration-1",
    identityHash: "identity-1",
    resolvedArtifact: null,
    revisionNumber: 1,
    validationEvidence: {
      evidence: {},
      testedAt: "2026-09-07T10:00:00.000Z",
      toolInventory: [
        { description: "Remember", name: "remember" },
        { description: "Forget", name: "forget" }
      ]
    },
    ...overrides
  };
}

function server(overrides: Partial<AdminMcpServer> = {}): AdminMcpServer {
  const active = configuration();
  return {
    activePersonalSlots: [],
    activeRevision: active,
    activation: null,
    archivedAt: null,
    description: "Team memory",
    draft: {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [],
      source: { kind: "remote", url: "https://mcp.example/mcp" },
      transport: "streamable_http"
    },
    draftTest: {
      draftHash: "hash-1",
      evidence: {},
      identityHash: "identity-1",
      resolvedArtifact: null,
      testedAt: "2026-09-07T10:00:00.000Z",
      toolInventory: active.validationEvidence.toolInventory
    },
    draftTested: true,
    enabled: true,
    grants: [],
    id: "server-1",
    name: "Memory",
    namespace: "memory",
    revisions: [active],
    sharedValues: {},
    updatedAt: "2026-09-07T10:00:00.000Z",
    validationOAuth: null,
    ...overrides
  };
}

describe("mcpServerStatus", () => {
  it("keeps administrator OAuth connected while showing the independent runtime failure", () => {
    const broken = server({
      runtimeProblem: "unavailable", runtimeErrorCode: "mcp_health_check_failed",
      draft: { ...server().draft, auth: { allowedAuthorizationServerOrigins: [], mode: "oauth", scopes: [] } },
      validationOAuth: { accountLabel: "Synthetic operator", connectedAt: "2026-09-07T10:00:00.000Z", state: "ready" }
    });
    expect(mcpAuthorizationState(broken)).toMatchObject({ label: "Connected" });
    expect(mcpServerStatus(broken, NOW)).toMatchObject({ kind: "runtime_unavailable", detail: expect.stringContaining("health check failed") });
    expect(mcpServerStatus({ ...broken, runtimeProblem: null, runtimeErrorCode: null }, NOW).kind).toBe("working");
  });
  it("reads Working with the tools and the check time from the configuration in use", () => {
    const status = mcpServerStatus(server(), NOW);
    expect(status).toMatchObject({ kind: "working", label: "Working", tone: "ok" });
    expect(mcpHeaderStatus(server(), NOW)).toMatch(/^Working · 2 tools on · checked today \d{2}:\d{2}$/u);
  });

  it("prefers the setup in progress, then a failed setup, over everything else", () => {
    const activation = {
      completedAt: null,
      errorCode: null,
      id: "attempt",
      issues: [],
      requestedAt: "2026-09-07T12:00:00.000Z",
      stage: "connecting" as const,
      startedAt: "2026-09-07T12:00:00.000Z",
      updatedAt: "2026-09-07T12:00:00.000Z"
    };
    expect(mcpServerStatus(server({ activation, enabled: false }), NOW)).toMatchObject({
      detail: "Updating · Connecting (step 2 of 4)",
      kind: "applying",
      label: "Applying"
    });
    expect(mcpServerStatus(server({ activation: { ...activation, stage: "failed" } }), NOW)).toMatchObject({
      kind: "check_failed",
      label: "Check failed",
      tone: "critical"
    });
  });

  it("asks for setup while an OAuth server has no administrator authorization", () => {
    const oauth = server({
      activeRevision: null,
      draft: { ...server().draft, auth: { allowedAuthorizationServerOrigins: [], mode: "oauth", scopes: [] } },
      draftTest: null,
      draftTested: false,
      revisions: []
    });
    expect(mcpServerStatus(oauth, NOW)).toMatchObject({
      detail: "Authorization required to check changes",
      kind: "setup_needed",
      label: "Setup needed",
      tone: "warn"
    });
    expect(mcpAuthorizationState(oauth).label).toBe("Not connected");
    expect(mcpAuthorizationState({
      ...oauth,
      validationOAuth: { accountLabel: "ops@example.com", connectedAt: "2026-09-07T10:00:00.000Z", state: "ready" }
    })).toMatchObject({ detail: "Checking as ops@example.com", label: "Connected", tone: "ok" });
  });

  it("orders Disabled after setup, and unapplied changes and updates before Working", () => {
    expect(mcpServerStatus(server({ activeRevision: null, draftTest: null, draftTested: false, revisions: [] }), NOW))
      .toMatchObject({ kind: "setup_needed", label: "Setup needed" });
    expect(mcpServerStatus(server({ enabled: false }), NOW)).toMatchObject({ kind: "disabled", label: "Disabled", tone: "neutral" });
    expect(mcpServerStatus(server({ draftTested: false }), NOW)).toMatchObject({ kind: "not_applied", label: "Changes not applied" });
    const updated = server({ draftTest: { ...server().draftTest!, identityHash: "identity-2" } });
    expect(mcpHasUnappliedCheck(updated)).toBe(true);
    expect(mcpServerStatus(updated, NOW)).toMatchObject({ kind: "update_ready", label: "Update ready" });
    expect(mcpServerStatus(server({ runtimeProblem: "unavailable" }), NOW)).toMatchObject({ kind: "runtime_unavailable", tone: "critical" });
    expect(mcpServerStatus(server({ runtimeProblem: "reauthorization_required" }), NOW)).toMatchObject({ kind: "needs_attention", tone: "warn" });
    expect(mcpServerStatus(server({ archivedAt: "2026-09-07T11:00:00.000Z" }), NOW)).toMatchObject({ kind: "archived", label: "Archived" });
  });

  it("uses only the shared vocabulary", () => {
    const variants = [
      server(),
      server({ enabled: false }),
      server({ draftTested: false }),
      server({ activeRevision: null, draftTest: null, draftTested: false, revisions: [] }),
      server({ runtimeProblem: "unavailable" })
    ];
    for (const variant of variants) {
      expect(mcpHeaderStatus(variant, NOW)).not.toMatch(bannedWords);
    }
    expect(mcpConfigurationBuild(configuration({ artifactStatus: "missing" }))).toEqual({ label: "Needs rebuild", tone: "critical" });
    expect(mcpConfigurationBuild(configuration({ artifactStatus: "available" }))).toEqual({ label: "Ready to restore", tone: "ok" });
  });
});

describe("list summaries", () => {
  it("counts tools on and direct access", () => {
    expect(mcpToolsSummary(server())).toBe("2 tools on");
    expect(mcpToolsSummary(server({ activeRevision: configuration({ disabledToolNames: ["forget"] }) }))).toBe("1 of 2 tools on");
    expect(mcpToolsSummary(server({ activeRevision: null, draftTest: null }))).toBe("Not checked");
    expect(mcpAccessSummary(server())).toBe("No access yet");
    expect(mcpAccessSummary(server({
      grants: [
        { canUse: true, groupId: "g1", groupName: "ops", id: "1", personalSlotKeys: [], userId: null, userName: null },
        { canUse: true, groupId: "g2", groupName: "dev", id: "2", personalSlotKeys: [], userId: null, userName: null },
        { canUse: true, groupId: null, groupName: null, id: "3", personalSlotKeys: [], userId: "u1", userName: "Alice" },
        { canUse: false, groupId: null, groupName: null, id: "4", personalSlotKeys: ["key"], userId: "u2", userName: "Bob" }
      ]
    }))).toBe("2 groups · 1 user");
  });
});

describe("OAuth return", () => {
  it("reads the callback parameters only on the MCP section and removes just those", () => {
    expect(readAdminMcpOAuthReturn("http://localhost/admin?section=mcp&oauth=connected&server=s1&keep=yes"))
      .toEqual({ outcome: "connected", serverId: "s1" });
    expect(readAdminMcpOAuthReturn("http://localhost/admin?section=mcp&oauth=bogus&server=s1"))
      .toEqual({ outcome: null, serverId: "s1" });
    expect(readAdminMcpOAuthReturn("http://localhost/admin?section=users&oauth=connected&server=s1")).toBeNull();
    expect(readAdminMcpOAuthReturn("http://localhost/admin?section=mcp")).toBeNull();
    expect(withoutAdminMcpOAuthReturn("http://localhost/admin?section=mcp&oauth=connected&server=s1&keep=yes#current"))
      .toBe("/admin?section=mcp&keep=yes#current");
  });
});
