import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  fuseMemoryRetrievalCandidates,
  planMemoryRetrieval,
  type MemoryCandidateMetadata,
  type MemoryLaneCandidate,
  type MemoryRankedCandidate
} from "../../../domain/memory/retrieval";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../persistence/lexical";
import {
  createPrismaLocalMemoryRetrievalRepository,
  applyMemorySourceFamilyRecallFloor,
  classifyMemoryLexicalCanonicalRejections,
  memorySemanticLexicalTerms,
  projectMemoryAggregationDigestRepresentative,
  selectMemoryAggregationSessionRepresentatives,
  selectMemoryTargetedSessionRepresentatives,
  selectMemoryIntraChatRawCandidates,
  selectMemorySourceDiverseLaneCandidates,
  shouldRunMemoryNgramFallback,
  type MemoryLexicalProviderForLane,
  type MemoryLocalRetrievalSnapshot
} from "./localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "./vector";
import { MemoryReadBudgetError } from "./readBudget";
import type {
  MemoryLexicalShadowLaneReceipt,
  MemoryLexicalShadowRuntime
} from "./lexical/shadow";
import {
  MemoryLexicalCircuitBreaker,
  RoutedMemoryLexicalCandidateProvider
} from "./lexical/cutover";
import {
  memoryLexicalProjectionReadinessScope,
  type MemoryLexicalSearchRequest
} from "./lexical/contract";
import {
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from
  "../history/segments";

const now = new Date("2026-08-10T12:00:00.000Z");

function floorMetadata(
  id: string,
  sourceKind: "EVENT" | "FACT" | "HISTORY"
): MemoryCandidateMetadata {
  const history = sourceKind === "HISTORY";
  return {
    canonicalKey: null,
    category: history ? null : "memory",
    confidence: 0.9,
    conflict: false,
    coreEligible: false,
    coreSalience: "NONE",
    current: true,
    dedupeKey: id,
    directness: history ? null : "DIRECT",
    dimensionKey: null,
    entityIds: [],
    evidenceRootHash: null,
    expectedAt: null,
    expiresAt: null,
    factId: history ? null : id,
    historical: false,
    historySafetyClass: history ? "NORMAL" : null,
    identityKind: history ? null : "PROPOSITION",
    importance: 0.5,
    languageCode: "en",
    lastConfirmedAt: null,
    lastUsedAt: null,
    lifecycleState: history ? null : "ACTIVE",
    matchedEntityRole: null,
    modality: history ? null : sourceKind === "EVENT" ? "EVENT" : "PREFERENCE",
    observedAt: null,
    occurredAt: null,
    occurredFrom: history ? now : null,
    occurredTo: history ? new Date(now.getTime() + 60_000) : null,
    pinned: false,
    predicateKey: null,
    relationDepth: 0,
    scopeAffinity: 0.5,
    scopeType: history ? null : "GLOBAL_USER",
    sensitivityClass: history ? null : "NORMAL",
    sourceAssistantId: null,
    sourceAuthority: history ? "PAST_CHAT" : "EXPLICIT",
    sourceChatId: history ? `chat-${id}` : null,
    sourceFolderId: null,
    sourceMode: history ? null : "EXPLICIT",
    subjectKey: null,
    synthesisDepth: 0,
    systemFrom: now,
    temperatureClass: null,
    temperatureScore: 0,
    validFrom: null,
    validTo: null
  };
}

function floorCandidate(
  id: string,
  lane: MemoryLaneCandidate["lane"],
  sourceKind: "EVENT" | "FACT" | "HISTORY",
  rawScore: number
): MemoryLaneCandidate {
  return {
    entryId: `entry-${id}`,
    hardFilterPassed: true,
    itemId: id,
    itemType: sourceKind === "HISTORY" ? "RECALL_CHUNK" : "FACT_VERSION",
    lane,
    metadata: floorMetadata(id, sourceKind),
    rawScore
  };
}

function sessionCandidate(
  id: string,
  sourceChatId: string,
  finalScore: number,
  laneRanks: MemoryRankedCandidate["laneRanks"]
): MemoryRankedCandidate {
  return {
    entryId: `entry-${id}`,
    featureSnapshot: {
      authorityRank: 0,
      fusionVersion: "test",
      laneCount: Object.keys(laneRanks).length,
      temporalFit: 1,
      tier: "DYNAMIC"
    },
    finalScore,
    itemId: id,
    itemType: "RECALL_CHUNK",
    laneRanks,
    metadata: { sourceChatId } as MemoryRankedCandidate["metadata"],
    rrfScore: finalScore,
    selectionReason: "history_recall_vector"
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    activeIndexGenerationId: "generation-1",
    assistantOwnerId: null,
    chatFolderId: null,
    chatId: "chat-1",
    chatMemoryMode: "NORMAL",
    folderOwnerId: null,
    generationId: "generation-1",
    generationIndexMode: "LEXICAL_ONLY",
    generationChunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
    generationContextualKeyPolicyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
    generationLanguageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
    generationNormalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
    generationPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
    generationRoundProjectionVersion: MEMORY_RECALL_ROUND_PROJECTION_VERSION,
    generationRoundSegmentProjectionVersion:
      MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION,
    generationState: "ACTIVE",
    memoryGeneration: 2,
    memoryRevision: 4,
    ownerStatus: "active",
    referenceChatHistory: true,
    settingsRevision: 3,
    useMemoryFacts: true,
    ...overrides
  };
}

function mockClient(
  row = snapshotRow(),
  options: Readonly<{
    completionRows?: readonly Record<string, unknown>[];
    expansionRows?: readonly Record<string, unknown>[];
    failLaneQueries?: boolean;
    laneFailure?: unknown;
    lexicalCanonicalRows?: readonly Record<string, unknown>[];
    lexicalCanonicalRowSets?: readonly (
      readonly Record<string, unknown>[]
    )[];
    lexicalRejectionRows?: readonly Record<string, unknown>[];
    vectorHits?: readonly Record<string, unknown>[];
  }> = {}
) {
  const laneSql: string[] = [];
  let lexicalCanonicalCall = 0;
  let nextExpansionRows: readonly Record<string, unknown>[] | null = null;
  const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) => {
    const sql = query.strings?.join("?") ?? "";
    if (sql.includes("set_config('lock_timeout'")) return [];
    if (sql.includes('owner."status"')) return [row];
    laneSql.push(sql);
    if (sql.includes("ranked_rounds") || sql.includes("ranked_user_rounds")) {
      return options.completionRows ?? [];
    }
    if (sql.includes("lexical_raw_candidates")) {
      if (options.lexicalCanonicalRowSets) {
        return options.lexicalCanonicalRowSets[lexicalCanonicalCall++] ?? [];
      }
      return options.lexicalCanonicalRows ?? [];
    }
    if (sql.includes("OPENSEARCH_CANONICAL_REJECTION_AUDIT")) {
      return options.lexicalRejectionRows ?? [];
    }
    if (nextExpansionRows && sql.includes('AS "projectionKind"')) {
      const rows = nextExpansionRows;
      nextExpansionRows = null;
      return rows;
    }
    if (sql.includes("RECALL_ROUND_RAW_SAFE_TEXT")) return options.expansionRows ?? [];
    if (options.laneFailure !== undefined) throw options.laneFailure;
    if (options.failLaneQueries === true) {
      throw new Error("fts unavailable");
    }
    return [];
  });
  const memoryEntityAlias = { findFirst: vi.fn(async () => {
    if (options.laneFailure !== undefined) throw options.laneFailure;
    if (options.failLaneQueries === true) throw new Error("entity lookup unavailable");
    return null;
  }) };
  const $transaction = vi.fn(async (
    callback: (tx: Record<string, unknown>) => Promise<unknown>,
    transactionOptions?: Readonly<{ isolationLevel?: string }>
  ) => {
    if (transactionOptions?.isolationLevel === "RepeatableRead") {
      if (!options.vectorHits) throw new Error("vector unavailable");
      return {
        hits: options.vectorHits,
        lanes: [],
        profile: {},
        status: "READY"
      };
    }
    return callback({ $queryRaw, memoryEntityAlias });
  });
  const client = {
    $transaction,
    $queryRaw,
    memoryEntityAlias,
    memoryPauseInterval: { findMany: vi.fn(async () => []) },
    memorySourceBarrier: { findMany: vi.fn(async () => []) },
    memorySuppression: { findMany: vi.fn(async () => []) }
  } as unknown as PrismaClient;
  return {
    $queryRaw,
    client,
    laneSql,
    setNextExpansionRows(rows: readonly Record<string, unknown>[]) {
      nextExpansionRows = rows;
    }
  };
}

