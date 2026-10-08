import { describe, expect, it } from "vitest";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { MCP_APPROVAL_REQUIRED, MCP_APPROVAL_REQUIRED_MESSAGE, mcpApprovalAdmission } from "../mcp/writeApproval";
import { mcpApprovalGated, mcpApprovalRequestForCall, mcpApprovalRequiredToolCallResult } from "./mcpApprovalGate";
import { toolSynthesisDecision, toolSynthesisInstruction } from "./providerToolLoop";
import { repeatBlockedToolCallResult, roundAwaitsApproval, ToolCallRepeatHistory } from "./toolCallRepeatGuard";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";

const snapshot: McpRunPlanSnapshot = {
  servers: [{ fingerprint: "f".repeat(64), revisionId: "revision-1", serverId: "server-1", serverName: "Records" }],
  tools: [
    { annotations: { readOnlyHint: true }, definitionHash: "a".repeat(64), description: null, inputSchema: { type: "object" },
      name: "read_record", namespacedName: "mcp_records_read", originalName: "read_record", serverId: "server-1", serverName: "Records" },
    { annotations: { destructiveHint: true, title: "Delete a record" }, definitionHash: "b".repeat(64), description: null,
      inputSchema: { type: "object" }, name: "delete_record", namespacedName: "mcp_records_delete", originalName: "delete_record",
      serverId: "server-1", serverName: "Records" }
  ],
  version: 1
};

function row(providerCallId: string, result: unknown, overrides: Partial<PersistedToolLoopCall> = {}): PersistedToolLoopCall {
  return { arguments: {}, completedAt: "2026-10-08T00:00:00.000Z", id: `row-${providerCallId}`, mcpBinding: null, ordinal: 0,
    providerCallId, result: result as PersistedToolLoopCall["result"], roundIndex: 1, startedAt: null, state: "error",
    toolName: "mcp_records_delete", ...overrides };
}

