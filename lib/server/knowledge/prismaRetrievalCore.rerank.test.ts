import { describe, expect, it, vi } from "vitest";
import { executeKnowledgeRetrievalCore } from "./prismaRetrievalCore";
import {
  createKnowledgeRerankStage,
  KNOWLEDGE_RERANK_ADAPTER_VERSION,
  type KnowledgeRerankExecutor,
  type KnowledgeRerankPin
} from "./rerankExecution";
import { KNOWLEDGE_RERANKER_EVIDENCE_VERSION } from "./rerankEvidence";
import type { KnowledgeRetrievalLane } from "./retrievalRanking";

type CoreClient = Parameters<typeof executeKnowledgeRetrievalCore>[0];
type MockCoreClient = CoreClient & Readonly<{
  $queryRaw: ReturnType<typeof vi.fn>;
  vectors: readonly Readonly<{
    bindingOrdinal: number;
    indexGenerationId: string;
    knowledgeBaseId: string;
    targetDimension: 1_024;
    vector: readonly number[];
  }>[];
}>;

const pin: KnowledgeRerankPin = Object.freeze({
  adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
  candidateFormatterVersion: 1,
  connectionSnapshotId: "connection-1#v1",
  credentialSnapshotRef: "credential-version-1",
  policyVersion: 3,
  provider: "openrouter",
  providerModelId: "deployment-1",
  upstreamModelId: "qwen/qwen3-reranker-8b"
});

function scope(bindingOrdinal: number, baseName: string, knowledgeBaseId: string) {
  return {
    baseName,
    bindingOrdinal,
    eligibleRows: 1,
    indexGenerationId: `generation-${bindingOrdinal}`,
    knowledgeBaseId,
    targetDimension: 1_024
  };
}

function row(input: Readonly<{
  bindingOrdinal?: number;
  chunkId: string;
  contentHash?: string;
  lane?: KnowledgeRetrievalLane;
  laneRank?: number;
  rawScore?: number;
  sourceId?: string;
  vectorDistance?: number;
}>) {
  const sourceId = input.sourceId ?? `source-${input.chunkId}`;
  const bindingOrdinal = input.bindingOrdinal ?? 0;
  return {
    baseName: "Base A",
    bindingOrdinal,
    chunkId: input.chunkId,
    chunkIndex: 0,
    contributingBindingOrdinals: [bindingOrdinal],
    contentHash: input.contentHash ??
      Buffer.from(input.chunkId, "utf8").toString("hex").padEnd(64, "0").slice(0, 64),
    documentId: sourceId,
    documentContext: null,
    documentVersionId: `version-${sourceId}`,
    documentVersionNumber: 1,
    exactKind: input.lane === "exact" ? "identifier" : null,
    fileName: "shared.txt",
    headingPath: ["Раздел"],
    knowledgeBaseId: "base-a",
    lane: input.lane ?? "passage_lexical",
    laneRank: input.laneRank ?? 1,
    layoutKind: "body",
    page: 1,
    rawScore: input.rawScore ?? 1,
    sectionId: null,
    sourceArtifactId: `artifact-${sourceId}`,
    sourceName: "Shared source",
    text: `Evidence ${input.chunkId}.`,
    vectorDistance: input.vectorDistance ?? null,
    vectorMode: input.lane === "passage_semantic" ? "ann" : null
  };
}

function mockClient(scopes: readonly unknown[], rows: readonly unknown[]): MockCoreClient {
  const vectors = scopes.map((value) => {
    const accepted = value as ReturnType<typeof scope>;
    return {
      bindingOrdinal: accepted.bindingOrdinal,
      indexGenerationId: accepted.indexGenerationId,
      knowledgeBaseId: accepted.knowledgeBaseId,
      targetDimension: 1_024 as const,
      vector: Array.from({ length: 1_024 }, () => 0)
    };
  });
  return {
    $queryRaw: vi.fn(async () => [{ candidates: [...rows], scopes: [...scopes] }]),
    vectors
  } as unknown as MockCoreClient;
}

