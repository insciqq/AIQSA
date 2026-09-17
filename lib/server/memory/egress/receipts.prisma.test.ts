import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import type { ProviderAdapter, ProviderRunRequest } from "../../providers/types";
import { runProviderToolLoop } from "../../runs/providerToolLoop";
import { openAIResponsesToolBridge } from "../../tools/bridges";
import type { RunTool } from "../../tools/types";
import { createMemoryToolEgressReceiptService } from "./receipts";

const owners: string[] = [];
const service = createMemoryToolEgressReceiptService(prisma);

async function fixture() {
  const userId = `egress-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, displayName: "Receipt fixture", status: "active" } });
  owners.push(userId);
  await prisma.userMemorySettings.update({ where: { userId }, data: { learnAutomatically: false, referenceChatHistory: false } });
  const chat = await prisma.chat.create({ data: { userId, title: "Receipt fixture" } });
  const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: { blocks: [{ type: "text", text: "Work" }] } } });
  const run = await prisma.modelRun.create({ data: {
    chatId: chat.id, userId, userMessageId: message.id, provider: "openai", modelId: "fixture", status: "in_progress",
    normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "UTC", timeZoneSource: "client" } } }
  } });
  const dispatch = { userId, runId: run.id, destinationKind: "answer_provider", destinationSnapshot: { version: 1 }, requestEvidence: { synthetic: true } };
  return { chat, run, userId, dispatch };
}

afterEach(async () => {
  for (const userId of owners.splice(0)) {
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  }
});
afterAll(() => prisma.$disconnect());

describe("Memory egress receipts follow accepted execution budgets", () => {
  it.each([
    { rounds: 40, calls: 80, perRound: 1 },
    { rounds: 40, calls: 80, perRound: 2 },
    { rounds: 100, calls: 200, perRound: 2 }
  ])("finishes $rounds rounds with $perRound calls each, including final synthesis", async ({ rounds, calls, perRound }) => {
    const { chat, run, dispatch } = await fixture();
    const tool: RunTool = { capability: "workspace", name: "fixture_work", description: "Synthetic work", inputSchema: { type: "object", properties: {} } };
    const initialRequest: ProviderRunRequest = {
      attachmentIds: [], attachments: [], chatId: chat.id,
      content: { blocks: [{ type: "text", text: "Work" }] }, context: { messages: [], mode: "branch_path" },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      toolMode: "auto", modelId: "fixture", params: {}, prompt: { developer: null, system: null }, provider: "openai",
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false },
      searchPlan: { mode: "all_selected", options: [] }
    };
    const callIds = new Map<string, string>();
    let providerRounds = 0;
    const synthesis = vi.fn();
    const adapter: ProviderAdapter = {
      buildRequestPreview: () => ({}),
      async *stream(request) {
        const receipt = await service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST", requestEvidence: { toolChoice: request.toolChoice } });
        providerRounds++;
        await service.completeDispatch(receipt.id);
        const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 };
        if (request.toolChoice === "none") return { finalText: "Finished work", finalProviderResponsePreview: {}, usage };
        return { finalText: "", finalProviderResponsePreview: {}, usage,
          toolCalls: Array.from({ length: perRound }, (_, index) => ({ id: `round-${providerRounds}-${index}`, name: tool.name, arguments: {} })) };
      }
    };
    const outcome = await runProviderToolLoop({
      adapter, bridge: openAIResponsesToolBridge, initialRequest, tools: [tool], parallelToolCalls: true,
      budgets: { maxConcurrency: 2, maxToolCalls: calls, maxToolRounds: rounds }, onFinalSynthesis: synthesis,
      async persistToolBatch({ calls: batch, round, progress }) {
        for (const [index, call] of batch.entries()) {
          const row = await prisma.modelRunToolCall.create({ data: {
            modelRunId: run.id, ordinal: progress.toolCalls + index, roundIndex: round,
            providerCallId: call.id, toolName: call.name, arguments: {}
          } });
          callIds.set(call.id, row.id);
        }
      },
      async executeTool(call) {
        const receipt = await service.beginDispatch({ ...dispatch, mode: "TOOL_CALL", destinationKind: "workspace", modelRunToolCallId: callIds.get(call.id)! });
        await service.completeDispatch(receipt.id);
        return { status: "complete", value: { callId: call.id, name: call.name, status: "complete", content: [{ type: "text", text: "done" }] } };
      }
    });
    expect(outcome).toMatchObject({ status: "complete", toolCalls: rounds * perRound, toolRounds: rounds, final: { finalText: "Finished work" } });
    expect(providerRounds).toBe(rounds + 1);
    expect(synthesis).toHaveBeenCalledTimes(1);
    const receipts = await prisma.memoryToolEgressReceipt.findMany({ where: { modelRunId: run.id }, orderBy: { requestOrdinal: "asc" } });
    expect(receipts).toHaveLength(rounds * perRound + rounds + 1);
    expect(receipts.map(row => row.requestOrdinal)).toEqual(Array.from({ length: receipts.length }, (_, i) => i + 1));
    expect(receipts.every(row => row.dispatchState === "COMPLETED")).toBe(true);
    expect(receipts.at(-1)).toMatchObject({ mode: "PROVIDER_REQUEST", dispatchState: "COMPLETED" });
    await expect(service.settleRecoveredProviderDispatch({ userId: dispatch.userId, runId: run.id, outcome: "COMPLETED" })).resolves.toBe(true);
    const toolCallId = [...callIds.values()].at(-1)!;
    const replay = await service.beginDispatch({ ...dispatch, mode: "TOOL_CALL", destinationKind: "workspace", modelRunToolCallId: toolCallId });
    expect(receipts.some(row => row.id === replay.id)).toBe(true);
    await expect(service.settleRecoveredToolDispatch({ userId: dispatch.userId, runId: run.id, modelRunToolCallId: toolCallId, outcome: "COMPLETED" })).resolves.toBe(true);
    expect(await prisma.memoryToolEgressReceipt.count({ where: { modelRunId: run.id } })).toBe(receipts.length);
  }, 30_000);

  it("serializes concurrent dispatches and reuses the same tool receipt above 64", async () => {
    const { run, dispatch } = await fixture();
    // A sparse tail also proves allocation is based on the last ordinal,
    // not on the number of retained rows.
    const first = await service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST" });
    await prisma.memoryToolEgressReceipt.update({ where: { id: first.id }, data: { requestOrdinal: 64 } });
    const call = await prisma.modelRunToolCall.create({ data: {
      modelRunId: run.id, ordinal: 0, roundIndex: 0, providerCallId: "concurrent", toolName: "fixture_work", arguments: {}
    } });
    const toolInput = { ...dispatch, mode: "TOOL_CALL" as const, modelRunToolCallId: call.id };
    const [left, right, provider, blocked] = await Promise.all([
      service.beginDispatch(toolInput), service.beginDispatch(toolInput),
      service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST" }),
      service.recordBlockedDispatch({ ...dispatch, mode: "PROVIDER_REQUEST", errorCode: "memory_egress_destination_revoked" })
    ]);
    expect(left).toEqual(right);
    expect([left.requestOrdinal, provider.requestOrdinal, blocked.requestOrdinal].sort((a, b) => a - b)).toEqual([65, 66, 67]);
    await expect(service.failDispatch(left.id, "external_tool_dispatch_failed")).resolves.toBe(true);
    await expect(service.settleRecoveredToolDispatch({ ...dispatch, modelRunToolCallId: call.id, outcome: "FAILED" })).resolves.toBe(true);
    const next = await service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST" });
    expect(next.requestOrdinal).toBe(68);
    await expect(service.beginDispatch({ ...dispatch, userId: "foreign-owner", mode: "PROVIDER_REQUEST" })).rejects.toThrow("memory_egress_run_not_found");
    const foreign = await fixture();
    await expect(service.beginDispatch({ ...foreign.dispatch, mode: "TOOL_CALL", modelRunToolCallId: call.id })).rejects.toThrow("memory_egress_tool_call_not_found");
    await expect(service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST", destinationSnapshot: { text: "x".repeat(33 * 1024) } })).rejects.toThrow("memory_egress_destination_too_large");
  });

  it("keeps the SQL shape and tenant guards above the former limit", async () => {
    const { dispatch } = await fixture();
    const receipt = await service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST" });
    for (const data of [
      { requestOrdinal: 0 }, { destinationFingerprint: "invalid" }, { requestEvidenceHash: "invalid" },
      { destinationKind: "invalid kind" }, { destinationSnapshot: "invalid" },
      { dispatchCompletedAt: new Date() }, { userId: "foreign-owner" }
    ]) await expect(prisma.memoryToolEgressReceipt.update({ where: { id: receipt.id }, data })).rejects.toThrow();
    await prisma.memoryToolEgressReceipt.update({ where: { id: receipt.id }, data: { requestOrdinal: 301 } });
    const next = await service.beginDispatch({ ...dispatch, mode: "PROVIDER_REQUEST" });
    expect(next.requestOrdinal).toBe(302);
    expect(await prisma.memoryToolEgressReceipt.findUnique({ where: { id: receipt.id } })).toMatchObject({ userId: dispatch.userId, requestOrdinal: 301, dispatchState: "DISPATCHED" });
  });
});
