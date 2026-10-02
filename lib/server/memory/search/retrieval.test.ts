import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { MemoryCandidateMetadata, MemoryLaneCandidate, MemoryRankedCandidate } from "../../../domain/memory/retrieval";
import { estimateApproxTokens } from "../../../domain/contextBudget";
import { createMemorySearchRetrieval } from "./retrieval";
import type { MemorySearchSnapshot } from "./contract";
import type { MemoryLocalRetrievalInput, MemoryLocalRetrievalResult, MemoryLocalRetrievalSnapshot } from "../retrieval/localRepository";
import type { MemoryRunRerankResult } from "../retrieval/runUtilities";
import { MEMORY_READ_BUDGET_ERROR_CODES, MemoryReadBudgetError } from "../retrieval/readBudget";

function fixture(history = true) {
  const now = new Date("2026-09-01T00:00:00Z");
  const metadata: MemoryCandidateMetadata = {
    canonicalKey: null, category: "about_you", confidence: 1, conflict: false, coreEligible: false,
    coreSalience: "NONE", current: true, dedupeKey: "fact-overflow", directness: "DIRECT", dimensionKey: null,
    entityIds: [], expectedAt: null, expiresAt: null, factId: "fact-overflow", historical: false, historySafetyClass: null,
    importance: 0, identityKind: "PROPOSITION", languageCode: "ru", lastConfirmedAt: now, lastUsedAt: null,
    lifecycleState: "ACTIVE", matchedEntityRole: null, modality: "STATE", observedAt: now, occurredAt: null,
    occurredFrom: null, occurredTo: null, pinned: false, predicateKey: null, relationDepth: 0, scopeAffinity: 0,
    scopeType: "GLOBAL_USER", sensitivityClass: "NORMAL", sourceAssistantId: null, sourceChatId: null,
    sourceFolderId: null, sourceMode: "EXPLICIT", sourceAuthority: "EXPLICIT", subjectKey: null,
    systemFrom: now, temperatureClass: null, temperatureScore: 0, validFrom: null, validTo: null
  };
  const fact: MemoryLaneCandidate = { itemId: "overflow-version", itemType: "FACT_VERSION", entryId: "entry",
    lane: "FACT_LEXICAL_UNICODE", hardFilterPassed: true, rawScore: 1, metadata };
  const past: MemoryLaneCandidate = { ...fact, itemId: "past-round", itemType: "RECALL_CHUNK", entryId: "history-entry",
    lane: "HISTORY_RECALL_LEXICAL_UNICODE", metadata: { ...metadata, factId: null, dedupeKey: "past-round", lifecycleState: null,
      sourceMode: null, sourceAuthority: "PAST_CHAT", sourceChatId: "past-chat", historySafetyClass: "NORMAL" } };
  const snapshot: MemoryLocalRetrievalSnapshot = { activeGenerationId: "index", assistantId: null, chatId: "chat",
    chatMemoryMode: "NORMAL", decayEnabled: false, decayPolicyVersion: null, folderId: null, historyAuthorityRevision: 1,
    indexMode: "LEXICAL_ONLY", memoryGeneration: 1, memoryRevision: 1, reason: "ready", referenceChatHistory: history,
    repositoryVersion: "test", settingsRevision: 1, status: "READY", useMemoryFacts: true, userId: "user" };
  const repository = {
    snapshot: vi.fn(async () => snapshot),
    retrieve: vi.fn(async (input: MemoryLocalRetrievalInput) => ({ core: [],
      laneResults: [{ lane: input.plan.mode === "TARGETED_CURRENT" ? fact.lane : past.lane,
        candidates: [input.plan.mode === "TARGETED_CURRENT" ? fact : past] }], lexicalEvidence: [], lexicalFailures: [],
      lexicalState: "READY" as const, vectorEvidence: [], vectorFailureCodes: [] as MemoryLocalRetrievalResult["vectorFailureCodes"],
      vectorState: "NOT_CONFIGURED" as MemoryLocalRetrievalResult["vectorState"], snapshot })),
    expand: vi.fn(async (_snapshot: MemoryLocalRetrievalSnapshot, _plan: unknown, ranked: readonly MemoryRankedCandidate[],
      _options?: Readonly<{ signal?: AbortSignal }>) =>
      ranked.map(candidate => ({ itemId: candidate.itemId, itemType: candidate.itemType,
        safeText: candidate.itemType === "FACT_VERSION" ? "The user prefers green tea." : "user: We agreed to meet on Tuesday.",
        projectionKind: candidate.itemType === "FACT_VERSION" ? "FACT_DISPLAY_TEXT" as const : "RECALL_CHUNK_SAFE_PROJECTED_TEXT" as const,
        occurredFrom: now, occurredTo: now, sourceChatId: candidate.metadata.sourceChatId, supportingItemId: null })))
  };
  const utilities = { embedQuery: vi.fn(async () => ({ status: "UNAVAILABLE" as const, reason: "unavailable" })),
    rerank: vi.fn(async (): Promise<MemoryRunRerankResult> => ({ status: "UNAVAILABLE", reason: "unavailable" })) };
  const vectors = { resolveActiveProfile: vi.fn(async () => ({ status: "DEGRADED" as const, reason: "memory_vector_unavailable" as const })) };
  const accepted: MemorySearchSnapshot = { version: "memory-search-v1", maxCalls: 3, resultTokens: 6000,
    comparisonResultTokens: 12000, timeoutSeconds: 30, memoryGeneration: 1, referenceChatHistory: history, destinations: [] };
  const input = { userId: "user", chatId: "chat", assistantId: null, runId: "run", toolCallId: "call",
    query: "Which tea do I prefer and when did we agree to meet?", comparison: false, accepted, signal: new AbortController().signal };
  const retrieve = createMemorySearchRetrieval({} as PrismaClient, { repository, utilities, vectors });
  return { input, retrieve, repository, utilities, vectors };
}
describe("native search retrieval composition", () => {
  it("searches overflow facts and history without loading standing context or invoking a reader", async () => {
    const f = fixture();
    const output = await f.retrieve(f.input);
    expect(output.pack.items.map(item => item.itemId)).toEqual(expect.arrayContaining(["overflow-version", "past-round"]));
    expect(output.items.find(item => item.itemType === "FACT_VERSION")?.featureSnapshot).toMatchObject({ retrievalMode: "TARGETED_CURRENT" });
    expect(output.items.find(item => item.itemType === "RECALL_CHUNK")?.featureSnapshot).toMatchObject({ retrievalMode: "PAST_CHAT_SEARCH" });
    expect(f.repository.retrieve).toHaveBeenCalledTimes(2);
    expect(f.utilities.rerank).not.toHaveBeenCalled();
    expect(f.utilities.embedQuery).not.toHaveBeenCalled();
    expect(estimateApproxTokens(JSON.stringify(output.pack.text)) + 300).toBeLessThanOrEqual(6000);
  });
  it("keeps facts searchable while history is off", async () => {
    const f = fixture(false);
    const output = await f.retrieve(f.input);
    expect(output.pack.items.map(item => item.itemType)).toEqual(["FACT_VERSION"]);
    expect(f.repository.retrieve).toHaveBeenCalledTimes(1);
  });
  it("retains baseline evidence when reranker coverage is incomplete", async () => {
    const f = fixture();
    f.input.accepted = { ...f.input.accepted, destinations: [{ role: "MEMORY_RERANK", providerModelId: "rerank",
      destinationFingerprint: "a".repeat(64), executionTargetFingerprint: "b".repeat(64) }] };
    f.utilities.rerank.mockResolvedValue({ status: "READY", bindingId: "binding", decisions: [] });
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.pack.items).toHaveLength(2);
    expect(output.diagnosticEvidence.reasons).toContainEqual({ stage: "rerank", code: "memory_run_utility_output_invalid" });
  });
  it("keeps useful facts when the history lane fails", async () => {
    const f = fixture();
    const original = f.repository.retrieve.getMockImplementation()!;
    f.repository.retrieve.mockImplementation(async input => {
      if (input.plan.mode === "PAST_CHAT_SEARCH") throw new Error("index unavailable");
      return original(input);
    });
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.pack.items.map(item => item.itemType)).toEqual(["FACT_VERSION"]);
  });
  it("reports partial retrieval when vectors fail but lexical evidence remains", async () => {
    const f = fixture();
    const original = f.repository.retrieve.getMockImplementation()!;
    f.repository.retrieve.mockImplementation(async input => ({ ...await original(input),
      vectorState: "DEGRADED" }));
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.pack.items).toHaveLength(2);
    expect(output.diagnosticEvidence.reasons).toContainEqual({ stage: "facts", code: "vector_degraded" });
  });
  it("records bounded stage evidence while dropping private exception text and unknown codes", async () => {
    const f = fixture();
    f.repository.retrieve.mockImplementation(async input => {
      if (input.plan.mode === "PAST_CHAT_SEARCH") throw Object.assign(new Error("private history query and secret endpoint"), { code: "private-token-value" });
      throw Object.assign(new Error("private fact query"), { code: "P2028" });
    });
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.diagnosticEvidence).toMatchObject({ version: 1,
      reasons: [{ stage: "facts", code: "memory_read_transaction_expired" }, { stage: "history", code: "retrieval_read_failed" }],
      factsLexicalState: "UNAVAILABLE", historyLexicalState: "UNAVAILABLE", fusedCount: 0,
      expandedBeforeRerankCount: 0, rerankCandidateCount: 0, expandedFinalCount: 0, packedCount: 0 });
    expect(JSON.stringify(output.diagnosticEvidence)).not.toMatch(/private|query|endpoint|token-value/u);
    expect(JSON.stringify(output.diagnosticEvidence)).not.toContain(f.input.userId);
  });
  it.each(MEMORY_READ_BUDGET_ERROR_CODES)("keeps the read-budget cause %s distinct", async (code) => {
    const f = fixture();
    f.repository.retrieve.mockRejectedValue(new MemoryReadBudgetError(code));
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.diagnosticEvidence.reasons).toEqual([{ stage: "facts", code }, { stage: "history", code }]);
  });
  it("keeps P2028 pool acquisition distinct from an expired transaction", async () => {
    const f = fixture();
    f.repository.retrieve.mockImplementation(async input => {
      throw Object.assign(new Error(input.plan.mode === "PAST_CHAT_SEARCH"
        ? "Transaction API error: Unable to start a transaction in the given time."
        : "Transaction API error: Transaction already closed."), { code: "P2028" });
    });
    const output = await f.retrieve(f.input);
    expect(output.diagnosticEvidence.reasons).toEqual([
      { stage: "facts", code: "memory_read_transaction_expired" },
      { stage: "history", code: "memory_read_connection_timeout" }
    ]);
    expect(JSON.stringify(output.diagnosticEvidence)).not.toMatch(/Transaction API|given time/u);
  });
  it("adds the allowlisted source code of degraded vector work beside vector_degraded", async () => {
    const f = fixture();
    const original = f.repository.retrieve.getMockImplementation()!;
    f.repository.retrieve.mockImplementation(async input => ({ ...await original(input), vectorState: "DEGRADED",
      vectorFailureCodes: input.plan.mode === "PAST_CHAT_SEARCH"
        ? ["memory_read_admission_timeout", "memory_vector_generation_stale"]
        : ["private-vector-detail" as "memory_vector_unavailable"] }));
    const output = await f.retrieve(f.input);
    expect(output.limited).toBe(true);
    expect(output.diagnosticEvidence.version).toBe(1);
    expect(output.diagnosticEvidence.reasons).toEqual([
      { stage: "facts", code: "vector_degraded" },
      { stage: "facts", code: "vector_failure_unclassified" },
      { stage: "history", code: "vector_degraded" },
      { stage: "history", code: "memory_read_admission_timeout" },
      { stage: "history", code: "memory_vector_generation_stale" }
    ]);
    expect(JSON.stringify(output.diagnosticEvidence)).not.toContain("private");
  });
  it("excludes tool events only from its own vector reads and passes the search signal", async () => {
    const f = fixture();
    await f.retrieve(f.input);
    for (const [input] of f.repository.retrieve.mock.calls) {
      expect(input).toMatchObject({ excludeToolEvents: true, settleSignal: f.input.signal });
    }
    expect(f.repository.snapshot).toHaveBeenCalledWith(expect.objectContaining({ settleSignal: f.input.signal }));
    expect(f.repository.expand).toHaveBeenCalled();
    for (const call of f.repository.expand.mock.calls) {
      expect(call[3]).toEqual({ signal: f.input.signal });
    }
  });
});
