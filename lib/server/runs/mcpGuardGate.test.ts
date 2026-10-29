import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { guardedMcpApprovalRequestForCall } from "./mcpApprovalGate";
import { mcpApprovalAdmission, mcpApprovalRequest } from "../mcp/writeApproval";
import { createToolCallStore } from "../engine/toolCallStore";
import { projectMcpApprovalCards, type McpApprovalCardRow } from "../mcp/writeApprovalRepository";
import { NATIVE_MCP_SNAPSHOT } from "@/tests/support/nativeRunExecution";

const guard = { plan: { available: false, version: 1, code: "mcp_guard_model_unavailable" }, userMessages: ["Create an issue"] } as const;
const scope = { chatId: "chat", runId: "run", userId: "user" };
const request = mcpApprovalRequest({ arguments: {}, definitionHash: "a".repeat(64), originalName: "create",
  toolName: "mcp_create", serverId: "server", serverName: "Issues" });

describe("native MCP guard gate", () => {
  it("checks every write including standing consent but leaves scheduled and read-only calls alone", async () => {
    const tool = NATIVE_MCP_SNAPSHOT.tools.find(tool => tool.annotations?.readOnlyHint !== true)!;
    const check = vi.fn(async () => ({ decision: "ask" as const, reason: "You did not request this change." }));
    const input = { admission: mcpApprovalAdmission([tool.serverId], guard), snapshot: NATIVE_MCP_SNAPSHOT,
      call: { name: tool.namespacedName, arguments: { title: "Test" } }, check, ...scope };
    expect(await guardedMcpApprovalRequestForCall(input)).toMatchObject({ guard: { decision: "ask", reason: "You did not request this change." } });
    expect(check).toHaveBeenCalledTimes(1);
    expect(await guardedMcpApprovalRequestForCall({ ...input, admission: undefined })).toBeUndefined();
    const read = NATIVE_MCP_SNAPSHOT.tools.find(tool => tool.annotations?.readOnlyHint === true)!;
    expect(await guardedMcpApprovalRequestForCall({ ...input, call: { name: read.namespacedName, arguments: {} } })).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
  });
  it.each(["allow", "ask"] as const)("persists the guard %s before deciding whether the call can dispatch", async decision => {
    const callRow = { id: "call-row", startedAt: null, roundIndex: 1, ordinal: 0, providerCallId: "call", toolName: "mcp_create" };
    const createCall = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...callRow, ...data }));
    const requestCard = vi.fn(async () => ({ id: "card" }));
    const tx = { $queryRaw: vi.fn(async () => [{ status: "in_progress" }]), modelRunToolCall: { create: createCall },
      mcpToolApproval: { findFirst: vi.fn(async () => null), create: requestCard } };
    const store = createToolCallStore({ $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as PrismaClient);
    const result = await store.begin({ ...scope, approval: { ...request, guard: { decision, reason: "Review this change." } },
      arguments: {}, ordinal: 0, providerCallId: "call", roundIndex: 1, toolName: "mcp_create" });
    expect(result.kind).toBe(decision === "allow" ? "running" : "gated");
    expect(createCall).toHaveBeenCalledWith({ data: expect.objectContaining({ state: decision === "allow" ? "running" : "error" }) });
    expect(requestCard).toHaveBeenCalledWith({ data: expect.objectContaining({ guardDecision: decision, guardReason: "Review this change.",
      userId: "user", modelRunId: "run", toolCallId: "call-row" }), select: { id: true } });
  });
  it("projects automatic decisions with initiator-only details and no decision or continuation controls", () => {
    const row: McpApprovalCardRow = { consumedAt: null, decidedAt: null, decision: null, id: "card", guardDecision: "allow",
      guardReason: "You requested it.", modelRun: { assistantMessage: null }, serverName: "Issues", source: "model",
      toolCall: { ordinal: 0, roundIndex: 1 }, toolTitle: "Create issue" };
    const mine = projectMcpApprovalCards([row], { initiator: true })[0];
    expect(mine).toMatchObject({ state: "allowed_automatically", details: { ordinal: 0, roundIndex: 1 } });
    expect(mine.canDecide).toBeUndefined(); expect(mine.canContinue).toBeUndefined();
    expect(projectMcpApprovalCards([row], { initiator: false })[0].details).toBeUndefined();
    expect(projectMcpApprovalCards([{ ...row, guardDecision: "ask" }], { initiator: true })[0]).toMatchObject({
      state: "pending", canDecide: true, guardReason: "You requested it." });
  });
});
