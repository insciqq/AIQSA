import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ToolExecutionContext } from "../../tools/types";
import type { MemorySearchRetrieved, createMemorySearchRetrieval } from "./retrieval";
const state = vi.hoisted(() => ({ settings: { useMemoryFacts: true, memoryGeneration: 1, referenceChatHistory: true, activeIndexGenerationId: null } }));
vi.mock("../persistence/transaction", () => ({ withLockedMemoryTransaction: (_client: unknown, _user: string,
  action: (tx: unknown, settings: unknown) => unknown) => action(_client, state.settings) }));
vi.mock("./retrieval", () => ({ createMemorySearchRetrieval: () => vi.fn() }));
vi.mock("../../runs/preparingMemoryItems", () => ({ resolvePreparingMemoryItem: vi.fn(), samePreparingMemoryItemSnapshot: vi.fn(() => true) }));
vi.mock("../retrieval/decayTouch", () => ({ scheduleDirectMemoryFactAccessTouch: vi.fn() }));
import { createPrismaMemorySearchService } from "./runtime";
import { scheduleDirectMemoryFactAccessTouch } from "../retrieval/decayTouch";
import { MEMORY_READ_BUDGET_ERROR_CODES, MemoryReadBudgetError } from "../retrieval/readBudget";
import { resolvePreparingMemoryItem } from "../../runs/preparingMemoryItems";

