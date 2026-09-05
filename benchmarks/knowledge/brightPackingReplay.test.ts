import { afterEach, describe, expect, it, vi } from "vitest";
import { toolLoopKnowledgeEvidenceDispatchDraft } from "../../lib/server/knowledge/automaticEvidence";
import { KNOWLEDGE_RESULT_VERSION, type KnowledgeRetrievalEvidence } from "../../lib/server/knowledge/retrievalTypes";
import { knowledgeToolResultContent, knowledgeToolResultText } from "../../lib/server/knowledge/toolResult";
import type { ProviderRunRequest } from "../../lib/server/providers/types";
import type { ToolExecutionResult } from "../../lib/server/tools/types";
import { snapshotToolExecutionResult } from "../../lib/server/runs/toolExecutionPersistence";
import { knowledgeLexicalBackendEvidenceFixture } from "../../lib/server/knowledge/searchRetrieval.testFixtures";
import { applyBrightPackingReplaySupplement, captureBrightPackingReplayContext, captureBrightPackingReplaySupplement, replayBrightEvidencePacking } from "./brightPackingReplay";

const request: ProviderRunRequest = { provider: "fake", modelId: "fixture", modelCapabilities: { contextWindow: 32768 },
  knowledgeEvidencePackingVersion: 4, attachmentIds: [], attachments: [], chatId: "chat",
  content: { blocks: [{ type: "text", text: "What are the opening dates?" }] }, params: {},
  prompt: { developer: null, system: null }, searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto" };
const at = (second: number) => new Date(second * 1000).toISOString();

function result(index: number): ToolExecutionResult {
  const text = `Room ${index} opens on June ${index + 1}.`;
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{ baseContentRevision: 1, baseName: "Schedule", candidateCount: 1, indexedContentRevision: 1,
      indexGenerationId: "generation", knowledgeBaseId: "base", ordinal: 0, state: "ready", targetDimension: 1024,
      vectorSearch: { bindingOrdinal: 0, candidateCount: 1, eligibleRows: 1, mode: "exact", targetDimension: 1024,
        scan: { efSearch: null, iterativeScan: null, maxScanTuples: null, retrievalBucket: 0 } }, vectorSpaceFingerprint: "a".repeat(64) }],
    budget: { operation: "automatic_search", stopReason: null, version: 1,
      usage: { cumulativeCandidates: 1, estimatedCostMicros: 0, latencyMs: 3, operations: 1, queryEmbeddingCalls: 1, retrievedTokens: 8 } },
    candidateCount: 1, candidateLimit: 40, durationMs: 3,
    embeddingExecutions: [{ bindingOrdinals: [0], durationMs: 1, inputTokens: 4, modelId: "embedding", provider: "test",
      providerModelId: "embedding", requestId: null, status: "complete", totalTokens: 4 }],
    fusion: "weighted_rrf_v2", invocationOrdinal: index, lexicalBackend: knowledgeLexicalBackendEvidenceFixture({ candidateCount: 1 }),
    operation: "automatic_search", outcome: "complete", providerText: "pending", query: `Room ${index} opening date`, resultLimit: 8,
    results: [{ annRank: 1, baseName: "Schedule", bindingOrdinal: 0, chunkId: `chunk-${index}`, chunkIndex: 0,
      contentHash: "b".repeat(64), documentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      documentVersionId: `version-${index}`, documentVersionNumber: 1, fileName: "schedule.txt", ftsRank: 1, ftsScore: 0.5,
      fusedScore: 2 / 61, handle: `K${index}`, includedText: text, includedTextBytes: Buffer.byteLength(text), knowledgeBaseId: "base",
      headingPath: ["Opening dates"], page: 1, sectionId: `section-${index}`,
      signalProvenance: [{ exactKind: null, lane: "passage_semantic", rank: 1, rawScore: 0.9, vectorDistance: 0.1, vectorMode: "exact" }],
      sourceAlias: `S${index}`, sourceArtifactId: `artifact-${index}`, sourceName: "Schedule", sourceTextBytes: Buffer.byteLength(text),
      textTruncated: false, vectorDistance: 0.1, vectorScore: 0.9 }],
    scopeAliases: [{ alias: `S${index}`, kind: "source", label: "Schedule" }], version: KNOWLEDGE_RESULT_VERSION
  };
  const evidence = { ...draft, providerText: knowledgeToolResultText(draft) };
  return { callId: `call-${index}`, name: "search_knowledge", status: "complete", content: knowledgeToolResultContent(evidence),
    rawPreview: { knowledgeResultVersion: KNOWLEDGE_RESULT_VERSION, knowledgeRetrieval: evidence, providerCall: true } };
}

function fixture(packingVersion: 4 | 5 = 4) {
  const acceptedRequest = { ...request, knowledgeEvidencePackingVersion: packingVersion };
  const results = [result(1), result(2)];
  const exclusions = [{ count: 1, reason: "not_ready" as const, resourceType: "source" as const }];
  const first = toolLoopKnowledgeEvidenceDispatchDraft({ request: acceptedRequest, results: results.slice(0, 1), exclusions })!;
  const second = toolLoopKnowledgeEvidenceDispatchDraft({ request: acceptedRequest, results, exclusions, retainedItems: first.items })!;
  const manifest = (draft: typeof first, second: number) => ({ providerAttempt: { purpose: "knowledge_evidence_compose_v2", dispatchedAt: at(second) },
    messageText: draft.message, messageHash: draft.messageHash, items: draft.items.map(item => ({ handle: item.handle, renderedBlock: item.text })) });
  const trace = { packingReplayContext: captureBrightPackingReplayContext(acceptedRequest, exclusions), knowledgeRunScope: { answerRoute: "rag_v1" },
    toolCalls: results.map((result, index) => ({ toolName: "search_knowledge", completedAt: at(index ? 4 : 1), roundIndex: index + 1, ordinal: 0,
      result: snapshotToolExecutionResult(result, 100000) })),
    knowledgeDispatchManifests: [manifest(first, 2), manifest(second, 5), manifest(second, 7)],
    knowledgeProviderAttempts: [{ purpose: "knowledge_evidence_review_v2", settledAt: at(3), acceptedResult: {
      blocks: [{ verdict: "supported", evidenceHandles: ["K1"] }] } }]
  };
  return { trace, first, second };
}

