import { describe, expect, it } from "vitest";
import {
  decodeMcpApprovalCard,
  decodeMcpApprovalDecisionResponse,
  decodeMcpToolConsents,
  foldMcpApprovalCards,
  mcpApprovalContinuationText,
  mcpApprovalContinuationTool,
  type McpApprovalCard
} from "./mcpApprovals";

const card: McpApprovalCard = { approvalId: "approval-1", canDecide: true, details: { ordinal: 0, roundIndex: 1 },
  serverName: "Records", source: "model", state: "pending", toolName: "delete_record" };

describe("MCP approval contract", () => {
  it("decodes only exact, bounded cards", () => {
    expect(decodeMcpApprovalCard(card)).toEqual(card);
    for (const value of [{ ...card, approvalId: "a/b" }, { ...card, state: "approved" }, { ...card, source: "hub" },
      { ...card, canDecide: false }, { ...card, serverName: "x".repeat(161) }, { ...card, extra: 1 },
      { ...card, details: { ordinal: 0, roundIndex: 0 } }, { ...card, source: "code" },
      // Only an Allow continues.
      { ...card, canContinue: true }, { ...card, canContinue: false, state: "allowed_once" },
      { ...card, canContinue: true, state: "denied" }]) {
      expect(decodeMcpApprovalCard(value), JSON.stringify(value)).toBeNull();
    }
    for (const state of ["allowed_once", "allowed_server"] as const) {
      const allowed = { approvalId: "approval-1", canContinue: true as const, serverName: "Records", source: "agent" as const,
        state, toolName: "create_event" };
      expect(decodeMcpApprovalCard(allowed)).toEqual(allowed);
    }
  });

  it("folds one card per approval, the later state winning", () => {
    expect(foldMcpApprovalCards([card, { ...card, canDecide: undefined, state: "denied" }, { bad: true }]))
      .toEqual([{ ...card, canDecide: undefined, state: "denied" }].map(({ canDecide: _canDecide, ...rest }) => rest));
    expect(decodeMcpApprovalDecisionResponse({ approval: card })).toEqual(card);
    expect(decodeMcpApprovalDecisionResponse({ approval: card, error: "x" })).toBeNull();
  });

  it("writes and reads the continuation turn's fixed text", () => {
    const text = mcpApprovalContinuationText({ serverName: "Records", toolName: "delete_record" });
    expect(text).toBe("The user approved `delete_record` on `Records`. Continue the task.");
    expect(mcpApprovalContinuationTool(text)).toBe("delete_record");
    expect(mcpApprovalContinuationTool("The user approved everything. Continue the task.")).toBeNull();
  });

  it("decodes the Always allowed list", () => {
    expect(decodeMcpToolConsents({ consents: [{ createdAt: "2026-10-08T00:00:00.000Z", serverId: "server-1", serverName: "Records" }] }))
      .toEqual([{ createdAt: "2026-10-08T00:00:00.000Z", serverId: "server-1", serverName: "Records" }]);
    expect(decodeMcpToolConsents({ consents: [{ createdAt: "never", serverId: "server-1", serverName: "Records" }] })).toBeNull();
    expect(decodeMcpToolConsents({ servers: [] })).toBeNull();
  });

});