function sqlText(value: unknown): string {
  return (value as { strings: readonly string[] }).strings.join("?");
}

async function execute(
  client: MockCoreClient,
  overrides: Partial<Parameters<typeof executeKnowledgeRetrievalCore>[1]> = {}
) {
  return executeKnowledgeRetrievalCore(client, {
    candidateLimit: 64,
    excludedContentHashes: [],
    query: "договор аренды",
    resultLimit: 16,
    runId: "run-1",
    userId: "user-1",
    vectors: client.vectors,
    ...overrides
  });
}

function scoringExecutor(scoreByChunk: ReadonlyMap<string, number>) {
  return vi.fn<KnowledgeRerankExecutor>(async ({ candidates }) => {
    const orderedIds = candidates.map((candidate) => candidate.chunkId);
    const scored = orderedIds
      .filter((chunkId) => scoreByChunk.has(chunkId))
      .sort((left, right) => scoreByChunk.get(right)! - scoreByChunk.get(left)!);
    const omitted = orderedIds.filter((chunkId) => !scoreByChunk.has(chunkId));
    const outputOrder = [...scored, ...omitted];
    const partial = scored.length < orderedIds.length && scored.length > 0;
    return {
      evidence: {
        adapterVersion: pin.adapterVersion,
        candidateFormatterVersion: pin.candidateFormatterVersion,
        connectionSnapshotId: pin.connectionSnapshotId,
        credentialSnapshotRef: pin.credentialSnapshotRef,
        durationMs: 25,
        fallbackReason: null,
        inputCandidateCount: orderedIds.length,
        orderedCandidateChunkIds: orderedIds,
        outputOrder,
        policyVersion: pin.policyVersion,
        provider: "openrouter",
        providerModelId: pin.providerModelId,
        providerRequestId: "req-1",
        rankingProfileVersion: 2,
        relevanceScores: outputOrder.map((chunkId) => scoreByChunk.get(chunkId) ?? null),
        status: partial ? "partial" : "complete",
        timedOut: false,
        upstreamModelId: pin.upstreamModelId,
        usage: { searchUnits: 1, totalTokens: 64 },
        version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
      },
      scores: new Map([...scoreByChunk].filter(([chunkId]) => orderedIds.includes(chunkId))),
      status: partial ? "partial" : "complete"
    };
  });
}

