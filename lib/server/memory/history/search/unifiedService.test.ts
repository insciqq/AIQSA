import { describe, expect, it, vi } from "vitest";
import type {
  MemoryCandidateMetadata,
  MemoryExpandedCandidate,
  MemoryLaneCandidate,
  MemoryRetrievalPlan
} from "../../../../domain/memory/retrieval";
import type { PrismaLocalMemoryRetrievalRepository } from "../../retrieval/localRepository";
import type { MemoryRunUtilityService } from "../../retrieval/runUtilities";
import {
  createMemoryUnifiedSearchService,
  type MemoryUnifiedSearchInput
} from "./unifiedService";

const now = new Date("2026-08-13T12:00:00.000Z");
const from = new Date("2026-08-01T00:00:00.000Z");
const to = new Date("2026-08-14T00:00:00.000Z");

function metadata(
  id: string,
  kind: "EVENT" | "FACT" | "HISTORY"
): MemoryCandidateMetadata {
  const history = kind === "HISTORY";
  return {
    canonicalKey: null,
    category: null,
    confidence: 0,
    conflict: false,
    coreEligible: false,
    coreSalience: "NONE",
    current: true,
    dedupeKey: id,
    directness: history ? null : "DIRECT",
    factId: history ? null : `fact-${id}`,
    historical: false,
    historySafetyClass: history ? "NORMAL" : null,
    importance: 0,
    languageCode: "und",
    modality: history ? null : kind === "EVENT" ? "EVENT" : "PREFERENCE",
    occurredFrom: history ? from : null,
    occurredTo: history ? to : null,
    pinned: false,
    scopeAffinity: 1,
    scopeType: history ? null : "GLOBAL_USER",
    sensitivityClass: history ? null : "NORMAL",
    sourceAssistantId: null,
    sourceChatId: history ? "source-chat" : null,
    sourceFolderId: null,
    sourceMode: history ? null : "AUTOMATIC",
    systemFrom: now,
    temperatureClass: null,
    validFrom: null,
    validTo: null
  };
}

