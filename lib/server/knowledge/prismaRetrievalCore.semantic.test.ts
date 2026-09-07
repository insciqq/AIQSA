import { describe, expect, it, vi } from "vitest";
import { knowledgeLexicalBackendEvidenceFixture } from "./searchRetrieval.testFixtures";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import { decodeKnowledgeSemanticHits, type KnowledgeSemanticHit as SemanticHit } from "./semanticCandidates";

const scope = {
  acceptedIndexArtifactIds: ["index-a", "index-b"], baseName: "Neutral",
  bindingOrdinal: 0, eligibleRows: 2, indexGenerationId: "generation-0",
  knowledgeBaseId: "base-0", projectionComplete: true, targetDimension: 1024
};
const hit: SemanticHit = {
  queryOrdinal: 0, bindingOrdinal: 0, indexArtifactId: "index-a", chunkId: "passage-a",
  documentId: "source-a", documentVersionId: "version-a", sourceArtifactId: "artifact-a",
  contentHash: "a".repeat(64), laneRank: 1, vectorDistance: 0.1
};
function candidate(h: SemanticHit) {
  return { ...h, baseName: scope.baseName, contributingBindingOrdinals: [0], chunkIndex: 0,
    documentVersionNumber: 1, documentContext: null, fileName: "Neutral.txt", headingPath: [],
    layoutKind: "body", knowledgeBaseId: scope.knowledgeBaseId, page: 1, sectionId: null,
    sourceName: "Neutral", text: "The same neutral text.", lane: "passage_semantic",
    rawScore: 1 - h.vectorDistance, exactKind: null, vectorMode: "ann" };
}
function fixture(hits = [hit]) {
  const lexicalSearch = vi.fn(async () => ({ hits: [], evidence: knowledgeLexicalBackendEvidenceFixture() }));
  const input = {
    candidateLimit: 64, excludedOccurrenceKeys: [], query: "neutral text", resultLimit: 16,
    runId: "neutral-run", userId: "neutral-owner", lexicalSearch,
    vectors: [{ bindingOrdinal: 0, knowledgeBaseId: scope.knowledgeBaseId,
      indexGenerationId: scope.indexGenerationId, targetDimension: 1024 as const,
      vector: Array.from({length: 1024}, (_, index) => index === 0 ? 1 : 0) }]
  };
  const client = {
    $queryRaw: vi.fn().mockResolvedValueOnce([scope]).mockResolvedValueOnce([
      { candidates: hits.map(candidate), scopeVerified: true, semanticRevalidatedCount: hits.length }
    ]),
    $querySemantic: vi.fn().mockResolvedValue(hits)
  };
  return { input, client, lexicalSearch };
}
function cancelled(input: ReturnType<typeof fixture>["input"], controller: AbortController) {
  const executor = vi.fn(async () => { throw new Error("unexpected_native_dispatch"); });
  return { ...input, rerank: { executor, signal: controller.signal } };
}