describe("Prisma retrieval core hosted rerank stage", () => {
  it("makes one rerank invocation whose order controls the final order and rerank scores", async () => {
    const rows = [
      row({ chunkId: "chunk-a", laneRank: 1 }),
      row({ chunkId: "chunk-b", laneRank: 2 }),
      row({ chunkId: "chunk-c", laneRank: 3 })
    ];
    const executor = scoringExecutor(new Map([
      ["chunk-a", 0.1],
      ["chunk-b", 0.95],
      ["chunk-c", 0.5]
    ]));
    const result = await execute(mockClient([scope(0, "Base A", "base-a")], rows), {
      rerank: { executor }
    });
    expect(executor).toHaveBeenCalledOnce();
    expect(result.passages.map((passage) => passage.chunkId))
      .toEqual(["chunk-b", "chunk-c", "chunk-a"]);
    expect(result.passages.map((passage) => passage.rerankScore)).toEqual([0.95, 0.5, 0.1]);
    expect(result.rankingEvidence.candidateOrder).toEqual(["chunk-b", "chunk-c", "chunk-a"]);
    expect(result.rerankerBinding).toMatchObject({ status: "complete", version: 2 });
  });

  it("caps the broad pre-rerank pool at ninety-six and the scoped pool at forty-eight", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => row({
      chunkId: `chunk-${String(index).padStart(3, "0")}`,
      laneRank: index + 1
    }));
    // Per-lane SQL rank limit is 64; simulate a second lane so the merged
    // pool exceeds the cap before bounding.
    const lexical = rows.slice(0, 64);
    const semantic = Array.from({ length: 64 }, (_, index) => row({
      chunkId: `dense-${String(index).padStart(3, "0")}`,
      lane: "passage_semantic",
      laneRank: index + 1,
      rawScore: 0.9,
      vectorDistance: 0.1
    }));
    const broad = scoringExecutor(new Map());
    await execute(mockClient([scope(0, "Base A", "base-a")], [...lexical, ...semantic]), {
      rerank: { executor: broad }
    });
    expect(broad.mock.calls[0]![0].candidates).toHaveLength(96);

    const scoped = scoringExecutor(new Map());
    await execute(mockClient([scope(0, "Base A", "base-a")], [...lexical, ...semantic]), {
      rerank: { executor: scoped },
      resultLimit: 8
    });
    expect(scoped.mock.calls[0]![0].candidates).toHaveLength(48);
  });

  it("sends the provider request only after repository authority scoping", async () => {
    const rows = [row({ chunkId: "chunk-a" }), row({ chunkId: "chunk-b", laneRank: 2 })];
    const executor = scoringExecutor(new Map([["chunk-a", 0.9], ["chunk-b", 0.8]]));
    const client = mockClient([scope(0, "Base A", "base-a")], rows);
    await execute(client, { rerank: { executor } });
    // The single authority-scoped repository query runs first; the executor
    // sees only chunk ids from its decoded envelope.
    expect(client.$queryRaw.mock.invocationCallOrder[0]!)
      .toBeLessThan(executor.mock.invocationCallOrder[0]!);
    expect(executor.mock.calls[0]![0].candidates.map((candidate) => candidate.chunkId).sort())
      .toEqual(["chunk-a", "chunk-b"]);
  });

  it("relaxes the global dense/lexical floors only when a reranker is configured", async () => {
    const rows = [
      row({ chunkId: "chunk-strong", laneRank: 1 }),
      row({
        chunkId: "chunk-weak-lexical",
        laneRank: 2,
        rawScore: 0.01
      }),
      row({
        chunkId: "chunk-weak-dense",
        lane: "passage_semantic",
        laneRank: 1,
        rawScore: 0.1,
        vectorDistance: 0.9
      })
    ];
    const executor = scoringExecutor(new Map([
      ["chunk-strong", 0.5],
      ["chunk-weak-lexical", 0.9],
      ["chunk-weak-dense", 0.8]
    ]));
    const client = mockClient([scope(0, "Base A", "base-a")], rows);
    const reranked = await execute(client, { rerank: { executor } });
    expect(executor.mock.calls[0]![0].candidates.map((candidate) => candidate.chunkId).sort())
      .toEqual(["chunk-strong", "chunk-weak-dense", "chunk-weak-lexical"]);
    expect(reranked.candidateCount).toBe(3);
    // The metadata match floor stays; the global lexical floor is lifted.
    const rerankSql = sqlText(client.$queryRaw.mock.calls[0]![0]);
    expect(rerankSql.match(/"rawScore" >= \?/gu)).toHaveLength(1);

    const deterministicClient = mockClient([scope(0, "Base A", "base-a")], rows);
    const deterministic = await execute(deterministicClient);
    expect(deterministic.candidateCount).toBe(1);
    expect(deterministic.passages.map((passage) => passage.chunkId)).toEqual(["chunk-strong"]);
    const deterministicSql = sqlText(deterministicClient.$queryRaw.mock.calls[0]![0]);
    expect(deterministicSql.match(/"rawScore" >= \?/gu)).toHaveLength(2);
  });

  it("falls back to deterministic weighted RRF with today's floors on a degraded stage", async () => {
    const rows = [
      row({ chunkId: "chunk-exact", lane: "exact", laneRank: 3, rawScore: 0.001 }),
      row({ chunkId: "chunk-strong", laneRank: 1 }),
      row({
        chunkId: "chunk-weak-dense",
        lane: "passage_semantic",
        laneRank: 1,
        rawScore: 0.1,
        vectorDistance: 0.9
      })
    ];
    const executor = vi.fn<KnowledgeRerankExecutor>(async ({ candidates }) => ({
      evidence: {
        adapterVersion: pin.adapterVersion,
        candidateFormatterVersion: pin.candidateFormatterVersion,
        connectionSnapshotId: pin.connectionSnapshotId,
        credentialSnapshotRef: pin.credentialSnapshotRef,
        durationMs: 15_000,
        fallbackReason: "rerank_request_timed_out",
        inputCandidateCount: candidates.length,
        orderedCandidateChunkIds: candidates.map((candidate) => candidate.chunkId),
        outputOrder: [],
        policyVersion: pin.policyVersion,
        provider: null,
        providerModelId: pin.providerModelId,
        providerRequestId: null,
        rankingProfileVersion: 2,
        relevanceScores: [],
        status: "degraded",
        timedOut: true,
        upstreamModelId: pin.upstreamModelId,
        usage: { searchUnits: null, totalTokens: null },
        version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
      },
      scores: new Map<string, number>(),
      status: "degraded"
    }));
    const result = await execute(mockClient([scope(0, "Base A", "base-a")], rows), {
      rerank: { executor }
    });
    expect(executor).toHaveBeenCalledOnce();
    // The weak dense-only candidate is dropped by today's floors while the
    // exact candidate survives; nothing re-runs retrieval or embeddings.
    expect(result.candidateCount).toBe(2);
    expect(result.passages.map((passage) => passage.chunkId).sort())
      .toEqual(["chunk-exact", "chunk-strong"]);
    expect(result.passages.every((passage) => passage.rerankScore === undefined)).toBe(true);
    expect(result.rerankerBinding).toMatchObject({
      fallbackReason: "rerank_request_timed_out",
      status: "degraded",
      timedOut: true
    });
  });

  it("keeps final result limits at sixteen and eight after reranking", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => row({
      chunkId: `chunk-${String(index).padStart(2, "0")}`,
      laneRank: index + 1
    }));
    const scores = new Map(rows.map((entry, index) => [entry.chunkId, 1 - index * 0.001]));
    const broad = await execute(mockClient([scope(0, "Base A", "base-a")], rows), {
      rerank: { executor: scoringExecutor(scores) }
    });
    expect(broad.passages).toHaveLength(16);
    const scoped = await execute(mockClient([scope(0, "Base A", "base-a")], rows), {
      rerank: { executor: scoringExecutor(scores) },
      resultLimit: 8
    });
    expect(scoped.passages).toHaveLength(8);
  });

  it("skips the provider for a single unique candidate through the real stage", async () => {
    const rerank = vi.fn();
    const executor = createKnowledgeRerankStage({
      adapter: Object.freeze({ rerank }),
      pin,
      query: "договор аренды"
    });
    const result = await execute(
      mockClient([scope(0, "Base A", "base-a")], [row({ chunkId: "chunk-only" })]),
      { rerank: { executor } }
    );
    expect(rerank).not.toHaveBeenCalled();
    expect(result.passages.map((passage) => passage.chunkId)).toEqual(["chunk-only"]);
    expect(result.rerankerBinding).toMatchObject({
      inputCandidateCount: 1,
      status: "complete"
    });
  });

  it("keeps deterministic relevance floors when a weak singleton skips reranking", async () => {
    const rerank = vi.fn();
    const executor = createKnowledgeRerankStage({
      adapter: Object.freeze({ rerank }),
      pin,
      query: "договор аренды"
    });
    const result = await execute(
      mockClient([scope(0, "Base A", "base-a")], [row({
        chunkId: "chunk-weak",
        lane: "passage_semantic",
        rawScore: 0.1,
        vectorDistance: 0.9
      })]),
      { rerank: { executor } }
    );
    expect(rerank).not.toHaveBeenCalled();
    expect(result.candidateCount).toBe(0);
    expect(result.passages).toEqual([]);
    expect(result.rerankerBinding).toMatchObject({
      inputCandidateCount: 0,
      status: "complete"
    });
  });
});