function fixture(chat: Readonly<{ memoryMode?: string; scheduledTaskPrompt?: boolean }> = {}) {
  state.settings = { useMemoryFacts: true, memoryGeneration: 1, referenceChatHistory: true, activeIndexGenerationId: null };
  const snapshot = { version: "memory-search-v1", maxCalls: 3, resultTokens: 6000, comparisonResultTokens: 12000,
    timeoutSeconds: 30, memoryGeneration: 1, referenceChatHistory: true, destinations: [] } as const;
  const call = { id: "provider-call", name: "memory_search", arguments: { query: "What did we decide?", comparison: false } };
  const context = { runId: "run", userId: "user", persistedToolCallId: "call", request: { memorySearch: snapshot, toolMode: "auto" } } as unknown as ToolExecutionContext;
  const receipts: Record<string, unknown>[] = [];
  const client = {
    userMemorySettings: { findUnique: vi.fn(async () => state.settings) },
    $queryRaw: vi.fn(async () => [{ id: "run" }]),
    modelRun: { findFirst: vi.fn(async () => ({ status: "streaming", normalizedRequest: { memorySearch: snapshot, toolMode: "auto" },
      chatId: "chat", assistantId: null, userMessage: { scheduledTaskPrompt: chat.scheduledTaskPrompt ?? false },
      chat: { userId: "user", projectId: null, memoryMode: chat.memoryMode ?? "NORMAL", permanentDeletionAt: null, folderId: null,
        memoryBranchGeneration: 1 } })) },
    modelRunToolCall: { findFirst: vi.fn(async () => ({ state: "running", toolName: "memory_search", ordinal: 0 })),
      count: vi.fn(async () => 1) },
    memoryExecutionBinding: { findMany: vi.fn(async () => []) },
    memoryHistoryRun: {
      findUnique: vi.fn(async () => receipts[0] ?? null),
      create: vi.fn(async ({ data }: { data: object }) => { const row = { ...data, id: "receipt", retentionState: "RETAINED" }; receipts.push(row); return row; }),
      updateMany: vi.fn(async ({ data }: { data: object }) => { Object.assign(receipts[0] ?? {}, data); return { count: 1 }; })
    }
  };
  const empty = { pack: { items: [], text: null }, snapshot: { activeGenerationId: null }, items: [], limited: false } as unknown as MemorySearchRetrieved;
  const retrieve = vi.fn(async (_input: Parameters<ReturnType<typeof createMemorySearchRetrieval>>[0]) => empty);
  return { call, context, client, receipts, empty, retrieve, service: createPrismaMemorySearchService(client as unknown as PrismaClient, { retrieve }) };
}
afterEach(() => vi.useRealTimers());
describe("native Memory search execution", () => {
  it("settles and reuses exact results without re-running retrieval", async () => {
    const f = fixture();
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "complete", content: [{ value: { outcome: "no_results" } }] });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "complete" });
    expect(f.retrieve).toHaveBeenCalledTimes(1);
    expect(f.receipts[0]).toMatchObject({ invocationOrdinal: 1, state: "COMPLETE", indexingEvidence: { delivered: false } });
  });
  it("keeps retrieval diagnostic evidence private to the durable receipt", async () => {
    const f = fixture();
    const diagnosticEvidence: MemorySearchRetrieved["diagnosticEvidence"] = {
      version: 1, reasons: [{ stage: "facts", code: "memory_read_statement_timeout" }],
      factsLexicalState: "UNAVAILABLE", historyLexicalState: "DISABLED",
      factsVectorState: "UNAVAILABLE", historyVectorState: "DISABLED",
      lexicalFailureCount: 0, lexicalFailureCodes: [], fusedCount: 0,
      expandedBeforeRerankCount: 0, rerankCandidateCount: 0, rankedAfterRerankCount: 0,
      expandedFinalCount: 0, packedCount: 0
    };
    f.retrieve.mockResolvedValue({ ...f.empty, limited: true, diagnosticEvidence });
    const output = await f.service.execute(f.call, f.context);
    expect(f.receipts[0]).toMatchObject({ results: { diagnosticEvidence } });
    expect(JSON.stringify(output)).not.toContain("diagnosticEvidence");
    expect(JSON.stringify(output)).not.toContain("memory_read_statement_timeout");
    expect(output).toMatchObject({ content: [{ value: { outcome: "limited",
      guidance: expect.stringContaining("Do not tell the user that Memory") } }] });
  });
  it("keeps the structured failure for the model while telling it not to narrate the fault", async () => {
    const f = fixture();
    f.retrieve.mockRejectedValueOnce(new Error("private provider payload"));
    const output = await f.service.execute(f.call, f.context);
    expect(output).toMatchObject({ status: "error", content: [{ value: { outcome: "failure", reason: "unavailable" } }] });
    const guidance = (output.content[0] as { value: { guidance: string } }).value.guidance;
    expect(guidance).toContain("Do not tell the user that Memory or memory search failed");
    expect(guidance).toContain("say that you do not know it");
    const ok = fixture();
    const settled = await ok.service.execute(ok.call, ok.context);
    expect((settled.content[0] as { value: { guidance: string } }).value.guidance).not.toContain("Do not tell the user");
  });
  it("allows a visible search lasting twenty seconds within the thirty-second budget", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.retrieve.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(f.empty), 20_000)));
    const execution = f.service.execute(f.call, f.context);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await execution).toMatchObject({ status: "complete" });
  });
  it("stops a stuck search at the accepted deadline and never replays the attempt", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.retrieve.mockImplementation(() => new Promise(() => {}));
    const execution = f.service.execute(f.call, f.context);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await execution).toMatchObject({ status: "error" });
    expect(f.receipts[0]).toMatchObject({ state: "ERROR", errorCode: "memory_search_deadline_exceeded" });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(await f.service.revalidate(f.call, f.context)).toMatchObject({ status: "error", content: [{ value: { reason: "timeout" } }] });
    expect(f.retrieve).toHaveBeenCalledTimes(1);
  });
  it("retains a content-free database timeout reason without echoing unknown failures", async () => {
    const f = fixture();
    f.retrieve.mockRejectedValueOnce(new MemoryReadBudgetError("memory_read_statement_timeout"));
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.receipts[0]).toMatchObject({ errorCode: "memory_read_statement_timeout" });
    const other = fixture();
    other.retrieve.mockRejectedValueOnce(new Error("private provider payload"));
    await other.service.execute(other.call, other.context);
    expect(other.receipts[0]).toMatchObject({ errorCode: "memory_search_retrieval_failed" });
    expect(JSON.stringify(other.receipts)).not.toContain("private provider payload");
  });
  it.each(MEMORY_READ_BUDGET_ERROR_CODES)("keeps the distinct read-budget cause %s on the receipt", async (code) => {
    const f = fixture();
    f.retrieve.mockRejectedValueOnce(new MemoryReadBudgetError(code));
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.receipts[0]).toMatchObject({ state: "ERROR", errorCode: code });
  });
  it("classifies raw pool acquisition and expired transaction failures without their text", async () => {
    for (const [message, code] of [
      ["Transaction API error: Unable to start a transaction in the given time.", "memory_read_connection_timeout"],
      ["Transaction API error: Transaction already closed.", "memory_read_transaction_expired"]
    ] as const) {
      const f = fixture();
      f.retrieve.mockRejectedValueOnce(Object.assign(new Error(message), { code: "P2028" }));
      await f.service.execute(f.call, f.context);
      expect(f.receipts[0]).toMatchObject({ errorCode: code });
      expect(JSON.stringify(f.receipts)).not.toContain("Transaction API");
    }
  });
  it("rejects an index replacement during search with a distinct private receipt reason", async () => {
    const f = fixture();
    f.retrieve.mockResolvedValue({ ...f.empty, snapshot: { ...f.empty.snapshot, activeGenerationId: "new-index" } });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.receipts[0]).toMatchObject({ errorCode: "memory_search_index_changed" });
  });
  it("honors Stop and the independent three-call bound", async () => {
    const f = fixture();
    const stop = new AbortController(); stop.abort();
    expect(await f.service.execute(f.call, f.context, { signal: stop.signal })).toMatchObject({ status: "error" });
    expect(f.retrieve).not.toHaveBeenCalled();
    f.client.modelRunToolCall.count.mockResolvedValue(4);
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).not.toHaveBeenCalled();
  });
  it("counts malformed predecessors and preserves their durable call ordinal", async () => {
    const f = fixture();
    const malformed = { ...f.call, arguments: { query: "", comparison: false } };
    expect(await f.service.execute(malformed, f.context)).toMatchObject({ status: "error" });
    expect(f.receipts).toHaveLength(0);
    f.client.modelRunToolCall.count.mockResolvedValue(3);
    f.client.modelRunToolCall.findFirst.mockResolvedValue({ state: "running", toolName: "memory_search", ordinal: 7 });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "complete" });
    expect(f.receipts[0]).toMatchObject({ invocationOrdinal: 3 });
    expect(f.client.modelRunToolCall.count).toHaveBeenCalledWith({ where: { modelRunId: "run",
      toolName: "memory_search", ordinal: { lte: 7 } } });
  });
  it("denies a valid fourth request even when malformed predecessors created no receipts", async () => {
    const f = fixture();
    for (let index = 0; index < 3; index++) {
      expect(await f.service.execute({ ...f.call, arguments: {} }, f.context)).toMatchObject({ status: "error" });
    }
    expect(f.receipts).toHaveLength(0);
    f.client.modelRunToolCall.count.mockResolvedValue(4);
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).not.toHaveBeenCalled();
    expect(f.receipts).toHaveLength(0);
  });
  it("fails closed if pause or reset happens while retrieval is pending", async () => {
    const f = fixture();
    f.retrieve.mockImplementation(async () => { state.settings.useMemoryFacts = false; return f.empty; });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.receipts[0]).toMatchObject({ state: "ERROR" });
  });
  it("aborts an in-flight provider signal when Memory is revoked", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const providerSignals: AbortSignal[] = [];
    f.retrieve.mockImplementation(async input => {
      providerSignals.push(input.signal);
      return new Promise(() => {});
    });
    const execution = f.service.execute(f.call, f.context);
    await vi.advanceTimersByTimeAsync(100);
    state.settings.memoryGeneration = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await execution).toMatchObject({ status: "error" });
    expect(providerSignals[0]?.aborted).toBe(true);
  });
  it("does not replay a crash-ambiguous receipt", async () => {
    const f = fixture();
    f.receipts.push({ id: "receipt", state: "RUNNING", retentionState: "RETAINED" });
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).not.toHaveBeenCalled();
    expect(f.receipts[0]).toMatchObject({ state: "ERROR", errorCode: "memory_search_execution_uncertain" });
  });
  it("rejects settled evidence after reset and stale item reauthorization", async () => {
    const f = fixture();
    await f.service.execute(f.call, f.context);
    state.settings.memoryGeneration = 2;
    expect(await f.service.revalidate(f.call, f.context)).toMatchObject({ status: "error" });
    state.settings.memoryGeneration = 1;
    const receipt = f.receipts[0]!;
    (receipt.results as { items: unknown[]; resolved: unknown[] }).items = [{ itemType: "FACT_VERSION" }];
    (receipt.results as { items: unknown[]; resolved: unknown[] }).resolved = [{}];
    vi.mocked(resolvePreparingMemoryItem).mockRejectedValueOnce(new Error("memory_attempt_item_stale"));
    expect(await f.service.revalidate(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).toHaveBeenCalledTimes(1);
  });
  it("lets a scheduled task's own turn search in its excluded chat, and no other turn there", async () => {
    const ordinary = fixture({ memoryMode: "EXCLUDED" });
    expect(await ordinary.service.execute(ordinary.call, ordinary.context)).toMatchObject({ status: "error" });
    expect(ordinary.retrieve).not.toHaveBeenCalled();
    const task = fixture({ memoryMode: "EXCLUDED", scheduledTaskPrompt: true });
    expect(await task.service.execute(task.call, task.context)).toMatchObject({ status: "complete" });
    expect(task.retrieve).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat", scheduledPrompt: true }));
    // Replay reauthorizes the same way.
    expect(await task.service.revalidate(task.call, task.context)).toMatchObject({ status: "complete" });
    for (const memoryMode of ["TEMPORARY", "NORMAL"]) {
      const other = fixture({ memoryMode, scheduledTaskPrompt: true });
      const outcome = await other.service.execute(other.call, other.context);
      expect(outcome.status).toBe(memoryMode === "NORMAL" ? "complete" : "error");
    }
  });

  it("marks delivered evidence for its sources but touches nothing a scheduled task's turn found", async () => {
    const evidence = { version: "memory-search-v1", results: [{ exactItemId: "version-1", factVersionId: "version-1",
      featureSnapshot: {}, includedText: "Synthetic fact", itemType: "FACT_VERSION", recallChunkId: null, recallRoundId: null,
      selectionReason: "search", sourceBranchGenerationSnapshot: null, sourceChatId: null, sourceContentHashSnapshot: null,
      sourceMessageIds: [], sourceRevisionSnapshot: null }] };
    const deliver = async (scheduledTaskPrompt: boolean) => {
      const f = fixture({ memoryMode: scheduledTaskPrompt ? "EXCLUDED" : "NORMAL", scheduledTaskPrompt });
      const marked = vi.fn(async () => ({ count: 1 }));
      const client = { ...f.client, memoryHistoryRun: { ...f.client.memoryHistoryRun,
        findMany: vi.fn(async () => [{ id: "receipt", results: evidence }]), updateMany: marked },
      memoryFactVersion: { findMany: vi.fn(async () => [{ factId: "fact-1", id: "version-1" }]) } };
      await createPrismaMemorySearchService(client as unknown as PrismaClient, { retrieve: f.retrieve })
        .markDelivered({ runId: "run", toolCallIds: ["call"], userId: "user" });
      expect(marked).toHaveBeenCalledWith(expect.objectContaining({ data: { indexingEvidence: { delivered: true } } }));
    };
    vi.mocked(scheduleDirectMemoryFactAccessTouch).mockClear();
    await deliver(true);
    expect(scheduleDirectMemoryFactAccessTouch).not.toHaveBeenCalled();
    await deliver(false);
    expect(scheduleDirectMemoryFactAccessTouch).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      facts: [{ factId: "fact-1", factVersionId: "version-1" }], userId: "user" }));
  });

  it("rejects active branch loss before retrieval and on replay", async () => {
    const f = fixture();
    f.client.$queryRaw.mockResolvedValueOnce([]);
    expect(await f.service.execute(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).not.toHaveBeenCalled();
    await f.service.execute(f.call, f.context);
    f.client.$queryRaw.mockResolvedValueOnce([]);
    expect(await f.service.revalidate(f.call, f.context)).toMatchObject({ status: "error" });
    expect(f.retrieve).toHaveBeenCalledTimes(1);
  });
});