describe("separate semantic stage boundaries", () => {
  it("keeps separate Sources when text, hash and distance are equal", async () => {
    const other = { ...hit, indexArtifactId: "index-b", chunkId: "passage-b", documentId: "source-b",
      documentVersionId: "version-b", sourceArtifactId: "artifact-b", laneRank: 2 };
    const f = fixture([hit, other]);
    const result = await executeKnowledgeRetrievalCore(f.client, f.input);
    expect(result.passages.map(p => p.documentId).sort()).toEqual(["source-a", "source-b"]);
    expect(f.client.$querySemantic).toHaveBeenCalledOnce();
    expect(f.lexicalSearch).toHaveBeenCalledOnce();
  });

  it.each(["knowledgeBaseId", "indexGenerationId", "targetDimension"])(
    "rejects a changed vector %s before semantic or lexical work", async field => {
      const f = fixture();
      const vector = { ...f.input.vectors[0], [field]: field === "targetDimension" ? 1536 : "foreign" };
      if (field === "targetDimension") vector.vector = Array.from({length: 1536}, (_, index) => index === 0 ? 1 : 0);
      await expect(executeKnowledgeRetrievalCore(f.client, { ...f.input, vectors: [vector] } as never))
        .rejects.toThrow("knowledge_query_vector_invalid");
      expect(f.client.$queryRaw).toHaveBeenCalledOnce();
      expect(f.client.$querySemantic).not.toHaveBeenCalled();
      expect(f.lexicalSearch).not.toHaveBeenCalled();
    }
  );

  it("does no work when already cancelled", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("stop");
    controller.abort(reason);
    await expect(executeKnowledgeRetrievalCore(f.client, cancelled(f.input, controller))).rejects.toBe(reason);
    expect(f.client.$queryRaw).not.toHaveBeenCalled();
    expect(f.client.$querySemantic).not.toHaveBeenCalled();
    expect(f.lexicalSearch).not.toHaveBeenCalled();
  });

  it("stops after admission when cancelled during its SQL", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("stop");
    f.client.$queryRaw.mockReset().mockImplementationOnce(async () => { controller.abort(reason); return [scope]; });
    await expect(executeKnowledgeRetrievalCore(f.client, cancelled(f.input, controller))).rejects.toBe(reason);
    expect(f.client.$queryRaw).toHaveBeenCalledOnce();
    expect(f.client.$querySemantic).not.toHaveBeenCalled();
    expect(f.lexicalSearch).not.toHaveBeenCalled();
  });

  it("stops between semantic lookup and canonical validation when cancelled", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("stop");
    f.client.$querySemantic.mockImplementationOnce(async () => { controller.abort(reason); return [hit]; });
    await expect(executeKnowledgeRetrievalCore(f.client, cancelled(f.input, controller))).rejects.toBe(reason);
    expect(f.client.$queryRaw).toHaveBeenCalledOnce();
    expect(f.client.$querySemantic).toHaveBeenCalledOnce();
    expect(f.lexicalSearch).not.toHaveBeenCalled();
  });

  it("preserves a semantic SQL failure without retrying or dispatching external work", async () => {
    const f = fixture(), reason = new Error("knowledge_retrieval_query_timed_out");
    f.client.$querySemantic.mockRejectedValueOnce(reason);
    const input = cancelled(f.input, new AbortController());
    await expect(executeKnowledgeRetrievalCore(f.client, input)).rejects.toBe(reason);
    expect(f.client.$queryRaw).toHaveBeenCalledOnce();
    expect(f.client.$querySemantic).toHaveBeenCalledOnce();
    expect(f.lexicalSearch).not.toHaveBeenCalled();
    expect(input.rerank.executor).not.toHaveBeenCalled();
  });

  it("rejects incomplete canonical validation before lexical and native dispatch", async () => {
    const f = fixture();
    f.client.$queryRaw.mockReset().mockResolvedValueOnce([scope]).mockResolvedValueOnce([
      { candidates: [], scopeVerified: true, semanticRevalidatedCount: 0 }
    ]);
    const input = cancelled(f.input, new AbortController());
    await expect(executeKnowledgeRetrievalCore(f.client, input)).rejects.toThrow("knowledge_search_candidate_revalidation_failed");
    expect(f.lexicalSearch).not.toHaveBeenCalled();
    expect(input.rerank.executor).not.toHaveBeenCalled();
  });

  it("rejects changed actual scope before external search", async () => {
    const f = fixture();
    f.client.$queryRaw.mockReset().mockResolvedValueOnce([scope]).mockResolvedValueOnce([
      { candidates: [], scopeVerified: false, semanticRevalidatedCount: 1 }
    ]);
    await expect(executeKnowledgeRetrievalCore(f.client, f.input)).rejects.toThrow("knowledge_retrieval_scope_changed");
    expect(f.lexicalSearch).not.toHaveBeenCalled();
  });

  it("keeps lexical retrieval available when no query embedding exists", async () => {
    const f = fixture([]);
    const result = await executeKnowledgeRetrievalCore(f.client, { ...f.input, vectors: [] });
    expect(result.passages).toEqual([]);
    expect(f.client.$querySemantic).not.toHaveBeenCalled();
    expect(f.lexicalSearch).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...hit, indexArtifactId: "foreign" }], [{ ...hit, bindingOrdinal: 1 }],
    [{ ...hit, laneRank: 65 }], [{ ...hit, contentHash: "invalid" }],
    [hit, { ...hit, laneRank: 2 }], [{ ...hit, queryOrdinal: 1 }],
    [hit, { ...hit, chunkId: "passage-b", laneRank: 2, vectorDistance: 0.05 }]
  ])("rejects malformed, duplicate, unscoped or unordered semantic candidates %#", (...rows) => {
    const f = fixture();
    expect(() => decodeKnowledgeSemanticHits(rows, f.input, [scope])).toThrow("knowledge_semantic_candidates_invalid");
  });
  it("stops after canonical SQL cancellation before external dispatch", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("stop");
    f.client.$queryRaw.mockReset().mockResolvedValueOnce([scope]).mockImplementationOnce(async () => {
      controller.abort(reason);
      return [{ candidates: [candidate(hit)], scopeVerified: true, semanticRevalidatedCount: 1 }];
    });
    const input = cancelled(f.input, controller);
    await expect(executeKnowledgeRetrievalCore(f.client, input)).rejects.toBe(reason);
    expect(f.lexicalSearch).not.toHaveBeenCalled();
    expect(input.rerank.executor).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "true", 1])("rejects malformed current scope proof %#", async proof => {
    const f = fixture();
    f.client.$queryRaw.mockReset().mockResolvedValueOnce([scope]).mockResolvedValueOnce([
      { candidates: [candidate(hit)], scopeVerified: proof, semanticRevalidatedCount: 1 }
    ]);
    const input = cancelled(f.input, new AbortController());
    await expect(executeKnowledgeRetrievalCore(f.client, input)).rejects.toThrow("knowledge_retrieval_envelope_invalid");
    expect(f.lexicalSearch).not.toHaveBeenCalled();
    expect(input.rerank.executor).not.toHaveBeenCalled();
  });

});
