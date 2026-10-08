import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MCP_APPROVAL_TTL_MS } from "./writeApproval";
import { loadMcpApprovalContinuation, projectMcpApprovalCards, type McpApprovalCardRow } from "./writeApprovalRepository";

const now = new Date("2026-10-08T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function row(overrides: Partial<McpApprovalCardRow> = {}): McpApprovalCardRow {
  return { consumedAt: null, decidedAt: minutesAgo(1), decision: "allow_once", id: "approval-1",
    modelRun: { assistantMessage: { children: [] } }, serverName: "Records", source: "model",
    toolCall: { ordinal: 0, roundIndex: 1 }, toolTitle: "delete_record", ...overrides };
}

describe("MCP approval card projection", () => {
  it("lets the initiator continue an Allow exactly while the send handler accepts it", () => {
    const continues = (overrides: Partial<McpApprovalCardRow>, initiator = true) =>
      projectMcpApprovalCards([row(overrides)], { initiator, now })[0]!.canContinue === true;
    expect(continues({})).toBe(true);
    expect(continues({ decision: "allow_server" })).toBe(true);
    // Used by a run, past the approval window, or already continued.
    expect(continues({ consumedAt: minutesAgo(0) })).toBe(false);
    expect(continues({ decidedAt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) })).toBe(false);
    expect(continues({ decision: "allow_server", decidedAt: minutesAgo(16) })).toBe(false);
    expect(continues({ modelRun: { assistantMessage: { children: [{ id: "continuation-turn" }] } } })).toBe(false);
    // Deny and pending never continue; others and branch copies see the card read-only.
    expect(continues({ decision: "deny" })).toBe(false);
    expect(continues({ decidedAt: null, decision: null })).toBe(false);
    expect(continues({}, false)).toBe(false);
    expect(continues({ modelRun: { assistantMessage: null } })).toBe(true);
  });

  it("keeps the decision and detail rules of the card", () => {
    expect(projectMcpApprovalCards([row({ decidedAt: null, decision: null })], { initiator: true, now })).toEqual([{
      approvalId: "approval-1", canDecide: true, details: { ordinal: 0, roundIndex: 1 }, serverName: "Records", source: "model",
      state: "pending", toolName: "delete_record" }]);
    expect(projectMcpApprovalCards([row({ decision: "deny" })], { initiator: false, now })).toEqual([{
      approvalId: "approval-1", serverName: "Records", source: "model", state: "denied", toolName: "delete_record" }]);
  });

  it("accepts a continuation only for an unused Allow of the user's chat within the window", async () => {
    const findFirst = vi.fn(async () => ({ serverName: "Records", toolTitle: "delete_record" }));
    const client = { mcpToolApproval: { findFirst } } as unknown as Pick<PrismaClient, "mcpToolApproval">;
    expect(await loadMcpApprovalContinuation(client, { approvalId: "approval-1", chatId: "chat-1", userId: "user-1" }, now))
      .toEqual({ serverName: "Records", toolName: "delete_record" });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: "chat-1", consumedAt: null,
      decidedAt: { gt: new Date(now.getTime() - MCP_APPROVAL_TTL_MS) }, decision: { in: ["allow_once", "allow_server"] },
      id: "approval-1", userId: "user-1" } }));
  });
});