function candidate(
  id: string,
  kind: "EVENT" | "FACT" | "HISTORY",
  lane: MemoryLaneCandidate["lane"]
): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`,
    hardFilterPassed: true,
    itemId: id,
    itemType: kind === "HISTORY" ? "RECALL_CHUNK" : "FACT_VERSION",
    lane,
    metadata: metadata(id, kind),
    rawScore: 0.25
  };
}

function expansion(
  id: string,
  kind: "EVENT" | "FACT" | "HISTORY"
): MemoryExpandedCandidate {
  return {
    itemId: id,
    itemType: kind === "HISTORY" ? "RECALL_CHUNK" : "FACT_VERSION",
    occurredFrom: kind === "HISTORY" ? from : null,
    occurredTo: kind === "HISTORY" ? to : null,
    projectionKind: kind === "HISTORY"
      ? "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
      : "FACT_DISPLAY_TEXT",
    safeText: `${kind.toLocaleLowerCase("und")} text ${id}`,
    sourceChatId: kind === "HISTORY" ? "source-chat" : null,
    supportingItemId: null
  };
}

function repository(
  entries: readonly Readonly<{
    candidate: MemoryLaneCandidate;
    expansion: MemoryExpandedCandidate;
  }>[]
) {
  const retrieve = vi.fn(async (input: { plan: MemoryRetrievalPlan; vector?: unknown }) => ({
    core: [],
    laneResults: entries.map(({ candidate: item }) => ({
      candidates: [item],
      lane: item.lane
    })),
    lexicalFailures: [],
    lexicalState: "READY" as const,
    snapshot: {
      activeGenerationId: "generation-1",
      assistantId: null,
      chatId: "chat-1",
      chatMemoryMode: "NORMAL" as const,
      folderId: null,
      historySuppressionIdentitySnapshot: "a".repeat(64),
      indexMode: "HYBRID" as const,
      memoryGeneration: 1,
      memoryRevision: 1,
      reason: "ready",
      referenceChatHistory: true,
      repositoryVersion: "test",
      settingsRevision: 1,
      status: "READY" as const,
      useMemoryFacts: true,
      userId: "user-1"
    },
    vectorEvidence: [],
    vectorState: "READY" as const
  }));
  const expand = vi.fn(async () => entries.map((entry) => entry.expansion));
  return {
    expand,
    retrieve,
    value: { expand, retrieve } as unknown as PrismaLocalMemoryRetrievalRepository
  };
}

function request(): MemoryUnifiedSearchInput {
  return {
    from,
    query: "find my preference",
    scope: { targetId: "folder-1", type: "FOLDER" },
    sourceKinds: ["FACT", "EVENT", "HISTORY"],
    to
  };
}

function context() {
  return {
    assistantId: null,
    chatId: "chat-1",
    now,
    owner: {
      modelRunId: "run-1",
      modelRunToolCallId: "call-1",
      type: "MODEL_RUN_TOOL_CALL" as const
    },
    signal: new AbortController().signal,
    userId: "user-1"
  };
}

function utilities(
  relevantHandles: readonly string[] | null
): MemoryRunUtilityService & Readonly<{
  embedQuery: ReturnType<typeof vi.fn>;
  rerank: ReturnType<typeof vi.fn>;
}> {
  const embedQuery = vi.fn(async () => ({
    reason: "memory_embedding_not_configured",
    status: "UNAVAILABLE" as const
  }));
  const rerank = vi.fn(async () => relevantHandles === null
    ? { reason: "memory_relevance_unavailable", status: "UNAVAILABLE" as const }
    : {
        bindingId: "relevance-binding",
        relevantHandles,
        status: "READY" as const
      });
  return {
    embedQuery,
    expandQuery: vi.fn(),
    rerank
  } as unknown as ReturnType<typeof utilities>;
}

function vectorRepository() {
  return {
    resolveActiveProfile: vi.fn(async () => ({
      reason: "memory_vector_unavailable" as const,
      status: "DEGRADED" as const
    }))
  };
}

describe("unified Memory search service", () => {
  it("applies typed filters and returns relevance-ordered facts, events, and history", async () => {
    const local = repository([
      { candidate: candidate("fact-1", "FACT", "FACT_EXACT"),
        expansion: expansion("fact-1", "FACT") },
      { candidate: candidate("event-1", "EVENT", "FACT_RECENT"),
        expansion: expansion("event-1", "EVENT") },
      { candidate: candidate("history-1", "HISTORY", "HISTORY_RECALL_RECENT"),
        expansion: expansion("history-1", "HISTORY") }
    ]);
    const model = utilities(["c2", "c0", "c1"]);
    const result = await createMemoryUnifiedSearchService({
      repository: local.value,
      utilities: model,
      vectorRepository: vectorRepository()
    }).search(context(), request());

    expect(local.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        filters: {
          from,
          scopeTargetId: "folder-1",
          scopeType: "FOLDER",
          sourceKinds: ["FACT", "EVENT", "HISTORY"],
          to
        }
      })
    }));
    expect(model.rerank).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([
        expect.objectContaining({ sourceKind: "FACT" }),
        expect.objectContaining({ sourceKind: "EVENT" }),
        expect.objectContaining({ sourceKind: "HISTORY" })
      ])
    }));
    expect(result.results.map((item) => item.sourceKind)).toEqual([
      "HISTORY", "EVENT", "FACT"
    ]);
    expect(result.privateResults.map((item) => item.itemId)).toEqual([
      "history-1", "event-1", "fact-1"
    ]);
    expect(result.executionBindingIds).toEqual(["relevance-binding"]);
    expect(result.indexing).toMatchObject({
      candidateCount: 3,
      relevanceState: "READY",
      serviceVersion: "memory-unified-search-v1"
    });
  });

  it("exposes bounded RRF candidates when explicit-search relevance is unavailable", async () => {
    const local = repository([
      { candidate: candidate("fact-a", "FACT", "FACT_EXACT"),
        expansion: expansion("fact-a", "FACT") },
      { candidate: candidate("fact-b", "FACT", "FACT_FTS_SIMPLE"),
        expansion: expansion("fact-b", "FACT") }
    ]);
    const result = await createMemoryUnifiedSearchService({
      repository: local.value,
      utilities: utilities(null),
      vectorRepository: vectorRepository()
    }).search(context(), request());

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.text)).toEqual([
      "fact text fact-a", "fact text fact-b"
    ]);
    expect(result.indexing).toMatchObject({
      degradationCode: "memory_relevance_unavailable",
      relevanceState: "UNAVAILABLE"
    });
  });

  it("keeps local search but suppresses embedding and relevance for secret-shaped input", async () => {
    const local = repository([
      { candidate: candidate("fact-secret", "FACT", "FACT_EXACT"),
        expansion: expansion("fact-secret", "FACT") }
    ]);
    const model = utilities(["c0"]);
    const vectors = vectorRepository();
    const result = await createMemoryUnifiedSearchService({
      repository: local.value,
      utilities: model,
      vectorRepository: vectors
    }).search(context(), {
      ...request(),
      query: "sk-abcdefghijklmnopqrstuvwxyz123456"
    });

    expect(local.retrieve).toHaveBeenCalledOnce();
    expect(vectors.resolveActiveProfile).not.toHaveBeenCalled();
    expect(model.embedQuery).not.toHaveBeenCalled();
    expect(model.rerank).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(1);
    expect(result.indexing).toMatchObject({
      degradationCode: "memory_external_query_processing_blocked",
      relevanceState: "SKIPPED"
    });
  });
});