describe("local Memory retrieval repository", () => {
  it("runs bounded lexical fallback unless a complete canonical variant matched", () => {
    const digest = floorCandidate(
      "digest-primary",
      "HISTORY_DIGEST_FTS_SIMPLE",
      "HISTORY",
      1
    );
    expect(shouldRunMemoryNgramFallback("HISTORY_RECALL_LEXICAL_NGRAM", [{
      candidates: [digest],
      lane: "HISTORY_DIGEST_FTS_SIMPLE"
    }], new Set())).toBe(true);
    const partial = floorCandidate(
      "history-primary",
      "HISTORY_RECALL_LEXICAL_UNICODE",
      "HISTORY",
      1
    );
    expect(shouldRunMemoryNgramFallback("HISTORY_RECALL_LEXICAL_NGRAM", [{
      candidates: [partial],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }], new Set())).toBe(true);
    expect(shouldRunMemoryNgramFallback("HISTORY_RECALL_LEXICAL_NGRAM", [{
      candidates: [partial],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }], new Set(["HISTORY_RECALL_LEXICAL_UNICODE"]))).toBe(false);
    expect(shouldRunMemoryNgramFallback("FACT_LEXICAL_NGRAM", [{
      candidates: [],
      lane: "FACT_LEXICAL_UNICODE"
    }], new Set(["FACT_LEXICAL_UNICODE"]))).toBe(true);
  });

  it("completes only a reranker-selected session with bounded authoritative rounds", async () => {
    const plan = planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "What is the total distance across all trips?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const mocked = mockClient(snapshotRow(), {
      completionRows: [{
        evidenceRootHash: "a".repeat(64),
        itemId: "round-1",
        languageCode: "en",
        matchedSegmentId: null,
        matchedSegmentPosition: null,
        occurredFrom: now,
        occurredTo: new Date(now.getTime() + 60_000),
        parentChunkId: "parent-1",
        roundOrdinal: 0,
        safetyClass: "NORMAL",
        sourceAssistantId: null,
        sourceChatId: "chat-selected",
        sourceFolderId: null
      }],
      expansionRows: [{
        itemId: "round-1",
        itemType: "RECALL_ROUND",
        occurredFrom: now,
        occurredTo: new Date(now.getTime() + 60_000),
        patternSupportingEvidence: [],
        projectionKind: "RECALL_ROUND_RAW_SAFE_TEXT",
        retrievalHint: null,
        safeText: "User: The fourth trip covered a total of 1,200 miles.\n\nAssistant: Noted.",
        sourceChatId: "chat-selected",
        supportingEvidence: [],
        supportingItemId: "parent-1"
      }]
    });
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const snapshot = await repository.snapshot({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const selected = fuseMemoryRetrievalCandidates(plan, [{
      candidates: [floorCandidate(
        "selected",
        "HISTORY_RECALL_LEXICAL_UNICODE",
        "HISTORY",
        1
      )],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }], now);

    const completion = await repository.completeSessionEvidence(
      snapshot,
      plan,
      selected
    );

    expect(completion.sourceChatCount).toBe(1);
    expect(completion.candidates).toEqual([expect.objectContaining({
      entryId: null,
      itemId: "round-1",
      itemType: "RECALL_ROUND",
      matchedSegmentId: null,
      metadata: expect.objectContaining({
        evidenceRootHash: "a".repeat(64),
        sourceChatId: "chat-selected"
      }),
      selectionReason: expect.stringContaining("aggregation_session_completion")
    })]);
    const expansions = await repository.expand(snapshot, plan, completion.candidates);
    expect(expansions).toEqual([expect.objectContaining({
      itemId: "round-1",
      projectionKind: "RECALL_ROUND_RAW_SAFE_TEXT",
      safeText: expect.stringContaining("1,200 miles"),
      sourceChatId: "chat-selected"
    })]);
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain('INNER JOIN "MemoryRecallRound" AS memory_round');
    expect(sql).toContain("SELECT DISTINCT ON");
    expect(sql).toContain('JOIN "MemoryRecallRoundSegment" AS segment');
    expect(sql).toContain('FROM "MemorySuppression"');
    const completionSql = mocked.laneSql.find((query) => query.includes("ranked_rounds"));
    expect(completionSql).toBeDefined();
    expect(completionSql).toContain("WITH candidate_entries AS MATERIALIZED");
    expect(completionSql).toContain('candidate_round."chatId" IN (?)');
    expect(completionSql).toContain("FROM candidate_entries AS entry");
    expect(completionSql).toContain("SELECT 1 FROM LATERAL (");
    expect(completionSql!.indexOf('candidate_round."chatId" IN (?)'))
      .toBeLessThan(completionSql!.indexOf("eligible_rounds AS MATERIALIZED"));
  });

  it("completes a targeted source with exact user-authored segment evidence", async () => {
    const plan = planMemoryRetrieval({
      currentUserText: "Which route did I choose?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const rawSafeText =
      "User: I chose the 🪵 cedar route.\n\nAssistant: I will remember it.";
    const userText = "I chose the 🪵 cedar route.";
    const start = rawSafeText.indexOf(userText);
    const mocked = mockClient(snapshotRow(), {
      completionRows: [{
        evidenceRootHash: "b".repeat(64),
        itemId: "round-user-2",
        languageCode: "en",
        matchedSegmentId: "segment-user-2",
        matchedSegmentPosition: "SINGLE",
        occurredFrom: now,
        occurredTo: new Date(now.getTime() + 60_000),
        parentChunkId: "parent-user-2",
        roundOrdinal: 1,
        safetyClass: "NORMAL",
        sourceAssistantId: null,
        sourceChatId: "chat-selected",
        sourceFolderId: null
      }]
    });
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const snapshot = await repository.snapshot({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const selected = fuseMemoryRetrievalCandidates(plan, [{
      candidates: [floorCandidate(
        "selected",
        "HISTORY_RECALL_LEXICAL_UNICODE",
        "HISTORY",
        1
      )],
      lane: "HISTORY_RECALL_LEXICAL_UNICODE"
    }], now);

    const completion = await repository.completeSessionEvidence(
      snapshot,
      plan,
      selected
    );

    expect(completion).toMatchObject({
      candidates: [expect.objectContaining({
        historyEvidenceView: "USER_TESTIMONY",
        itemId: "round-user-2",
        itemType: "RECALL_ROUND",
        matchedSegmentId: "segment-user-2",
        matchedSegmentPosition: "SINGLE",
        selectionReason: expect.stringContaining(
          "targeted_session_completion_user_evidence"
        )
      })],
      sourceChatCount: 1
    });
    mocked.setNextExpansionRows([{
      itemId: "round-user-2",
      itemType: "RECALL_ROUND",
      occurredFrom: now,
      occurredTo: new Date(now.getTime() + 60_000),
      patternSupportingEvidence: [],
      projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
      retrievalHint: null,
      safeText: rawSafeText,
      sourceChatId: "chat-selected",
      supportingEvidence: [],
      supportingItemId: "parent-user-2",
      userSpans: [{ end: start + userText.length, ordinal: 0, start }]
    }]);
    await expect(repository.expand(snapshot, plan, completion.candidates)).resolves.toEqual([
      expect.objectContaining({
        itemId: "round-user-2",
        retrievalHint: null,
        safeText: `User: ${userText}`,
        sourceChatId: "chat-selected",
        supportingEvidence: []
      })
    ]);
    const completionSql = mocked.laneSql.find((query) =>
      query.includes("ranked_user_rounds"));
    expect(completionSql).toContain('FROM "MemoryRecallRoundSegmentMessage"');
    expect(completionSql).toContain('JOIN "MemoryRecallRoundMessage"');
    expect(completionSql).toContain('segment_message."role" = \'user\'');
    expect(completionSql).toContain('WHERE "sourceOrdinal" <=');
    const expansionSql = mocked.laneSql.at(-1)!;
    expect(expansionSql).toContain('segment_message."segmentStartOffset"');
    expect(expansionSql).toContain('round_message."sourceMessageContentHash"');
    expect(expansionSql).toContain('segment_message."role" = \'user\'');
  });

  it("accepts complementary fact baseline and aggregation-history plans", async () => {
    const mocked = mockClient();
    const query = "How far did I travel across all of my road trips?";
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      baselinePlan: planMemoryRetrieval({
        currentUserText: query,
        filters: { sourceKinds: ["FACT", "EVENT"] },
        now,
        temporalIntent: "ANY"
      }),
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        aggregationRequested: true,
        currentUserText: query,
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(result.lexicalState).toBe("READY");
    expect(result.laneResults.map(({ lane }) => lane)).toEqual(expect.arrayContaining([
      "HISTORY_RECALL_EXACT",
      "HISTORY_DIGEST_FTS_SIMPLE"
    ]));
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('FROM "MemoryFactVersion" AS version');
    expect(sql).toContain('INNER JOIN "MemoryRecallChunk" AS chunk');
  });

  it("recovers planner-excluded families through bounded original-query lanes", () => {
    const baselinePlan = planMemoryRetrieval({
      currentUserText: "What is my codename and where did we discuss it?",
      now,
      temporalIntent: "ANY"
    });
    const enrichedPlan = planMemoryRetrieval({
      currentUserText: baselinePlan.originalSanitizedQuery,
      filters: { sourceKinds: ["FACT", "EVENT"] },
      now,
      semanticRewrite: "current codename",
      temporalIntent: "CURRENT"
    });
    const sharedFact = floorCandidate("shared-fact", "FACT_EXACT", "FACT", 1);
    const plannerFact = floorCandidate("planner-fact", "FACT_LEXICAL_UNICODE", "FACT", 0.8);
    const historyGold = floorCandidate(
      "history-gold",
      "HISTORY_RECALL_EXACT",
      "HISTORY",
      1
    );
    const result = applyMemorySourceFamilyRecallFloor({
      baselineLaneResults: [{
        candidates: [sharedFact],
        lane: "FACT_EXACT"
      }, {
        candidates: [historyGold],
        lane: "HISTORY_RECALL_EXACT"
      }],
      baselinePlan,
      enrichedLaneResults: [{
        candidates: [sharedFact],
        lane: "FACT_EXACT"
      }, {
        candidates: [plannerFact],
        lane: "FACT_LEXICAL_UNICODE"
      }],
      enrichedPlan,
      now
    });

    expect(result.evidence).toEqual({
      baselineFactCandidateCount: 1,
      baselineHistoryCandidateCount: 1,
      baselineOnlyCandidateCount: 1,
      plannerExcludedFamilyRecoveredCount: 1,
      plannerOnlyCandidateCount: 1
    });
    expect(result.laneResults).toEqual(expect.arrayContaining([{
      candidates: [expect.objectContaining({
        itemId: "history-gold",
        lane: "HISTORY_BASELINE_ORIGINAL"
      })],
      lane: "HISTORY_BASELINE_ORIGINAL"
    }]));
    expect(result.laneResults.flatMap(({ candidates }) => candidates)
      .filter(({ itemId }) => itemId === "shared-fact")).toHaveLength(1);
  });

  it("caps baseline facts and history after rank-only fusion", () => {
    const baselinePlan = planMemoryRetrieval({
      currentUserText: "project details",
      now,
      temporalIntent: "ANY"
    });
    const enrichedPlan = planMemoryRetrieval({
      currentUserText: "project details",
      filters: { sourceKinds: ["FACT", "EVENT"] },
      now,
      temporalIntent: "CURRENT"
    });
    const facts = Array.from({ length: 15 }, (_, index) =>
      floorCandidate(`fact-${index}`, index < 8 ? "FACT_EXACT" : "FACT_LEXICAL_UNICODE",
        "FACT", 1 - index / 100));
    const history = Array.from({ length: 25 }, (_, index) =>
      floorCandidate(`history-${index}`, index < 12
        ? "HISTORY_RECALL_EXACT"
        : "HISTORY_RECALL_LEXICAL_UNICODE", "HISTORY", 1 - index / 100));
    const result = applyMemorySourceFamilyRecallFloor({
      baselineLaneResults: [{
        candidates: facts.slice(0, 8),
        lane: "FACT_EXACT"
      }, {
        candidates: facts.slice(8),
        lane: "FACT_LEXICAL_UNICODE"
      }, {
        candidates: history.slice(0, 12),
        lane: "HISTORY_RECALL_EXACT"
      }, {
        candidates: history.slice(12),
        lane: "HISTORY_RECALL_LEXICAL_UNICODE"
      }],
      baselinePlan,
      enrichedLaneResults: [],
      enrichedPlan,
      now
    });

    expect(result.evidence).toMatchObject({
      baselineFactCandidateCount: 10,
      baselineHistoryCandidateCount: 20,
      baselineOnlyCandidateCount: 30,
      plannerExcludedFamilyRecoveredCount: 20
    });
    expect(result.laneResults.find(({ lane }) => lane === "FACT_BASELINE_ORIGINAL")
      ?.candidates).toHaveLength(10);
    expect(result.laneResults.find(({ lane }) => lane === "HISTORY_BASELINE_ORIGINAL")
      ?.candidates).toHaveLength(20);
  });

  it("balances bounded lexical terms without letting a verbose rewrite evict the original", () => {
    const plan = planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "cedar pastry",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      semanticRewrite: Array.from({ length: 80 }, (_, index) =>
        `extraordinarilyverbose${index}`).join(" "),
      temporalIntent: "ANY"
    });

    const terms = memorySemanticLexicalTerms(plan, "UNICODE");
    expect(new Set(terms.slice(0, 2)))
      .toEqual(new Set(["cedar", "pastry"]));
    expect(terms.some((term) => term.startsWith("extraordinarilyverbose")))
      .toBe(true);
    expect(terms.length).toBeGreaterThan(2);
    expect(terms.length).toBeLessThanOrEqual(64);
  });

  it("gives every bounded aggregation source one pass before preserving repeat order", () => {
    const candidates = [
      { itemId: "a-1", metadata: { sourceChatId: "source-a" } },
      { itemId: "a-2", metadata: { sourceChatId: "source-a" } },
      { itemId: "b-1", metadata: { sourceChatId: "source-b" } },
      { itemId: "a-3", metadata: { sourceChatId: "source-a" } },
      { itemId: "c-1", metadata: { sourceChatId: "source-c" } },
      { itemId: "b-2", metadata: { sourceChatId: "source-b" } }
    ];

    expect(selectMemorySourceDiverseLaneCandidates(candidates, 5)
      .map(({ itemId }) => itemId)).toEqual([
      "a-1", "b-1", "c-1", "a-2", "a-3"
    ]);
  });

  it("replaces a round representative with the complete digest-anchor chunk identity", () => {
    const representative = {
      ...sessionCandidate("round-1", "source-a", 0.8, {
        HISTORY_RECALL_VECTOR: 1
      }),
      itemType: "RECALL_ROUND" as const,
      matchedSegmentId: "round-1-middle",
      matchedSegmentPosition: "MIDDLE" as const
    };
    const digestMetadata = {
      ...representative.metadata,
      evidenceRootHash: "digest-anchor-root"
    };

    expect(projectMemoryAggregationDigestRepresentative(representative, {
      itemId: "chunk-anchor-1",
      itemType: "RECALL_CHUNK",
      metadata: digestMetadata
    })).toMatchObject({
      entryId: null,
      itemId: "chunk-anchor-1",
      itemType: "RECALL_CHUNK",
      matchedSegmentId: null,
      matchedSegmentPosition: null,
      metadata: digestMetadata,
      selectionReason: expect.stringContaining("aggregation_session_digest")
    });
  });

  it("collapses broad chunk signals to one scored representative per aggregation session", () => {
    const selected = selectMemoryAggregationSessionRepresentatives([
      sessionCandidate("a-1", "source-a", 0.4, { HISTORY_RECALL_VECTOR: 1 }),
      sessionCandidate("b-1", "source-b", 0.35, { HISTORY_RECALL_VECTOR: 2 }),
      sessionCandidate("a-2", "source-a", 0.3, { HISTORY_RECALL_LEXICAL_UNICODE: 2 }),
      sessionCandidate("a-3", "source-a", 0.2, { HISTORY_RECALL_VECTOR: 5 })
    ]);

    expect(selected.map(({ itemId }) => itemId)).toEqual(["a-1", "b-1"]);
    expect(selected[0]).toMatchObject({
      featureSnapshot: { laneCount: 2 },
      laneRanks: { HISTORY_RECALL_LEXICAL_UNICODE: 2, HISTORY_RECALL_VECTOR: 1 }
    });
    expect(selected[0]!.finalScore).toBeCloseTo(0.43);
  });

  it("bounds targeted source completion to the strongest distinct sessions", () => {
    const selected = selectMemoryTargetedSessionRepresentatives(Array.from(
      { length: 10 },
      (_, index) => sessionCandidate(
        `item-${index}`,
        `source-${index}`,
        1 - index / 20,
        { HISTORY_RECALL_VECTOR: index + 1 }
      )
    ));

    expect(selected).toHaveLength(8);
    expect(selected.map(({ itemId }) => itemId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `item-${index}`)
    );
  });

  it("pushes selected aggregation sessions into digest authority reads", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "How long did the move take?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const retrieved = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    mocked.laneSql.length = 0;

    await repository.projectAggregationSessions(retrieved.snapshot, plan, [
      sessionCandidate("round-selected", "source-selected", 0.9, {
        HISTORY_RECALL_VECTOR: 1
      })
    ]);

    expect(mocked.laneSql).toHaveLength(1);
    expect(mocked.laneSql[0]).toContain('AND (digest."chatId" IN (?))');
    expect(mocked.laneSql[0]!.indexOf('digest."chatId" IN (?)'))
      .toBeLessThan(mocked.laneSql[0]!.indexOf('digest."state" ='));
  });

  it("emits tenant-first authoritative Unicode SQL without legacy analyzers or raw content", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Когда мы обсуждали PostgreSQL в предыдущем чате?",
        now
      }),
      userId: "user-1"
    });
    expect(result.snapshot).toMatchObject({
      activeGenerationId: "generation-1",
      memoryGeneration: 2,
      memoryRevision: 4,
      status: "READY"
    });
    expect(result.vectorState).toBe("NOT_CONFIGURED");
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('entry."userId" =');
    expect(sql).toContain('scope."scopeType" = \'GLOBAL_USER\'');
    expect(sql).toContain('scope."targetIdSnapshot" IS NULL');
    expect(sql).toContain('scope."targetDisplaySnapshot" IS NULL');
    expect(sql).toContain('scope."folderId" IS NULL');
    expect(sql).toContain('scope."assistantId" IS NULL');
    expect(sql).toContain('scope."chatId" IS NULL');
    expect(sql).not.toMatch(/scope\."scopeType" = '(?:FOLDER|ASSISTANT|CHAT)'/u);
    expect(sql).toContain('version."sensitivityClass" IN (');
    expect(sql).not.toContain('version."sensitivityClass" <> \'SENSITIVE\'');
    expect(sql).not.toContain("'HIGHLY_SENSITIVE'::\"MemorySensitivityClass\"");
    expect(sql).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
    expect(sql).toContain('version."sourceMode" = \'EXPLICIT\'');
    expect(sql).toContain('"checkpoint"."branchGeneration" = "source_chat"."memoryBranchGeneration"');
    expect(sql).toContain('FROM "MemoryRecallChunkMessage" AS bounded_source_map');
    expect(sql).toContain('JOIN "MemoryRecallRoundSegment" AS segment');
    expect(sql).toContain('entry."recallRoundSegmentId"');
    expect(sql).toContain('segment."projectionVersion" =');
    expect(sql).toContain('authority_source_message."updatedAt" =');
    expect(sql).toContain(
      '"ChatMemoryCheckpointMessage" AS authority_checkpoint_message'
    );
    expect(sql).toContain('source_chat."projectId" IS NULL');
    expect(sql).toContain('chunk."chunkingVersion" =');
    expect(sql).toContain('chunk."sourceProjectionVersion" =');
    expect(sql).toContain("'SENSITIVE'::\"MemoryDerivedSafetyClass\"");
    expect(sql).toContain('negative_feedback."feedbackType" = \'NOT_USEFUL\'');
    expect(sql).toContain('negative_run."chatId" =');
    expect(sql).toContain('feedback_retraction."retractsFeedbackId" = negative_feedback."id"');
    expect(result.snapshot.historyAuthorityRevision).toBe(4);
    expect(sql).toContain('"MemorySourceBarrier"');
    expect(sql).toContain("plainto_tsquery('simple'");
    expect(sql).toContain("unnest(");
    expect(sql).toContain("candidate_matches AS MATERIALIZED");
    expect(sql).toContain("ranked_entry_matches AS MATERIALIZED");
    expect(sql).toContain('PARTITION BY candidate_matches."variantOrdinal"');
    expect(sql).toContain('"rankWithinVariant" <=');
    expect(sql).toContain('candidate_matches."maximumMatchedTermLength" DESC');
    expect(sql).toContain('candidate_matches."matchedTermCount" DESC');
    expect(sql).not.toContain("whole_query");
    expect(sql).toContain('<% entry."normalizedSearchText"');
    expect(sql).not.toMatch(/plainto_tsquery\('(?:english|russian)'/u);
    expect(sql).not.toMatch(/aiqsa_memory_transliterate_ru|trigramSearchText/u);
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).not.toContain('message."content"');
    expect(sql).not.toContain('attachment."extractedText"');
  });

  it("never admits injected lexical provider hits without the canonical hash rejoin", async () => {
    const safeContentHash = "a".repeat(64);
    const canonicalRow = {
      ...floorMetadata("provider-hit", "HISTORY"),
      deterministicMatch: null,
      displayText: null,
      entryId: "entry-provider-hit",
      itemId: "provider-hit",
      itemType: "RECALL_CHUNK",
      matchedSegmentId: null,
      matchedSegmentPosition: null,
      parentChunkId: null,
      rawScore: 0.75,
      safeContentHash,
      structuredValue: null
    };
    const requests: unknown[] = [];
    const preparations: unknown[] = [];
    const providerForLane: MemoryLexicalProviderForLane = (lane) => ({
      backend: "POSTGRES",
      async prepare(request) {
        preparations.push(request);
      },
      async search(request) {
        requests.push(request);
        const ngram = lane.endsWith("_NGRAM");
        const matchMode = ngram ? "NGRAM" as const : "UNICODE" as const;
        return {
          candidates: [{
            backendScore: 0.75,
            matchedTermCount: 1,
            matchMode,
            maximumMatchedTermLength: 2,
            rankWithinVariant: 1,
            safeContentHash,
            searchEntryId: "entry-provider-hit",
            variantOrdinal: 0
          }],
          evidence: {
            backend: "POSTGRES",
            durationMs: 1,
            failureCode: null,
            fallbackUsed: ngram,
            lane,
            matchMode,
            opaqueId: null,
            projectionCaughtUp: true,
            projectionEventLag: null,
            projectionRevisionLag: null,
            projectionVisibleAgeMs: null,
            rawCandidateCount: 1,
            requestedLimit: request.finalLimit,
            timedOut: false
          }
        };
      }
    });
    const run = async (canonicalRows: readonly Record<string, unknown>[]) => {
      const mocked = mockClient(snapshotRow(), { lexicalCanonicalRows: canonicalRows });
      const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client, {
        lexicalCandidateProviderForLane: providerForLane
      }).retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({
          currentUserText: "東京",
          filters: { sourceKinds: ["HISTORY"] },
          mode: "PAST_CHAT_SEARCH",
          now,
          temporalIntent: "ANY"
        }),
        userId: "user-1"
      });
      return { mocked, result };
    };

    const rejected = await run([]);
    expect(rejected.result.laneResults.find(({ lane }) =>
      lane === "HISTORY_RECALL_LEXICAL_UNICODE")?.candidates).toEqual([]);
    expect(rejected.result.lexicalEvidence.find(({ lane }) =>
      lane === "HISTORY_RECALL_LEXICAL_UNICODE")).toMatchObject({
      canonicalAcceptedCount: 0,
      rawCandidateCount: 1
    });

    const accepted = await run([canonicalRow]);
    expect(accepted.result.laneResults.find(({ lane }) =>
      lane === "HISTORY_RECALL_LEXICAL_UNICODE")?.candidates).toEqual([
      expect.objectContaining({
        entryId: "entry-provider-hit",
        itemId: "provider-hit",
        rawScore: 0.75
      })
    ]);
    const rejoinSql = accepted.mocked.laneSql.find((sql) =>
      sql.includes("lexical_raw_candidates"));
    expect(rejoinSql).toContain("candidate_entries AS MATERIALIZED");
    expect(rejoinSql).not.toContain("SELECT entry.*");
    expect(rejoinSql).not.toContain('entry."embedding"');
    expect(rejoinSql).not.toContain('entry."normalizedSearchText"');
    expect(rejoinSql).not.toContain('entry."searchVectorSimple"');
    expect(rejoinSql).toContain(
      'entry."safeContentHash" = lexical_candidate."safeContentHash"'
    );
    expect(rejoinSql!.match(/FROM LATERAL \(/gu)).toHaveLength(4);
    expect(rejoinSql).toContain("AS bounded_source_map");
    expect(rejoinSql!.match(/FROM candidate_entries AS entry/gu)).toHaveLength(3);
    expect(rejoinSql).toContain('entry."indexGenerationId"');
    expect(requests).toHaveLength(3);
    expect(preparations).toHaveLength(2);
    const scopedRequests = requests as MemoryLexicalSearchRequest[];
    const scopedPreparations = preparations as MemoryLexicalSearchRequest[];
    expect(scopedRequests[0]).toMatchObject({
      activeGenerationId: "generation-1",
      itemFamily: "HISTORY",
      userId: "user-1",
      variants: [{
        logicalTerms: [{ characterLength: 2, ordinal: 0, value: "東京" }],
        normalizedText: "東京",
        ordinal: 0
      }]
    });
    expect(scopedRequests[0]).not.toHaveProperty("sourceChatIds");
    expect(scopedRequests.map(({ candidateLimitPerVariant }) =>
      candidateLimitPerVariant)).toEqual([60, 160, 60]);
    expect(scopedRequests.every((request) =>
      typeof request[memoryLexicalProjectionReadinessScope] === "object"
    )).toBe(true);
    expect(new Set(scopedRequests.map((request) =>
      request[memoryLexicalProjectionReadinessScope]
    )).size).toBe(2);
    expect(new Set(scopedPreparations.map((request) =>
      request[memoryLexicalProjectionReadinessScope]
    ))).toEqual(new Set(scopedRequests.map((request) =>
      request[memoryLexicalProjectionReadinessScope]
    )));
    expect(JSON.stringify(scopedRequests[0])).not.toMatch(
      /englishTerms|russianTerms|hasLatin|hasCyrillic/u
    );
    expect(JSON.stringify(scopedRequests[0])).not.toContain(
      "memory-lexical-projection-readiness-scope"
    );
  });

  it("counts every canonical provider identity before applying the public lane cap", async () => {
    const canonicalRows = Array.from({ length: 31 }, (_, index) => {
      const id = `provider-hit-${index}`;
      const safeContentHash = memorySha256({ id });
      return {
        ...floorMetadata(id, "HISTORY"),
        deterministicMatch: null,
        displayText: null,
        entryId: `entry-${id}`,
        itemId: id,
        itemType: "RECALL_CHUNK",
        matchedSegmentId: null,
        matchedSegmentPosition: null,
        parentChunkId: null,
        rawScore: 1 - index / 100,
        safeContentHash,
        structuredValue: null
      };
    });
    const mocked = mockClient(snapshotRow(), { lexicalCanonicalRows: canonicalRows });
    const providerForLane: MemoryLexicalProviderForLane = (lane) => ({
      backend: "POSTGRES",
      async search(request) {
        const candidates = canonicalRows.map((row, index) => ({
          backendScore: row.rawScore,
          matchedTermCount: 1,
          matchMode: "UNICODE" as const,
          maximumMatchedTermLength: 2,
          rankWithinVariant: index + 1,
          safeContentHash: row.safeContentHash,
          searchEntryId: row.entryId,
          variantOrdinal: 0
        }));
        return {
          candidates,
          evidence: {
            backend: "POSTGRES",
            durationMs: 1,
            failureCode: null,
            fallbackUsed: false,
            lane,
            matchMode: "UNICODE",
            opaqueId: null,
            projectionCaughtUp: true,
            projectionEventLag: null,
            projectionRevisionLag: null,
            projectionVisibleAgeMs: null,
            rawCandidateCount: candidates.length,
            requestedLimit: request.finalLimit,
            timedOut: false
          }
        };
      }
    });

    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client, {
      lexicalCandidateProviderForLane: providerForLane
    }).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "東京",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(result.lexicalEvidence.find(({ lane }) =>
      lane === "HISTORY_RECALL_LEXICAL_UNICODE")).toMatchObject({
      canonicalAcceptedCount: 31,
      rawCandidateCount: 31
    });
    expect(result.laneResults.find(({ lane }) =>
      lane === "HISTORY_RECALL_LEXICAL_UNICODE")?.candidates).toHaveLength(30);
  });

  it("falls back to PostgreSQL when every OpenSearch hit fails canonical rejoin", async () => {
    const displayText = "Cedar plan";
    const structuredValue = { value: "cedar" };
    const safeContentHash = memorySha256({ displayText, structuredValue });
    const canonicalRow = {
      ...floorMetadata("provider-hit", "FACT"),
      deterministicMatch: null,
      displayText,
      entryId: "postgres-entry-1",
      itemId: "provider-hit",
      itemType: "FACT_VERSION",
      matchedSegmentId: null,
      matchedSegmentPosition: null,
      parentChunkId: null,
      rawScore: 0.75,
      safeContentHash,
      structuredValue
    };
    const breaker = new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 2
    });
    const routed = new RoutedMemoryLexicalCandidateProvider({
      breaker,
      configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
      openSearch: {
        backend: "OPENSEARCH",
        async search(request) {
          return {
            candidates: [{
              backendScore: 1,
              matchedTermCount: 1,
              matchMode: "UNICODE",
              maximumMatchedTermLength: 5,
              rankWithinVariant: 1,
              safeContentHash,
              searchEntryId: "stale-opensearch-entry",
              variantOrdinal: 0
            }],
            evidence: {
              backend: "OPENSEARCH",
              durationMs: 1,
              failureCode: null,
              fallbackUsed: false,
              lane: "FACT_LEXICAL_UNICODE",
              matchMode: "UNICODE",
              opaqueId: "opaque-cutover-request",
              projectionCaughtUp: true,
              projectionEventLag: 0,
              projectionRevisionLag: 0,
              projectionVisibleAgeMs: 1,
              rawCandidateCount: 1,
              requestedLimit: request.finalLimit,
              timedOut: false
            }
          };
        }
      },
      postgres: {
        backend: "POSTGRES",
        async search(request) {
          return {
            candidates: [{
              backendScore: 0.75,
              matchedTermCount: 1,
              matchMode: "UNICODE",
              maximumMatchedTermLength: 5,
              rankWithinVariant: 1,
              safeContentHash,
              searchEntryId: "postgres-entry-1",
              variantOrdinal: 0
            }],
            evidence: {
              backend: "POSTGRES",
              durationMs: 1,
              failureCode: null,
              fallbackUsed: false,
              lane: "FACT_LEXICAL_UNICODE",
              matchMode: "UNICODE",
              opaqueId: null,
              projectionCaughtUp: true,
              projectionEventLag: null,
              projectionRevisionLag: null,
              projectionVisibleAgeMs: null,
              rawCandidateCount: 1,
              requestedLimit: request.finalLimit,
              timedOut: false
            }
          };
        }
      }
    });
    const mocked = mockClient(snapshotRow(), {
      lexicalCanonicalRowSets: [[], [canonicalRow]],
      lexicalRejectionRows: [{
        actualGenerationId: "generation-1",
        actualSafeContentHash: "b".repeat(64),
        actualUserId: "user-1",
        expectedSafeContentHash: safeContentHash,
        searchEntryId: "stale-opensearch-entry"
      }]
    });

    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client, {
      lexicalCandidateProviderForLane: () => routed
    }).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "cedar",
        filters: { sourceKinds: ["FACT"] },
        now
      }),
      userId: "user-1"
    });

    expect(result.laneResults.find(({ lane }) =>
      lane === "FACT_LEXICAL_UNICODE")?.candidates).toEqual([
      expect.objectContaining({ entryId: "postgres-entry-1" })
    ]);
    expect(result.lexicalEvidence.find(({ lane }) =>
      lane === "FACT_LEXICAL_UNICODE")).toMatchObject({
      backend: "POSTGRES",
      canonicalAcceptedCount: 1,
      failureCode: "memory_opensearch_canonical_guard",
      fallbackUsed: true,
      rejectedHashCount: 1
    });
    expect(breaker.snapshot()).toEqual({
      consecutiveFailureCount: 1,
      state: "CLOSED"
    });
  });

  it("runs canonical fallback shadow work detached from production results", async () => {
    let releasePrimary!: () => void;
    const primaryGate = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const calls: string[] = [];
    let shadowWork: Promise<readonly MemoryLexicalShadowLaneReceipt[]> | null = null;
    const runtime: MemoryLexicalShadowRuntime = {
      providerForLane(lane) {
        return {
          backend: "OPENSEARCH",
          async search(request) {
            calls.push(lane);
            if (lane.endsWith("_UNICODE")) await primaryGate;
            const primary = lane.endsWith("_UNICODE");
            return {
              candidates: primary ? [{
                backendScore: 1,
                matchedTermCount: 1,
                matchMode: "UNICODE" as const,
                maximumMatchedTermLength: 5,
                rankWithinVariant: 1,
                safeContentHash: "a".repeat(64),
                searchEntryId: "stale-shadow-entry",
                variantOrdinal: 0
              }] : [],
              evidence: {
                backend: "OPENSEARCH",
                durationMs: 1,
                failureCode: null,
                fallbackUsed: lane.endsWith("_NGRAM"),
                lane,
                matchMode: primary ? "UNICODE" as const : null,
                opaqueId: "aiqsa-memory-shadow-test",
                projectionCaughtUp: true,
                projectionEventLag: 0,
                projectionRevisionLag: 0,
                projectionVisibleAgeMs: 1,
                rawCandidateCount: primary ? 1 : 0,
                requestedLimit: request.finalLimit,
                timedOut: false
              }
            };
          }
        };
      },
      submit({ work }) {
        shadowWork = work(Date.now() + 1_000);
        return true;
      }
    };
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }), {
      lexicalRejectionRows: [{
        actualGenerationId: "generation-1",
        actualSafeContentHash: "b".repeat(64),
        actualUserId: "user-1",
        expectedSafeContentHash: "a".repeat(64),
        searchEntryId: "stale-shadow-entry"
      }]
    });
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client, {
      lexicalShadowRuntime: runtime
    }).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "cedar plan", now }),
      userId: "user-1"
    });

    expect(calls).toEqual(["FACT_LEXICAL_UNICODE"]);
    expect(result.lexicalEvidence.every(({ backend }) => backend === "POSTGRES"))
      .toBe(true);
    expect(result.lexicalState).toBe("READY");
    releasePrimary();
    const receipts = await shadowWork!;
    expect(calls).toEqual([
      "FACT_LEXICAL_UNICODE",
      "FACT_LEXICAL_NGRAM"
    ]);
    expect(receipts.map(({ lane }) => lane)).toEqual([
      "FACT_LEXICAL_NGRAM",
      "FACT_LEXICAL_UNICODE"
    ]);
    expect(receipts.find(({ lane }) => lane === "FACT_LEXICAL_UNICODE")
      ?.openSearch).toMatchObject({
      canonicalAcceptedCount: 0,
      rawCandidateCount: 1,
      rejectedHashCount: 1
    });
    expect(JSON.stringify(receipts)).not.toContain("cedar plan");
  });

  it("classifies stale shadow identities through PostgreSQL authority", async () => {
    const rows = [
      {
        actualGenerationId: null,
        actualSafeContentHash: null,
        actualUserId: null,
        expectedSafeContentHash: "a".repeat(64),
        searchEntryId: "missing"
      },
      {
        actualGenerationId: "generation-1",
        actualSafeContentHash: "b".repeat(64),
        actualUserId: "other-user",
        expectedSafeContentHash: "b".repeat(64),
        searchEntryId: "wrong-owner"
      },
      {
        actualGenerationId: "generation-old",
        actualSafeContentHash: "c".repeat(64),
        actualUserId: "user-1",
        expectedSafeContentHash: "c".repeat(64),
        searchEntryId: "wrong-generation"
      },
      {
        actualGenerationId: "generation-1",
        actualSafeContentHash: "e".repeat(64),
        actualUserId: "user-1",
        expectedSafeContentHash: "d".repeat(64),
        searchEntryId: "stale-hash"
      },
      {
        actualGenerationId: "generation-1",
        actualSafeContentHash: "f".repeat(64),
        actualUserId: "user-1",
        expectedSafeContentHash: "f".repeat(64),
        searchEntryId: "accepted"
      }
    ];
    const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) =>
      query.strings?.join(" ").includes("set_config") ? [] : rows);
    const client = {
      $transaction: vi.fn(async (callback) => callback({ $queryRaw }))
    } as unknown as PrismaClient;
    const rawCandidates = rows.map((row, index) => ({
      backendScore: 1,
      matchedTermCount: 1,
      matchMode: "UNICODE" as const,
      maximumMatchedTermLength: 5,
      rankWithinVariant: index + 1,
      safeContentHash: row.expectedSafeContentHash,
      searchEntryId: row.searchEntryId,
      variantOrdinal: 0
    }));

    await expect(classifyMemoryLexicalCanonicalRejections({
      acceptedSearchEntryIds: ["accepted"],
      candidates: rawCandidates,
      client,
      deadlineAtMs: Date.now() + 1_000,
      snapshot: {
        activeGenerationId: "generation-1",
        userId: "user-1"
      } as MemoryLocalRetrievalSnapshot
    })).resolves.toEqual({
      rejectedAuthorityCount: 2,
      rejectedGenerationCount: 1,
      rejectedHashCount: 1
    });
  });

  it("uses targeted digests as navigation before query-aware authoritative raw selection", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Where did we discuss the PostgreSQL migration?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane))
      .toContain("HISTORY_DIGEST_FTS_SIMPLE");
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain("all_digest_navigation");
    expect(sql).toContain("matched_navigation");
    expect(sql).toContain("FROM ranked_navigation AS navigation");
    expect(sql).toContain('SELECT DISTINCT ON (navigation."sourceChatId")');
    expect(sql).toContain('navigation."searchVectorSimple"');
    expect(sql).toContain('PARTITION BY matched_navigation."variantOrdinal"');
    expect(sql).toContain('FROM digest_navigation AS eligible');
    expect(sql).toContain('eligible."rankWithinVariant"');
    expect(sql).toContain('eligible."rankScore"::double precision AS "rawScore"');
    expect(sql).not.toContain("source_anchors AS MATERIALIZED");
    expect(sql).not.toContain('navigation."sourceChatId" = eligible."sourceChatId"');
    expect(sql).not.toContain('(raw_match."matchedTermCount" > 0) DESC');
    expect(sql).not.toContain(
      'query_terms."variantOrdinal" = navigation."variantOrdinal"'
    );
    expect(sql.indexOf("matched_navigation AS MATERIALIZED")).toBeLessThan(
      sql.indexOf("\n    digest_navigation AS MATERIALIZED")
    );
    expect(sql).not.toContain('digest."safeDigestText" AS "safeText"');
  });

  it("settles digest expansion at the reader deadline without discarding ready navigation", async () => {
    const mocked = mockClient();
    const digestMetadata = floorMetadata("digest-ready", "HISTORY");
    const digestRow = {
      ...digestMetadata,
      deterministicMatch: null,
      displayText: null,
      entryId: "entry-digest-ready",
      itemId: "digest-ready",
      itemType: "RECALL_CHUNK",
      matchedSegmentId: null,
      matchedSegmentPosition: null,
      parentChunkId: null,
      rawScore: 1,
      safeContentHash: null,
      sourceChatId: "source-chat-ready",
      structuredValue: null
    };
    let digestReady = false;
    let digestExpansionStarted = false;
    let snapshotReads = 0;
    mocked.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("?") ?? "";
      if (sql.includes('owner."status"')) {
        snapshotReads += 1;
        return snapshotReads === 1 ? [snapshotRow()] : new Promise<never>(() => undefined);
      }
      if (sql.includes("digest_navigation")) {
        digestReady = true;
        return [digestRow];
      }
      if (sql.includes("source_filtered_history")) {
        digestExpansionStarted = true;
        return new Promise<never>(() => undefined);
      }
      if (digestReady) return [];
      return [];
    });
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const controller = new AbortController();
    const plan = planMemoryRetrieval({
      currentUserText: "Where did we discuss the migration?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const input = {
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    } as const;
    const sourceSnapshot = await repository.snapshot(input);
    const pending = repository.retrieveSpeculativeBaseline({
      ...input,
      sourceSnapshot
    }, controller.signal);

    await vi.waitFor(() => expect(digestExpansionStarted).toBe(true));
    controller.abort({ code: "test_reader_deadline" });
    const result = await Promise.race([
      pending,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250))
    ]);

    expect(result).not.toBe("timeout");
    if (result === "timeout") throw new Error("memory_reader_settlement_timed_out");
    expect(result.laneResults).toEqual(expect.arrayContaining([{
      candidates: [expect.objectContaining({ itemId: "digest-ready" })],
      lane: "HISTORY_DIGEST_FTS_SIMPLE"
    }]));
    expect(snapshotReads).toBe(1);
  });

  it("routes tool observations through the episodic history family only", async () => {
    const historyMock = mockClient();
    const historyResult = await createPrismaLocalMemoryRetrievalRepository(
      historyMock.client
    ).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Which file did the tool create?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(historyResult.laneResults.some(({ lane }) =>
      lane.startsWith("HISTORY_"))).toBe(true);
    const historySql = historyMock.laneSql.join("\n");
    expect(historySql).toContain('"MemoryToolEvent" AS tool_event');
    expect(historySql).not.toContain(
      'entry."suppressionIdentitySnapshot" ='
    );

    const factEventMock = mockClient();
    const factEventResult = await createPrismaLocalMemoryRetrievalRepository(
      factEventMock.client
    ).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Which saved event happened?",
        filters: { sourceKinds: ["EVENT"] },
        mode: "TARGETED_CURRENT",
        now,
        temporalIntent: "CURRENT"
      }),
      userId: "user-1"
    });

    expect(factEventResult.laneResults.every(({ lane }) =>
      lane.startsWith("FACT_"))).toBe(true);
    expect(factEventMock.laneSql.join("\n"))
      .not.toContain('"MemoryToolEvent" AS tool_event');
  });

  it("fuses intra-chat raw lanes once per evidence root and enforces chat quotas", () => {
    const candidate = (
      id: string,
      lane: MemoryLaneCandidate["lane"],
      sourceChatId: string
    ): MemoryLaneCandidate => ({
      ...floorCandidate(id, lane, "HISTORY", 1),
      metadata: {
        ...floorMetadata(id, "HISTORY"),
        sourceChatId
      }
    });
    const sharedFts = candidate("shared", "HISTORY_RECALL_LEXICAL_UNICODE", "chat-a");
    const sharedExact = candidate("shared", "HISTORY_RECALL_EXACT", "chat-a");
    const result = selectMemoryIntraChatRawCandidates({
      excludedEvidenceRoots: ["history:chat-a:excluded"],
      laneResults: [{
        candidates: [
          sharedExact,
          candidate("a-2", "HISTORY_RECALL_EXACT", "chat-a"),
          candidate("b-1", "HISTORY_RECALL_EXACT", "chat-b")
        ],
        lane: "HISTORY_RECALL_EXACT"
      }, {
        candidates: [
          sharedFts,
          candidate("excluded", "HISTORY_RECALL_LEXICAL_UNICODE", "chat-a"),
          candidate("a-3", "HISTORY_RECALL_LEXICAL_UNICODE", "chat-a"),
          candidate("a-4", "HISTORY_RECALL_LEXICAL_UNICODE", "chat-a"),
          candidate("b-2", "HISTORY_RECALL_LEXICAL_UNICODE", "chat-b")
        ],
        lane: "HISTORY_RECALL_LEXICAL_UNICODE"
      }],
      perChatLimit: 3,
      selectedSourceChatIds: ["chat-a", "chat-b"]
    });

    expect(result.rawCandidateCount).toBe(7);
    expect(result.candidates.filter(({ metadata }) =>
      metadata.sourceChatId === "chat-a")).toHaveLength(3);
    expect(result.candidates.filter(({ itemId }) => itemId === "shared")).toHaveLength(1);
    expect(result.candidates.map(({ itemId }) => itemId)).not.toContain("excluded");
    expect(result.candidates.every(({ lane }) =>
      lane === "HISTORY_INTRA_CHAT_RAW")).toBe(true);
  });

  it("expands a contextual round hit only to bounded authoritative raw evidence", async () => {
    const mocked = mockClient(snapshotRow({
      generationRoundSegmentProjectionVersion: null
    }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({
      currentUserText: "What did we select?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const retrieved = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const base = sessionCandidate(
      "round-1",
      "source-chat-1",
      0.8,
      { HISTORY_RECALL_VECTOR: 1 }
    );
    mocked.setNextExpansionRows([{
      itemId: "round-1",
      itemType: "RECALL_ROUND",
      occurredFrom: new Date("2026-08-09T10:00:00.000Z"),
      occurredTo: new Date("2026-08-09T10:01:00.000Z"),
      projectionKind: "RECALL_ROUND_RAW_SAFE_TEXT",
      retrievalHint: null,
      safeText: "User: We selected cedar.\n\nAssistant: Acknowledged.",
      sourceChatId: "source-chat-1",
      supportingEvidence: [],
      supportingItemId: "parent-chunk-1"
    }]);

    await expect(repository.expand(retrieved.snapshot, plan, [{
      ...base,
      itemType: "RECALL_ROUND"
    }])).resolves.toEqual([{
      itemId: "round-1",
      itemType: "RECALL_ROUND",
      occurredFrom: new Date("2026-08-09T10:00:00.000Z"),
      occurredTo: new Date("2026-08-09T10:01:00.000Z"),
      projectionKind: "RECALL_ROUND_RAW_SAFE_TEXT",
      retrievalHint: null,
      safeText: "User: We selected cedar.\n\nAssistant: Acknowledged.",
      sourceChatId: "source-chat-1",
      supportingEvidence: [],
      supportingItemId: "parent-chunk-1"
    }]);
    const expansionSql = mocked.$queryRaw.mock.calls.at(-1)?.[0]
      .strings?.join("?") ?? "";
    expect(expansionSql).toContain("WITH candidate_entries AS MATERIALIZED");
    expect(expansionSql).toContain('entry."recallRoundId" IN (?)');
    expect(expansionSql).toContain("FROM candidate_entries AS entry");
    expect(expansionSql).toContain("SELECT 1 FROM LATERAL (");
    expect(expansionSql).toContain('round."rawSafeText"');
    expect(expansionSql).toContain('round."parentChunkId" AS "supportingItemId"');
    expect(expansionSql).not.toContain('round."contextualNarrativeText" AS "safeText"');
  });

  it("expands a PATTERN with three distinct direct source projections", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({
      currentUserText: "What recurring workflow do I follow?",
      filters: { sourceKinds: ["FACT"] },
      includePatterns: true,
      now
    });
    const retrieved = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const base = sessionCandidate("pattern-1", "unused-chat", 0.8, { FACT_VECTOR: 1 });
    const candidate: MemoryRankedCandidate = {
      ...base,
      itemType: "FACT_VERSION",
      metadata: {
        ...floorMetadata("pattern-1", "FACT"),
        directness: "INFERRED",
        modality: "PATTERN",
        sourceAuthority: "SYNTHESIS",
        sourceChatId: null,
        sourceMode: "AUTOMATIC",
        synthesisDepth: 1
      }
    };
    const patternSupportingEvidence = Array.from({ length: 3 }, (_, index) => ({
      itemId: `source-version-${index + 1}`,
      observedAt: `2026-08-${10 + index}T10:00:00.000Z`,
      safeText: `The user directly described workflow occurrence ${index + 1}.`,
      sourceAuthority: "DIRECT_AUTOMATIC",
      sourceChatId: `source-chat-${index + 1}`,
      sourceRootHash: String(index + 1).repeat(64)
    }));
    mocked.setNextExpansionRows([{
      itemId: "pattern-1",
      itemType: "FACT_VERSION",
      occurredFrom: null,
      occurredTo: null,
      patternSupportingEvidence,
      projectionKind: "FACT_DISPLAY_TEXT",
      retrievalHint: null,
      safeText: "The user tends to follow a recurring workflow.",
      sourceChatId: null,
      supportingEvidence: [],
      supportingItemId: null
    }]);

    await expect(repository.expand(retrieved.snapshot, plan, [candidate]))
      .resolves.toMatchObject([{
        itemId: "pattern-1",
        patternSupportingEvidence: patternSupportingEvidence.map((support) => ({
          ...support,
          observedAt: new Date(support.observedAt)
        }))
      }]);
    const expansionSql = mocked.$queryRaw.mock.calls.at(-1)?.[0]
      .strings?.join("?") ?? "";
    expect(expansionSql).toContain('FROM "MemoryFactVersionRelation" AS relation');
    expect(expansionSql).toContain('PARTITION BY support_source."sourceRootHash"');
    expect(expansionSql).toContain('AS "patternSupportingEvidence"');
    expect(expansionSql).toContain('support."messageId"');
  });

  it("expands a segment hit to the exact private child selected for its public round", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({
      currentUserText: "What happened in the middle of the rehearsal?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const retrieved = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const base = sessionCandidate(
      "round-segment-1",
      "source-chat-1",
      0.8,
      { HISTORY_RECALL_VECTOR: 1 }
    );
    const expansion = {
      itemId: "round-segment-1",
      itemType: "RECALL_ROUND",
      occurredFrom: new Date("2026-08-09T10:00:00.000Z"),
      occurredTo: new Date("2026-08-09T10:01:00.000Z"),
      projectionKind: "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT",
      retrievalHint: null,
      safeText: "Assistant: The middle-only fact is cedar-47.",
      sourceChatId: "source-chat-1",
      supportingEvidence: [],
      supportingItemId: "parent-chunk-1"
    } as const;
    mocked.setNextExpansionRows([expansion]);

    await expect(repository.expand(retrieved.snapshot, plan, [{
      ...base,
      itemType: "RECALL_ROUND",
      matchedSegmentId: "private-segment-middle",
      matchedSegmentPosition: "MIDDLE"
    }])).resolves.toEqual([expansion]);
    const expansionSql = mocked.$queryRaw.mock.calls.at(-1)?.[0]
      .strings?.join("?") ?? "";
    expect(expansionSql).toContain("WITH candidate_entries AS MATERIALIZED");
    expect(expansionSql).toContain(
      '(entry."recallRoundId", entry."recallRoundSegmentId") IN ('
    );
    expect(expansionSql).toContain("FROM candidate_entries AS entry");
    expect(expansionSql).toContain("SELECT 1 FROM LATERAL (");
    expect(expansionSql).toContain('segment."rawSafeText" AS "safeText"');
    expect(expansionSql).toContain('selected."segmentId" = eligible."matchedSegmentId"');
    expect(expansionSql).toContain('segment."id" = eligible."matchedSegmentId"');
    expect(expansionSql).not.toContain('segment."contextualSearchText" AS "safeText"');
  });

  it("runs candidate lanes for generic and recognizable-secret direct input", async () => {
    for (const currentUserText of [
      "What is PostgreSQL?",
      "What is my API key: sk-abcdefghijklmnopqrstuvwxyz123456?"
    ]) {
      const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
      const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
      const result = await repository.retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText, now }),
        userId: "user-1"
      });
      expect(result.laneResults.map(({ lane }) => lane)).toEqual([
        "FACT_EXACT", "FACT_ENTITY", "FACT_LEXICAL_UNICODE",
        "FACT_LEXICAL_NGRAM"
      ]);
      expect(mocked.laneSql.length).toBeGreaterThan(0);
      const trigramSql = mocked.laneSql.find((sql) =>
        sql.includes("aiqsa_memory_retrieval_lane:FACT_LEXICAL_NGRAM"));
      expect(trigramSql).toBeDefined();
      expect(trigramSql!.split("query_terms AS")[0])
        .not.toContain("aiqsa_memory_transliterate_ru(");
    }
  });

  it("routes mixed-script queries through one Unicode lane and bounded fallback", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Qwen3 модель Москва 2025",
        now
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual(expect.arrayContaining([
      "FACT_LEXICAL_UNICODE", "FACT_LEXICAL_NGRAM"
    ]));
    const providerSql = mocked.laneSql.filter((sql) =>
      sql.includes("aiqsa_memory_retrieval_lane:FACT_LEXICAL_"))
      .join("\n");
    expect(providerSql).toContain('entry."searchVectorSimple"');
    expect(providerSql).toContain('entry."normalizedSearchText"');
    expect(providerSql).not.toMatch(/searchVectorEnglish|searchVectorRussian/u);
    expect(providerSql).not.toMatch(/trigramSearchText|transliterate_ru/u);
  });

  it("fails stale lexical generation profiles closed before indexed lanes", async () => {
    const mocked = mockClient(snapshotRow({
      generationLanguageProfile: "UNICODE_SIMPLE_V3",
      referenceChatHistory: false
    }));
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "Qwen3 Москва", now }),
      userId: "user-1"
    });

    expect(result.snapshot).toMatchObject({
      indexMode: null,
      reason: "memory_index_unavailable",
      status: "READY"
    });
    expect(result.laneResults.map(({ lane }) => lane)).not.toEqual(expect.arrayContaining([
      "FACT_LEXICAL_UNICODE", "FACT_LEXICAL_NGRAM"
    ]));
  });

  it("accepts owner-validated encrypted entity refs at the wire maximum scale", async () => {
    const opaqueRef = `mr1.${"a".repeat(500)}`;
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        allowedEntityRefs: [opaqueRef],
        currentUserText: "Acme",
        entityMentions: [{ occurrenceIndex: 0, resolvedRef: opaqueRef, text: "Acme" }],
        now
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane)).toContain("FACT_ENTITY");
  });

  it("runs one isolated fact-only profile lane with explicit memories ordered first", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "What do you know about me?",
        filters: { sourceKinds: ["FACT", "EVENT"] },
        now,
        profileRequested: true
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual(["FACT_PROFILE"]);
    expect(mocked.laneSql).toHaveLength(1);
    const sql = mocked.laneSql[0]!;
    expect(sql).not.toContain('"MemoryRecallChunk"');
    expect(sql).not.toContain("plainto_tsquery");
    const explicitOrder = sql.indexOf('(eligible."sourceMode" = \'EXPLICIT\') DESC');
    const pinnedOrder = sql.indexOf('eligible."pinned" DESC');
    expect(explicitOrder).toBeGreaterThan(-1);
    expect(pinnedOrder).toBeGreaterThan(explicitOrder);
    expect(sql).toContain('eligible."importance" DESC');
    expect(sql).toContain('eligible."confidence" DESC');
  });

  it("uses only bounded source-bound digests for a broad history overview", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "Give me an overview of our past deployment chats.",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "HISTORY_OVERVIEW",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual([
      "HISTORY_RECALL_LEXICAL_UNICODE",
      "HISTORY_RECALL_RECENT"
    ]);
    expect(mocked.laneSql).toHaveLength(2);
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('FROM "ChatMemoryDigest" AS digest');
    expect(sql).toContain('FROM "ChatMemoryDigestChunk" AS digest_anchor');
    expect(sql).toContain('FROM "ChatMemoryDigestMessage" AS digest_source_message');
    expect(sql).toContain('digest."normalizedSafeSearchText"');
    expect(sql).not.toContain('digest."safeDigestText"');
    expect(sql).not.toContain('entry."normalizedSearchText"');
    expect(sql).not.toContain('chunk."safeProjectedText"');
    expect(sql).not.toContain('message."content"');
  });

  it("uses exact attributable chunks for explicit multi-chat aggregation", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        aggregationRequested: true,
        currentUserText: "Which project milestones did I mention across our chats?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1"
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual([
      "HISTORY_RECALL_EXACT",
      "HISTORY_DIGEST_FTS_SIMPLE",
      "HISTORY_RECALL_LEXICAL_UNICODE",
      "HISTORY_RECALL_LEXICAL_NGRAM"
    ]);
    expect(mocked.laneSql).toHaveLength(4);
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('FROM "MemorySearchEntry" AS entry');
    expect(sql).toContain('entry."normalizedSearchText"');
    expect(sql).toContain('INNER JOIN "MemoryRecallChunk" AS chunk');
    expect(sql).toContain('FROM "ChatMemoryDigest" AS digest');
    expect(sql).not.toContain('digest."safeDigestText"');
    expect(sql).not.toContain('chunk."safeProjectedText"');
    expect(sql).not.toContain('message."content"');
    const exactSql = mocked.laneSql.find((query) => query.includes("'EXACT_TEXT'::text"));
    expect(exactSql).toBeDefined();
    expect(exactSql!.trimStart().startsWith(
      "/* aiqsa_memory_retrieval_lane:HISTORY_RECALL_EXACT */"
    )).toBe(true);
    expect(exactSql).toContain("candidate_entries AS MATERIALIZED");
    expect(exactSql!.match(/entry\."normalizedSearchText" = \?/gu)).toHaveLength(1);
    expect(exactSql!.match(/FROM candidate_entries AS entry/gu)).toHaveLength(3);
    expect(exactSql!.match(/FROM "MemorySearchEntry" AS entry/gu)).toHaveLength(1);
  });

  it("keeps the raw history vector lane available for multi-chat aggregation", async () => {
    const mocked = mockClient(snapshotRow({
      generationIndexMode: "HYBRID",
      generationPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }), {
      vectorHits: [{
        distance: 0.1,
        entryId: "entry-vector-1",
        itemId: "chunk-vector-1",
        itemType: "RECALL_CHUNK",
        score: 0.9
      }]
    });
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        aggregationRequested: true,
        currentUserText: "Which deployment rehearsals did I complete across past chats?",
        filters: { sourceKinds: ["HISTORY"] },
        mode: "PAST_CHAT_SEARCH",
        now,
        temporalIntent: "ANY"
      }),
      userId: "user-1",
      vector: {
        minimumScore: 0.4,
        profile: {
          configurationFingerprint: "c".repeat(64),
          connectionId: "connection-1",
          dimension: 1_024,
          generationId: "generation-1",
          minimumSimilarity: 0.55,
          providerModelId: "model-1",
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      }
    });

    expect(result.laneResults.map(({ lane }) => lane)).toEqual([
      "HISTORY_RECALL_EXACT",
      "HISTORY_DIGEST_FTS_SIMPLE",
      "HISTORY_RECALL_LEXICAL_UNICODE",
      "HISTORY_RECALL_LEXICAL_NGRAM",
      "HISTORY_RECALL_VECTOR"
    ]);
    expect(result.vectorState).toBe("READY");
    const vectorSql = mocked.laneSql.find((query) =>
      query.includes("vector_raw_candidates"));
    expect(vectorSql).toBeDefined();
    expect(vectorSql).toContain("candidate_entries AS MATERIALIZED");
    expect(vectorSql).toContain(
      'vector_candidate."searchEntryId" = eligible."entryId"'
    );
    expect(vectorSql!.match(/FROM candidate_entries AS entry/gu)).toHaveLength(3);
    expect(vectorSql).not.toContain('CASE eligible."entryId"');
    expect(vectorSql).not.toContain('entry."id" IN');
  });

  it("executes no sparse SQL in the speculative dense branch", async () => {
    const mocked = mockClient(snapshotRow({
      generationIndexMode: "HYBRID",
      generationPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }), {
      vectorHits: [{
        distance: 0.1,
        entryId: "entry-vector-1",
        itemId: "chunk-vector-1",
        itemType: "RECALL_CHUNK",
        score: 0.9
      }]
    });
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({
      aggregationRequested: true,
      currentUserText: "Which deployment rehearsals did I complete?",
      filters: { sourceKinds: ["HISTORY"] },
      mode: "PAST_CHAT_SEARCH",
      now,
      temporalIntent: "ANY"
    });
    const snapshot = await repository.snapshot({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });

    const result = await repository.retrieveSpeculativeDense({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      sourceSnapshot: snapshot,
      userId: "user-1",
      vector: {
        minimumScore: 0.4,
        profile: {
          configurationFingerprint: "c".repeat(64),
          connectionId: "connection-1",
          dimension: 1_024,
          generationId: "generation-1",
          minimumSimilarity: 0.55,
          providerModelId: "model-1",
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      }
    });

    expect(result.lexicalState).toBe("DISABLED");
    expect(result.vectorState).toBe("READY");
    expect(result.laneResults.map(({ lane }) => lane)).toEqual([
      "HISTORY_RECALL_VECTOR"
    ]);
    expect(mocked.laneSql).toHaveLength(1);
    expect(mocked.laneSql[0]).toContain(
      "aiqsa_memory_retrieval_lane:HISTORY_RECALL_VECTOR"
    );
  });

  it("loads query-independent response preferences only when the plan admits them", async () => {
    for (const applyResponsePreferences of [false, true]) {
      const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
      const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
      await repository.retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({
          applyResponsePreferences,
          currentUserText: "How should this answer be formatted?",
          ...(applyResponsePreferences ? { filters: { sourceKinds: [] } } : {}),
          now
        }),
        userId: "user-1"
      });
      const coreReads = mocked.laneSql.filter((sql) =>
        sql.includes('version."coreEligible" = TRUE'));
      expect(coreReads).toHaveLength(applyResponsePreferences ? 1 : 0);
      if (applyResponsePreferences) {
        expect(coreReads[0]).toContain("'SENSITIVE'::\"MemorySensitivityClass\"");
        expect(coreReads[0]).not.toContain("'SECRET'::\"MemorySensitivityClass\"");
        expect(mocked.laneSql).toHaveLength(1);
      }
    }
  });

  it("rejects an empty dynamic-lane plan without response-preference admission", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const ordinary = planMemoryRetrieval({ currentUserText: "answer", now });
    await expect(repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: {
        ...ordinary,
        filters: { ...ordinary.filters, sourceKinds: [] }
      },
      userId: "user-1"
    })).rejects.toThrow("memory_retrieval_plan_invalid");
    expect(mocked.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a query bundle without its unrestricted temporal fallback", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const ordinary = planMemoryRetrieval({ currentUserText: "answer", now });

    await expect(repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: { ...ordinary, temporalQueryVariants: [] },
      userId: "user-1"
    })).rejects.toThrow("memory_retrieval_plan_invalid");
    expect(mocked.$queryRaw).not.toHaveBeenCalled();
  });

  it("creates a bounded hard temporal lane plus a time-unrestricted fallback", async () => {
    const mocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "2026-08-09",
        now,
        timeZone: "UTC"
      }),
      userId: "user-1"
    });
    const lanes = result.laneResults.map(({ lane }) => lane);
    expect(lanes).toContain("FACT_TEMPORAL_FILTERED");
    expect(lanes).toContain("FACT_TEMPORAL_UNRESTRICTED");
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('eligible."occurredAt"');
    expect(sql).toContain("CASE WHEN");
    expect(sql).toContain("IS NOT NULL AND TRUE");
    expect(sql).toMatch(/IS NOT NULL AND \(\(.+>/su);
    expect(sql).toContain('0.0::double precision AS "rawScore"');
    expect(sql).toMatch(/ORDER BY COALESCE\(.+\) DESC, eligible\."itemId"/su);
    expect(sql).not.toContain('message."content"');
  });

  it("keeps explicit numeric dates filtered and ambiguous dates non-excluding", async () => {
    const explicitMocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const explicit = await createPrismaLocalMemoryRetrievalRepository(
      explicitMocked.client
    )
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText: "2026-02-10", now }),
        userId: "user-1"
      });
    expect(explicit.laneResults.map(({ lane }) => lane)).toEqual(expect.arrayContaining([
      "FACT_TEMPORAL_FILTERED",
      "FACT_TEMPORAL_UNRESTRICTED"
    ]));
    expect((explicitMocked.laneSql.join("\n").match(/IS NOT NULL AND TRUE/gu) ?? [])
      .length)
      .toBe(1);

    const ambiguousMocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const ambiguous = await createPrismaLocalMemoryRetrievalRepository(ambiguousMocked.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText: "03/04/2025", now }),
        userId: "user-1"
      });
    expect(ambiguous.laneResults.map(({ lane }) => lane)
      .some((lane) => lane.includes("TEMPORAL"))).toBe(false);
  });

  it("adds a bounded recent lane only for an explicit System-plan recency request", async () => {
    const withoutRecency = mockClient(snapshotRow({ referenceChatHistory: false }));
    const ordinary = await createPrismaLocalMemoryRetrievalRepository(withoutRecency.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText: "project update", now }),
        userId: "user-1"
      });
    expect(ordinary.laneResults.map(({ lane }) => lane)).not.toContain("FACT_RECENT");
    expect(withoutRecency.laneSql.join("\n")).not.toContain(
      'version."systemFrom" DESC'
    );

    const withRecency = mockClient(snapshotRow({ referenceChatHistory: false }));
    const recent = await createPrismaLocalMemoryRetrievalRepository(withRecency.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({
          currentUserText: "project update",
          now,
          recencyRequested: true
        }),
        userId: "user-1"
      });
    expect(recent.laneResults.map(({ lane }) => lane)).toContain("FACT_RECENT");
    expect(withRecency.laneSql.join("\n")).toContain("EXTRACT(EPOCH FROM");
  });

  it("disables every read for Temporary chats before querying lanes", async () => {
    const mocked = mockClient(snapshotRow({ chatMemoryMode: "TEMPORARY" }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    await expect(repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "What is my preferred editor?", now }),
      userId: "user-1"
    })).resolves.toMatchObject({
      laneResults: [],
      snapshot: { reason: "temporary_chat", status: "DISABLED" }
    });
    expect(mocked.laneSql).toEqual([]);
  });

  it("keeps lexical lanes available when the local vector lane degrades", async () => {
    const mocked = mockClient(snapshotRow({
      generationIndexMode: "HYBRID",
      generationPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }));
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const result = await repository.retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "What is my preferred editor?", now }),
      userId: "user-1",
      vector: {
        minimumScore: 0.4,
        profile: {
          configurationFingerprint: "c".repeat(64),
          connectionId: "connection-1",
          dimension: 1_024,
          generationId: "generation-1",
          minimumSimilarity: 0.55,
          providerModelId: "model-1",
          retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
          vectorSpaceFingerprint: "d".repeat(64)
        },
        vector: Array.from({ length: 1_024 }, (_, index) => index === 0 ? 1 : 0)
      }
    });
    expect(result.vectorState).toBe("DEGRADED");
    expect(result.laneResults.some((lane) => lane.lane === "FACT_LEXICAL_UNICODE")).toBe(true);
  });

  it("returns explicit failed-lane evidence instead of rejecting the whole retrieval", async () => {
    const mocked = mockClient(snapshotRow(), {
      laneFailure: new Error("private database detail")
    });
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({
        currentUserText: "What did we discuss in the previous chat?",
        now
      }),
      userId: "user-1"
    });

    expect(result.lexicalState).toBe("FAILED");
    expect(result.lexicalFailures.length).toBeGreaterThan(0);
    expect(result.laneResults.every(({ candidates }) => candidates.length === 0)).toBe(true);
    expect(result.lexicalEvidence.length).toBeGreaterThan(0);
    expect(result.lexicalEvidence.every((entry) =>
      entry.backend === "POSTGRES" &&
      entry.failureCode === "memory_lexical_lane_unavailable" &&
      entry.timedOut === false)).toBe(true);
    expect(JSON.stringify(result.lexicalEvidence)).not.toContain("private database detail");
  });

  it("emits only bounded content-free PostgreSQL lexical evidence", async () => {
    const result = await createPrismaLocalMemoryRetrievalRepository(mockClient().client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "private cedar phrase", now }),
      userId: "user-1"
    });

    expect(result.lexicalEvidence.length).toBeGreaterThan(0);
    expect(result.lexicalEvidence.every((entry) =>
      Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0 &&
      entry.durationMs <= 60_000 &&
      Number.isSafeInteger(entry.requestedLimit) && entry.requestedLimit > 0 &&
      entry.rawCandidateCount >= entry.canonicalAcceptedCount &&
      entry.projectionCaughtUp === true)).toBe(true);
    expect(Object.keys(result.lexicalEvidence[0] ?? {}).sort()).toEqual([
      "backend",
      "canonicalAcceptedCount",
      "durationMs",
      "failureCode",
      "fallbackUsed",
      "lane",
      "matchMode",
      "opaqueId",
      "projectionCaughtUp",
      "projectionEventLag",
      "projectionRevisionLag",
      "projectionVisibleAgeMs",
      "rawCandidateCount",
      "rejectedAuthorityCount",
      "rejectedGenerationCount",
      "rejectedHashCount",
      "requestedLimit",
      "timedOut"
    ].sort());
    const serialized = JSON.stringify(result.lexicalEvidence);
    expect(serialized).not.toContain("private cedar phrase");
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain("chat-1");
  });

  it("degrades timed-out lexical lanes without rejecting the ordinary read", async () => {
    const mocked = mockClient(snapshotRow(), {
      laneFailure: new MemoryReadBudgetError("memory_read_statement_timeout")
    });
    const result = await createPrismaLocalMemoryRetrievalRepository(mocked.client).retrieve({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan: planMemoryRetrieval({ currentUserText: "project details", now }),
      userId: "user-1"
    });

    expect(result.lexicalState).toBe("FAILED");
    expect(result.lexicalEvidence.length).toBeGreaterThan(0);
    expect(result.lexicalEvidence.every((entry) =>
      entry.failureCode === "memory_read_statement_timeout" && entry.timedOut)).toBe(true);
  });

  it("issues a frozen O(1) snapshot capability over every authority scalar", async () => {
    const mocked = mockClient();
    const repository = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const plan = planMemoryRetrieval({ currentUserText: "project details", now });
    const snapshot = await repository.snapshot({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.historyAuthorityRevision).toBe(4);
    const replacements = {
      activeGenerationId: "forged-generation",
      assistantId: "forged-assistant",
      chatId: "forged-chat",
      chatMemoryMode: "EXCLUDED",
      contextualKeyPolicyVersion: "forged-context",
      decayEnabled: true,
      decayPolicyVersion: "forged-decay",
      folderId: "forged-folder",
      historyAuthorityRevision: 999,
      indexMode: "HYBRID",
      memoryGeneration: 999,
      memoryRevision: 999,
      reason: "forged-reason",
      referenceChatHistory: false,
      repositoryVersion: "forged-repository",
      roundProjectionVersion: "forged-round",
      roundSegmentProjectionVersion: "forged-segment",
      settingsRevision: 999,
      status: "UNAVAILABLE",
      useMemoryFacts: false,
      userId: "forged-user"
    } as const;
    for (const [key, replacement] of Object.entries(replacements)) {
      const original = snapshot[key as keyof typeof snapshot];
      expect(Reflect.set(snapshot, key, replacement)).toBe(false);
      expect(snapshot[key as keyof typeof snapshot]).toBe(original);
    }
    expect(mocked.client.memorySourceBarrier.findMany).not.toHaveBeenCalled();
    expect(mocked.client.memoryPauseInterval.findMany).not.toHaveBeenCalled();
    expect(mocked.client.memorySuppression.findMany).not.toHaveBeenCalled();
  });

  it("rejects copied and foreign snapshots while reusing the exact issued capability", async () => {
    const mocked = mockClient();
    const plan = planMemoryRetrieval({
      currentUserText: "project details",
      now,
      temporalIntent: "ANY"
    });
    const enriched = planMemoryRetrieval({
      currentUserText: plan.originalSanitizedQuery,
      now,
      semanticRewrite: "project status details"
    });
    const first = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const second = createPrismaLocalMemoryRetrievalRepository(mocked.client);
    const snapshot = await first.snapshot({
      assistantId: null,
      chatId: "chat-1",
      now,
      plan,
      userId: "user-1"
    });
    const request = {
      assistantId: null,
      baselinePlan: plan,
      chatId: "chat-1",
      now,
      plan: enriched,
      userId: "user-1"
    } as const;

    await expect(first.retrieve({ ...request, sourceSnapshot: snapshot }))
      .resolves.toMatchObject({ snapshot });
    await expect(first.retrieve({ ...request, sourceSnapshot: { ...snapshot } }))
      .rejects.toThrow("memory_retrieval_source_snapshot_invalid");
    await expect(second.retrieve({ ...request, sourceSnapshot: snapshot }))
      .rejects.toThrow("memory_retrieval_source_snapshot_invalid");
  });
});