afterEach(() => vi.unstubAllGlobals());
describe("offline evidence packing replay", () => {
  it("captures only exact accepted packing inputs, never current defaults or secrets", () => {
    expect(captureBrightPackingReplayContext({ ...request, credentials: "PRIVATE", modelCapabilities: {
      contextWindow: 32768, privateField: "PRIVATE" } }, [{ count: 2, reason: "unattached", resourceType: "base", secret: "PRIVATE" }]))
      .toEqual({ version: 1, provider: "fake", modelId: "fixture", contextWindow: 32768, packingVersion: 4,
        exclusions: [{ count: 2, reason: "unattached", resourceType: "base" }] });
    expect(captureBrightPackingReplayContext({ ...request, modelCapabilities: {} }, [])?.contextWindow).toBeNull();
    for (const bad of [{}, { ...request, knowledgeEvidencePackingVersion: "4" }, { ...request, knowledgeEvidencePackingVersion: 6 }, { ...request, modelCapabilities: { contextWindow: -1 } }]) {
      expect(captureBrightPackingReplayContext(bad, [])).toBeNull();
    }
    expect(captureBrightPackingReplayContext(request, [{ count: "1", reason: "unattached", resourceType: "base" }])).toBeNull();
  });

  it.each([4, 5] as const)("uses the accepted correction-retention policy during replay (%s)", packingVersion => {
    const { trace } = fixture(packingVersion);
    Object.assign(trace.knowledgeProviderAttempts[0]!.acceptedResult, { version: 2, blocks: [],
      requirements: [{ status: "needs_correction", correctionEvidenceHandles: ["K1"] }] });
    const replay = replayBrightEvidencePacking(trace);
    expect(replay.status).toBe("matched");
    expect(replay.cycles[1]?.retainedItems).toBe(packingVersion === 5 ? 1 : 0);
  });

  it("replays persisted tool results through the real packer, including retention and same-context correction", () => {
    const { trace, first, second } = fixture();
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(2);
    const fetch = vi.fn(() => { throw Error("unexpected_network"); });
    vi.stubGlobal("fetch", fetch);
    expect(replayBrightEvidencePacking(trace)).toMatchObject({ status: "matched", reason: null, cycles: [
      { searches: 1, retainedItems: 0, items: 1, messageMatches: true, itemsMatch: true },
      { searches: 2, retainedItems: 1, items: 2, messageMatches: true, itemsMatch: true },
      { searches: 2, items: 2, messageMatches: true, itemsMatch: true }
    ] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops at the first changed context instead of applying reviews from another input", () => {
    const { trace } = fixture();
    trace.knowledgeDispatchManifests[0]!.messageHash = "0".repeat(64);
    const replay = replayBrightEvidencePacking(trace);
    expect(replay.status).toBe("mismatch");
    expect(replay.cycles).toHaveLength(1);
  });

  it("binds an old trace's accepted-input supplement to that exact trace without rewriting it", () => {
    const { trace } = fixture();
    const old = { ...trace, packingReplayContext: null };
    const supplement = captureBrightPackingReplaySupplement(old, request, trace.packingReplayContext!.exclusions);
    const supplemented = applyBrightPackingReplaySupplement(old, supplement);
    expect(replayBrightEvidencePacking(supplemented).status).toBe("matched");
    expect(old.packingReplayContext).toBeNull();
    expect(() => applyBrightPackingReplaySupplement({ ...old, question: "changed" }, supplement)).toThrow("supplement_invalid");
    expect(() => applyBrightPackingReplaySupplement(trace, supplement)).toThrow("supplement_invalid");
    expect(() => captureBrightPackingReplaySupplement(old, {}, [])).toThrow("replay_context_invalid");
  });

  it("reports missing historical inputs honestly and rejects malformed present inputs", () => {
    const { trace } = fixture();
    expect(replayBrightEvidencePacking({ ...trace, packingReplayContext: null })).toMatchObject({ status: "unavailable", reason: "missing_replay_context" });
    expect(replayBrightEvidencePacking({ ...trace, knowledgeDispatchManifests: [] })).toMatchObject({ status: "unavailable", reason: "no_dispatched_composition" });
    expect(replayBrightEvidencePacking({ ...trace, knowledgeRunScope: { answerRoute: "full_context_v1" } })).toMatchObject({ status: "unavailable", reason: "unsupported_answer_route" });
    expect(() => replayBrightEvidencePacking({ ...trace, packingReplayContext: { ...trace.packingReplayContext, extra: true } })).toThrow("replay_context_invalid");
    expect(() => replayBrightEvidencePacking({ ...trace, toolCalls: [null] })).toThrow("trace_invalid");
    expect(() => replayBrightEvidencePacking({ ...trace, toolCalls: [{ ...trace.toolCalls[0], result: {} }] })).toThrow("tool_result_invalid");
  });
});