describe("tool-loop MCP approval gate", () => {
  const admission = mcpApprovalAdmission([]);

  it("gates only a call of a tool that may change data under the run's frozen marker", () => {
    const call = { arguments: { id: "r-1" }, name: "mcp_records_delete" };
    expect(mcpApprovalRequestForCall({ admission, call, snapshot })).toMatchObject({ definitionHash: "b".repeat(64),
      serverId: "server-1", serverName: "Records", toolName: "mcp_records_delete", toolTitle: "Delete a record" });
    expect(mcpApprovalRequestForCall({ admission, call: { arguments: {}, name: "mcp_records_read" }, snapshot })).toBeUndefined();
    expect(mcpApprovalRequestForCall({ admission: undefined, call, snapshot })).toBeUndefined();
    expect(mcpApprovalRequestForCall({ admission: mcpApprovalAdmission(["server-1"]), call, snapshot })).toBeUndefined();
    // Not an MCP route of the run: built-in tools keep their own patterns.
    expect(mcpApprovalRequestForCall({ admission, call: { arguments: {}, name: "fetch_url" }, snapshot })).toBeUndefined();
  });

  it("recognizes only the server's own gated form", () => {
    const gated = mcpApprovalRequiredToolCallResult({ providerCallId: "call-1", toolName: "mcp_records_delete" });
    expect(gated).toEqual({ callId: "call-1", name: "mcp_records_delete", status: "error",
      content: [{ type: "json", value: { error: MCP_APPROVAL_REQUIRED, message: MCP_APPROVAL_REQUIRED_MESSAGE } }] });
    expect(mcpApprovalGated(row("call-1", gated))).toBe(true);
    // A started call, another call's result, or tool content naming the code is no gate.
    expect(mcpApprovalGated(row("call-1", gated, { startedAt: "2026-10-08T00:00:00.000Z" }))).toBe(false);
    expect(mcpApprovalGated(row("call-2", gated))).toBe(false);
    expect(mcpApprovalGated(row("call-1", gated, { state: "complete" }))).toBe(false);
    expect(mcpApprovalGated(row("call-1", { ...gated as object, status: "complete" }))).toBe(false);
    expect(mcpApprovalGated(row("call-1", { callId: "call-1", name: "mcp_records_delete", status: "error",
      content: [{ type: "text", text: MCP_APPROVAL_REQUIRED }] }))).toBe(false);
  });

  it("ends a round of only gated calls and blocked repeats in synthesis that names the approval", () => {
    const gated = row("call-1", mcpApprovalRequiredToolCallResult({ providerCallId: "call-1", toolName: "mcp_records_delete" }));
    const blocked = row("call-2", repeatBlockedToolCallResult({ providerCallId: "call-2", repeatOf: [1, 2], toolName: "mcp_records_read" }),
      { roundIndex: 3, toolName: "mcp_records_read" });
    const ran = row("call-3", null, { state: "complete", startedAt: "2026-10-08T00:00:00.000Z" });
    expect(roundAwaitsApproval([gated])).toBe(true);
    expect(roundAwaitsApproval([gated, { ...blocked, roundIndex: 3 }].map(entry => ({ ...entry, roundIndex: 3 })))).toBe(true);
    expect(roundAwaitsApproval([blocked])).toBe(false);
    expect(roundAwaitsApproval([gated, ran])).toBe(false);
    expect(roundAwaitsApproval([])).toBe(false);
    const decision = toolSynthesisDecision({ approvalRequired: true, budgets: { maxToolCalls: 10, maxToolRounds: 10 },
      continuation: {}, initialToolChoice: "auto", noProgress: false, progress: { toolCalls: 1, toolRounds: 1 } });
    expect(decision).toEqual({ budget: null, reason: "approval_required" });
    expect(toolSynthesisInstruction("approval_required")).toBe(
      "Tool use is now disabled for this run: a tool call waits for the user's approval in the chat. Some planned tool calls were not executed. Answer now using only the results already obtained, and state explicitly which parts were not verified or not completed.");
    // A refused batch over the budget still wins; a tool-free run is never synthesis.
    expect(toolSynthesisDecision({ approvalRequired: true, budgets: { maxToolCalls: 10, maxToolRounds: 10 },
      continuation: { finalSynthesis: "budget_exhausted" }, initialToolChoice: "auto", noProgress: false,
      progress: { toolCalls: 1, toolRounds: 1 } })?.reason).toBe("budget_exhausted");
    expect(toolSynthesisDecision({ approvalRequired: true, budgets: { maxToolCalls: 10, maxToolRounds: 10 },
      continuation: {}, initialToolChoice: "none", noProgress: false, progress: { toolCalls: 1, toolRounds: 1 } })).toBeNull();
  });

  it("never lets a gated call count as one that may have changed what a repeated read returns", () => {
    const read = (round: number) => ({ arguments: { id: "r-1" }, completedAt: null, id: `read-${round}`, ordinal: 0,
      providerCallId: `read-${round}`, result: { callId: `read-${round}`, name: "mcp_records_read", status: "complete",
        content: [{ type: "text", text: "open" }] }, roundIndex: round, startedAt: "2026-10-08T00:00:00.000Z",
      state: "complete" as const, toolName: "mcp_records_read" });
    const gated = { arguments: { id: "r-1" }, id: "gated-2", ordinal: 1, providerCallId: "write-2", roundIndex: 2, startedAt: null,
      result: mcpApprovalRequiredToolCallResult({ providerCallId: "write-2", toolName: "mcp_records_delete" }),
      state: "error" as const, toolName: "mcp_records_delete" };
    const history = new ToolCallRepeatHistory([read(1), read(2), gated]);
    const readOnly = (toolName: string) => toolName === "mcp_records_read";
    expect(history.blockFor({ arguments: { id: "r-1" }, toolName: "mcp_records_read" }, 3, { batch: [], readOnly })).toEqual([1, 2]);
  });
});
