import { describe, expect, it } from "vitest";
import {
  adminMcpAttention,
  decodeMcpRunSelection,
  isMcpInventoryDifferenceReason,
  isMcpToolExclusionReason,
  isMcpToolName,
  isMcpUnavailableToolReason,
  mcpValidationIssue,
  type AdminMcpServer,
  type McpRevisionSummary
} from "./mcp";

describe("MCP administrator failure projection", () => {
  it("keeps bounded status and stage while excluding URL credentials and arbitrary fields", () => {
    expect(mcpValidationIssue({ code: "mcp_initialize_failed", path: "source", operation: "initialize", httpStatus: 404,
      endpoint: "https://name:password@mcp.example.test/wrong?token=private#secret", body: "private", stack: "private"
    })).toEqual({ code: "mcp_initialize_failed", path: "source", operation: "initialize", httpStatus: 404, endpoint: "https://mcp.example.test/wrong" });
    expect(mcpValidationIssue({ code: "raw upstream response", path: "private/url", operation: "private", httpStatus: 12345, endpoint: "javascript:private" }))
      .toEqual({ code: "mcp_remote_validation_failed", path: "validator" });
  });
});

describe("MCP run selection", () => {
  it("accepts only strict Auto, Load all, and Off shapes", () => {
    expect(decodeMcpRunSelection({ mode: "auto" })).toEqual({ mode: "auto" });
    expect(decodeMcpRunSelection({ mode: "load_all" })).toEqual({ mode: "load_all" });
    expect(decodeMcpRunSelection({ mode: "off" })).toEqual({ mode: "off" });

    expect(decodeMcpRunSelection({ extra: true, mode: "auto" })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "load_all", serverIds: ["server-a"] })).toBeNull();
    expect(decodeMcpRunSelection({ mode: "selected", serverIds: ["server-a"] })).toBeNull();
  });
});

describe("MCP held-back tool contracts", () => {
  it("accepts only upstream tool names and the stable reason codes", () => {
    for (const name of ["echo", "__proto__", "a.b-c_1", "x".repeat(128)]) expect(isMcpToolName(name)).toBe(true);
    for (const name of ["", "has space", "x".repeat(129), 7, null]) expect(isMcpToolName(name)).toBe(false);
    expect(["definition_drift", "disabled_by_policy", "missing_upstream", "unpublished_addition"]
      .every(isMcpToolExclusionReason)).toBe(true);
    expect(isMcpToolExclusionReason("restricted")).toBe(false);
    expect(isMcpUnavailableToolReason("restricted")).toBe(true);
    expect(isMcpUnavailableToolReason("toString")).toBe(false);
    expect(isMcpInventoryDifferenceReason("disabled_by_policy")).toBe(false);
    expect(isMcpInventoryDifferenceReason("definition_drift")).toBe(true);
  });

  it("orders tool attention after authorization, failed checks and runtime repair", () => {
    const revision = (toolVerification?: McpRevisionSummary["toolVerification"]): McpRevisionSummary => ({
      artifactStatus: "not_applicable", createdAt: "2026-09-27T00:00:00.000Z", draftHash: "hash", id: "revision-1",
      identityHash: "identity", resolvedArtifact: null, revisionNumber: 1,
      ...(toolVerification ? { toolVerification } : {}),
      validationEvidence: { evidence: {}, testedAt: "2026-09-27T00:00:00.000Z", toolInventory: [] }
    });
    const server = (overrides: Partial<AdminMcpServer>): AdminMcpServer => ({
      activation: null, activePersonalSlots: [], activeRevision: revision("definitions"), archivedAt: null, description: "",
      draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 }, slots: [],
        source: { kind: "remote", url: "https://mcp.example/mcp" }, transport: "streamable_http" },
      draftTest: null, draftTested: true, enabled: true, grants: [], id: "server-1", name: "Tools", namespace: "tools",
      revisions: [], sharedValues: {}, updatedAt: "2026-09-27T00:00:00.000Z", validationOAuth: null, ...overrides
    });
    const changed = [{ connections: 1, name: "delete_repo", reason: "unpublished_addition" as const }];

    expect(adminMcpAttention(server({}))).toBeNull();
    expect(adminMcpAttention(server({ activeRevision: revision() }))).toBeNull();
    expect(adminMcpAttention(server({ inventoryDifferences: changed }))).toEqual({
      action: "Review tools", href: null, label: "Server tools changed since the last check", task: "validation"
    });
    expect(adminMcpAttention(server({ activeRevision: revision("names") }))).toMatchObject({
      label: "Check again to guard against tool changes", task: "validation"
    });
    expect(adminMcpAttention(server({ activeRevision: revision("names"), inventoryDifferences: changed })))
      .toMatchObject({ label: "Server tools changed since the last check" });
    expect(adminMcpAttention(server({ activeRevision: revision("invalid"), inventoryDifferences: changed })))
      .toMatchObject({ label: "Check again to restore this server's tools" });
    expect(adminMcpAttention(server({ enabled: false, activeRevision: revision("invalid"), inventoryDifferences: changed })))
      .toBeNull();
    expect(adminMcpAttention(server({ inventoryDifferences: changed, runtimeProblem: "unavailable" })))
      .toMatchObject({ task: "runtime" });
    expect(adminMcpAttention(server({ archivedAt: "2026-09-27T00:00:00.000Z", inventoryDifferences: changed }))).toBeNull();
  });
});
