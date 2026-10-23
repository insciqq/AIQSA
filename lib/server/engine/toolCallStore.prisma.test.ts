import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { mcpApprovalRequest } from "../mcp/writeApproval";
import { prisma } from "../prisma";
import { mcpApprovalGated } from "../runs/mcpApprovalGate";
import { createToolCallStore } from "./toolCallStore";

const owners: string[] = [];
const servers: string[] = [];
const store = createToolCallStore(prisma);

async function fixture(status: "cancelled" | "streaming" = "streaming", engine: "native" | "v1" = "native") {
  const userId = `tool-call-store-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Tool call store test", id: userId, status: "active" } });
  const serverId = randomUUID();
  servers.push(serverId);
  await prisma.mcpServer.create({ data: { displayName: "Synthetic Records", enabled: true, id: serverId,
    namespace: `store_${serverId.replaceAll("-", "")}` } });
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Calls", userId } });
  const run = async (runStatus: typeof status) => {
    const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Delete r-1"), role: "user",
      status: "complete" } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
      role: "assistant", status: runStatus === "streaming" ? "streaming" : "cancelled" } });
    // Only a preparing run lacks its normalized request (ModelRun_memory_request_shape_check).
    return prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine, modelId: "fake-qsa",
      normalizedRequest: {}, provider: "fake", status: runStatus, userId, userMessageId: question.id } });
  };
  const current = await run(status);
  const approval = mcpApprovalRequest({ arguments: { id: "r-1" }, definitionHash: "d".repeat(64), originalName: "delete_record",
    serverId, serverName: "Synthetic Records", toolName: "mcp_records_delete_record" });
  const begin = (extra: Record<string, unknown> = {}) => store.begin({ arguments: { id: "r-1" }, chatId: chat.id, ordinal: 0,
    providerCallId: `call-${randomUUID()}`, roundIndex: 1, runId: current.id, toolName: "mcp_records_delete_record", userId, ...extra });
  return { approval, begin, chatId: chat.id, run, runId: current.id, serverId, userId };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
  for (const id of servers.splice(0)) await prisma.mcpServer.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("native tool call records", () => {
  it("records a call running before it is sent and settles it once", async () => {
    const { begin, runId } = await fixture();
    const begun = await begin();
    expect(begun.kind).toBe("running");
    if (begun.kind !== "running") return;
    expect(begun.row.startedAt).not.toBeNull();
    const result = { callId: begun.row.providerCallId, content: [{ text: "done", type: "text" }], name: begun.row.toolName,
      status: "complete" };
    await expect(store.settle({ callId: begun.row.id, result, runId, state: "complete" })).resolves.toBe(true);
    await expect(store.settle({ callId: begun.row.id, result, runId, state: "error" })).resolves.toBe(false);
    await expect(prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: begun.row.id } })).resolves
      .toMatchObject({ state: "complete" });
  });

  it("settles a call needing approval gated, with a pending card, when no Allow is left", async () => {
    const { approval, begin, runId } = await fixture();
    const begun = await begin({ approval });
    expect(begun.kind).toBe("gated");
    if (begun.kind !== "gated") return;
    expect(mcpApprovalGated(begun.row)).toBe(true);
    await expect(prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: begun.approvalId } })).resolves
      .toMatchObject({ decision: null, modelRunId: runId, toolCallId: begun.row.id });
  });

  it("consumes the user's Allow once from an earlier answer of the chat and sends the call", async () => {
    const { approval, begin, chatId, run, runId, serverId, userId } = await fixture();
    const earlier = await run("cancelled");
    // A model's request names the refused call it gated (McpToolApproval_state_check).
    const refusedCall = await prisma.modelRunToolCall.create({ data: { arguments: { id: "r-1" }, completedAt: new Date(),
      modelRunId: earlier.id, ordinal: 0, providerCallId: "call-earlier", roundIndex: 1, state: "error", toolName: approval.toolName } });
    const allowed = await prisma.mcpToolApproval.create({ data: {
      argumentsDigest: approval.argumentsDigest, chatId, decidedAt: new Date(), decision: "allow_once", definitionHash: approval.definitionHash,
      expiresAt: new Date(Date.now() + 60_000), modelRunId: earlier.id, serverId, serverName: approval.serverName, source: "model",
      toolCallId: refusedCall.id, toolName: approval.toolName, toolTitle: approval.toolTitle, userId
    } });
    const begun = await begin({ approval });
    expect(begun.kind).toBe("running");
    await expect(prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: allowed.id } })).resolves
      .toMatchObject({ consumedByRunId: runId });
    // The approval is spent: the next identical call waits again.
    await expect(begin({ approval, ordinal: 1 })).resolves.toMatchObject({ kind: "gated" });
  });

  it("sends a continuation's call only with the user's Allow that names exactly it", async () => {
    const { approval, begin, chatId, run, runId, serverId, userId } = await fixture();
    const earlier = await run("cancelled");
    let refused = 0;
    const decided = async (decision: "allow_once" | "allow_server", argumentsDigest = approval.argumentsDigest) => {
      const refusedCall = await prisma.modelRunToolCall.create({ data: { arguments: { id: "r-1" }, completedAt: new Date(),
        modelRunId: earlier.id, ordinal: refused++, providerCallId: `call-${randomUUID()}`, roundIndex: 1, state: "error",
        toolName: approval.toolName } });
      return prisma.mcpToolApproval.create({ data: { argumentsDigest, chatId, decidedAt: new Date(), decision,
        definitionHash: approval.definitionHash, ...(decision === "allow_once" ? { expiresAt: new Date(Date.now() + 60_000) } : {}),
        modelRunId: earlier.id, serverId, serverName: approval.serverName, source: "model", toolCallId: refusedCall.id,
        toolName: approval.toolName, toolTitle: approval.toolTitle, userId } });
    };
    // Always allow stands: the call is sent and the consent is not consumed.
    const always = await decided("allow_server");
    await expect(begin({ approval, approvedBy: always.id })).resolves.toMatchObject({ kind: "running" });
    await expect(prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: always.id } })).resolves.toMatchObject({ consumedAt: null });
    // Allow once is consumed by this run, once.
    const once = await decided("allow_once");
    await expect(begin({ approval, approvedBy: once.id, ordinal: 1 })).resolves.toMatchObject({ kind: "running" });
    await expect(prisma.mcpToolApproval.findUniqueOrThrow({ where: { id: once.id } })).resolves
      .toMatchObject({ consumedByRunId: runId });
    await expect(begin({ approval, approvedBy: once.id, ordinal: 2 })).resolves.toMatchObject({ kind: "gated" });
    // An Allow of other arguments allows nothing here: the call asks with a card of its own.
    const other = await decided("allow_once", "e".repeat(64));
    await expect(begin({ approval, approvedBy: other.id, ordinal: 3 })).resolves.toMatchObject({ kind: "gated" });
  });

  it("records nothing once the run stopped, or for a run of the old core", async () => {
    await expect((await fixture("cancelled")).begin()).resolves.toEqual({ kind: "inactive" });
    await expect((await fixture("streaming", "v1")).begin()).resolves.toEqual({ kind: "inactive" });
  });

  it("records a refused call as never started", async () => {
    const { chatId, runId, userId } = await fixture();
    const row = await store.refuse({ arguments: {}, chatId, ordinal: 0, providerCallId: "call-unknown", roundIndex: 1,
      result: { callId: "call-unknown", content: [{ text: "no", type: "text" }], name: "made_up", status: "error" }, runId,
      toolName: "made_up", userId });
    expect(row).toMatchObject({ startedAt: null, state: "error" });
  });
});
