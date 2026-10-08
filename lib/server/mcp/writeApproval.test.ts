import { describe, expect, it } from "vitest";
import {
  boundedMcpApprovalDisplay,
  isMcpApprovalAdmission,
  isMcpApprovalRequest,
  mcpApprovalAdmission,
  mcpApprovalArgumentsDigest,
  mcpApprovalRequest,
  mcpCallNeedsApproval,
  mcpToolMayChangeData
} from "./writeApproval";

describe("MCP write approval policy", () => {
  const interactive = mcpApprovalAdmission([]);
  const consented = mcpApprovalAdmission(["server-1"]);

  it.each([
    { annotations: undefined, mayChange: true },
    { annotations: {}, mayChange: true },
    { annotations: { readOnlyHint: false }, mayChange: true },
    { annotations: { destructiveHint: true }, mayChange: true },
    { annotations: { readOnlyHint: true }, mayChange: false },
    { annotations: { destructiveHint: false, readOnlyHint: true }, mayChange: false },
    // A read-only tool marked destructive is still asked about.
    { annotations: { destructiveHint: true, readOnlyHint: true }, mayChange: true },
    // Only a boolean true counts; inventories keep annotations as declared.
    { annotations: { readOnlyHint: "true" }, mayChange: true }
  ])("treats $annotations as may change data: $mayChange", ({ annotations, mayChange }) => {
    expect(mcpToolMayChangeData(annotations)).toBe(mayChange);
  });

  it.each([
    // Scheduled-task runs and older runs carry no marker: standing authority.
    { admission: undefined, annotations: undefined, needs: false },
    { admission: interactive, annotations: undefined, needs: true },
    { admission: interactive, annotations: { destructiveHint: true }, needs: true },
    { admission: interactive, annotations: { readOnlyHint: true }, needs: false },
    { admission: interactive, annotations: { destructiveHint: true, readOnlyHint: true }, needs: true },
    { admission: consented, annotations: undefined, needs: false },
    { admission: consented, annotations: { destructiveHint: true }, needs: false }
  ])("asks for $annotations under $admission: $needs", ({ admission, annotations, needs }) => {
    expect(mcpCallNeedsApproval({ admission, annotations, serverId: "server-1" })).toBe(needs);
  });

  it("asks for another server's tools despite a consent", () => {
    expect(mcpCallNeedsApproval({ admission: consented, annotations: undefined, serverId: "server-2" })).toBe(true);
  });

  it("freezes a sorted, unique consent list and decodes only the exact marker", () => {
    const admission = mcpApprovalAdmission(["b", "a", "b"]);
    expect(admission).toEqual({ consentedServerIds: ["a", "b"], version: 1 });
    expect(isMcpApprovalAdmission(admission)).toBe(true);
    for (const value of [null, [], { version: 1 }, { consentedServerIds: [], version: 2 },
      { consentedServerIds: ["a", "a"], version: 1 }, { consentedServerIds: [""], version: 1 },
      { consentedServerIds: [], extra: true, version: 1 }]) {
      expect(isMcpApprovalAdmission(value)).toBe(false);
    }
  });

  it("digests canonical arguments, whatever their key order", () => {
    expect(mcpApprovalArgumentsDigest({ b: 1, a: { d: 2, c: 3 } })).toBe(mcpApprovalArgumentsDigest({ a: { c: 3, d: 2 }, b: 1 }));
    expect(mcpApprovalArgumentsDigest({ id: "r-1" })).not.toBe(mcpApprovalArgumentsDigest({ id: "r-2" }));
    expect(mcpApprovalArgumentsDigest(undefined)).toBe(mcpApprovalArgumentsDigest({}));
  });

  it("builds a bounded request with display names and the exact key", () => {
    const request = mcpApprovalRequest({ arguments: { id: "r-1" }, definitionHash: "d".repeat(64), originalName: "delete_record",
      serverId: "server-1", serverName: "S".repeat(400), toolName: "mcp_records_delete_record_0123456789" });
    expect(request).toEqual({ argumentsDigest: mcpApprovalArgumentsDigest({ id: "r-1" }), definitionHash: "d".repeat(64),
      serverId: "server-1", serverName: "S".repeat(160), toolName: "mcp_records_delete_record_0123456789", toolTitle: "delete_record" });
    expect(isMcpApprovalRequest(request)).toBe(true);
    expect(isMcpApprovalRequest({ ...request, definitionHash: "not-a-hash" })).toBe(false);
    expect(boundedMcpApprovalDisplay("  ", "fallback")).toBe("fallback");
  });
});
