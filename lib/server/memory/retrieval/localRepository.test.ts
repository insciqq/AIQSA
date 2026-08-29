import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  planMemoryRetrieval,
  type MemoryCandidateMetadata,
  type MemoryLaneCandidate,
  type MemoryRankedCandidate
} from "../../../domain/memory/retrieval";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../persistence/lexical";
import {
  createPrismaLocalMemoryRetrievalRepository,
  applyMemorySourceFamilyRecallFloor,
  memorySemanticLexicalTerms,
  projectMemoryAggregationDigestRepresentative,
  selectMemoryAggregationSessionRepresentatives,
  selectMemoryIntraChatRawCandidates,
  selectMemorySourceDiverseLaneCandidates
} from "./localRepository";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
} from "./vector";
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
    generationLanguageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
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
  options: Readonly<{ failLaneQueries?: boolean }> = {}
) {
  const laneSql: string[] = [];
  const $queryRaw = vi.fn(async (query: { strings?: readonly string[] }) => {
    const sql = query.strings?.join("?") ?? "";
    if (sql.includes('owner."status"')) return [row];
    laneSql.push(sql);
    if (options.failLaneQueries === true) {
      throw new Error("fts unavailable");
    }
    return [];
  });
  const client = {
    $transaction: vi.fn(async () => { throw new Error("vector unavailable"); }),
    $queryRaw,
    memoryEntityAlias: { findFirst: vi.fn(async () => {
      if (options.failLaneQueries === true) throw new Error("entity lookup unavailable");
      return null;
    }) },
    memoryPauseInterval: { findMany: vi.fn(async () => []) },
    memorySourceBarrier: { findMany: vi.fn(async () => []) },
    memorySuppression: { findMany: vi.fn(async () => []) }
  } as unknown as PrismaClient;
  return { $queryRaw, client, laneSql };
}

describe("local Memory retrieval repository", () => {
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
    const plannerFact = floorCandidate("planner-fact", "FACT_FTS_SIMPLE", "FACT", 0.8);
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
        lane: "FACT_FTS_SIMPLE"
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
      floorCandidate(`fact-${index}`, index < 8 ? "FACT_EXACT" : "FACT_FTS_SIMPLE",
        "FACT", 1 - index / 100));
    const history = Array.from({ length: 25 }, (_, index) =>
      floorCandidate(`history-${index}`, index < 12
        ? "HISTORY_RECALL_EXACT"
        : "HISTORY_RECALL_FTS_SIMPLE", "HISTORY", 1 - index / 100));
    const result = applyMemorySourceFamilyRecallFloor({
      baselineLaneResults: [{
        candidates: facts.slice(0, 8),
        lane: "FACT_EXACT"
      }, {
        candidates: facts.slice(8),
        lane: "FACT_FTS_SIMPLE"
      }, {
        candidates: history.slice(0, 12),
        lane: "HISTORY_RECALL_EXACT"
      }, {
        candidates: history.slice(12),
        lane: "HISTORY_RECALL_FTS_SIMPLE"
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

    const terms = memorySemanticLexicalTerms(plan, "SIMPLE");
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
      sessionCandidate("a-2", "source-a", 0.3, { HISTORY_RECALL_FTS_SIMPLE: 2 }),
      sessionCandidate("a-3", "source-a", 0.2, { HISTORY_RECALL_VECTOR: 5 })
    ]);

    expect(selected.map(({ itemId }) => itemId)).toEqual(["a-1", "b-1"]);
    expect(selected[0]).toMatchObject({
      featureSnapshot: { laneCount: 2 },
      laneRanks: { HISTORY_RECALL_FTS_SIMPLE: 2, HISTORY_RECALL_VECTOR: 1 }
    });
    expect(selected[0]!.finalScore).toBeCloseTo(0.43);
  });

  it("emits tenant-first authoritative FTS SQL without selecting raw message content", async () => {
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
    expect(sql).toContain('FROM "MemoryRecallChunkMessage" AS authority_source_map');
    expect(sql).toContain('JOIN "MemoryRecallRoundSegment" AS segment');
    expect(sql).toContain('entry."recallRoundSegmentId"');
    expect(sql).toContain('segment."projectionVersion" =');
    expect(sql).toContain('authority_source_message."updatedAt" <>');
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
    expect(result.snapshot.historySuppressionIdentitySnapshot).toMatch(/^[a-f0-9]{64}$/u);
    expect(sql).toContain('"MemorySourceBarrier"');
    expect(sql).toContain("plainto_tsquery('simple'");
    expect(sql).toContain("unnest(");
    expect(sql).toContain('PARTITION BY matched_variants."variantOrdinal"');
    expect(sql).toContain('eligible."rankWithinVariant"');
    expect(sql).toContain('matched_variants."maximumMatchedTermLength" DESC');
    expect(sql).toContain('matched_variants."matchedTermCount" DESC');
    expect(sql).not.toContain("whole_query");
    expect(sql).toContain("plainto_tsquery('russian'");
    expect(sql).toContain("plainto_tsquery('english'");
    expect(sql).toContain('aiqsa_memory_transliterate_ru(');
    expect(sql).toContain('<% entry."trigramSearchText"');
    expect(sql).not.toContain("websearch_to_tsquery");
    expect(sql).not.toContain('message."content"');
    expect(sql).not.toContain('attachment."extractedText"');
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
    const sharedFts = candidate("shared", "HISTORY_RECALL_FTS_SIMPLE", "chat-a");
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
          candidate("excluded", "HISTORY_RECALL_FTS_SIMPLE", "chat-a"),
          candidate("a-3", "HISTORY_RECALL_FTS_SIMPLE", "chat-a"),
          candidate("a-4", "HISTORY_RECALL_FTS_SIMPLE", "chat-a"),
          candidate("b-2", "HISTORY_RECALL_FTS_SIMPLE", "chat-b")
        ],
        lane: "HISTORY_RECALL_FTS_SIMPLE"
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
    mocked.$queryRaw.mockResolvedValueOnce([{
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
    }] as never);

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
    mocked.$queryRaw.mockResolvedValueOnce([{
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
    }] as never);

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
    mocked.$queryRaw.mockResolvedValueOnce([expansion] as never);

    await expect(repository.expand(retrieved.snapshot, plan, [{
      ...base,
      itemType: "RECALL_ROUND",
      matchedSegmentId: "private-segment-middle",
      matchedSegmentPosition: "MIDDLE"
    }])).resolves.toEqual([expansion]);
    const expansionSql = mocked.$queryRaw.mock.calls.at(-1)?.[0]
      .strings?.join("?") ?? "";
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
        "FACT_EXACT", "FACT_ENTITY", "FACT_FTS_SIMPLE",
        "FACT_FTS_ENGLISH", "FACT_TRIGRAM"
      ]);
      expect(mocked.laneSql.length).toBeGreaterThan(0);
    }
  });

  it("routes mixed-script queries through independent indexed lexical lanes", async () => {
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
      "FACT_FTS_SIMPLE", "FACT_FTS_ENGLISH", "FACT_FTS_RUSSIAN", "FACT_TRIGRAM"
    ]));
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('entry."searchVectorSimple"');
    expect(sql).toContain('entry."searchVectorEnglish"');
    expect(sql).toContain('entry."searchVectorRussian"');
    expect(sql).toContain('entry."trigramSearchText"');
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
      "FACT_FTS_SIMPLE", "FACT_FTS_ENGLISH", "FACT_FTS_RUSSIAN", "FACT_TRIGRAM"
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
      "HISTORY_RECALL_FTS_SIMPLE",
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
      "HISTORY_RECALL_FTS_SIMPLE",
      "HISTORY_RECALL_FTS_ENGLISH",
      "HISTORY_RECALL_TRIGRAM"
    ]);
    expect(mocked.laneSql).toHaveLength(5);
    const sql = mocked.laneSql.join("\n");
    expect(sql).toContain('FROM "MemorySearchEntry" AS entry');
    expect(sql).toContain('entry."normalizedSearchText"');
    expect(sql).toContain('INNER JOIN "MemoryRecallChunk" AS chunk');
    expect(sql).toContain('FROM "ChatMemoryDigest" AS digest');
    expect(sql).not.toContain('digest."safeDigestText"');
    expect(sql).not.toContain('chunk."safeProjectedText"');
    expect(sql).not.toContain('message."content"');
  });

  it("keeps the raw history vector lane available for multi-chat aggregation", async () => {
    const mocked = mockClient(snapshotRow({
      generationIndexMode: "HYBRID",
      generationPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    }));
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
      "HISTORY_RECALL_FTS_SIMPLE",
      "HISTORY_RECALL_FTS_ENGLISH",
      "HISTORY_RECALL_TRIGRAM",
      "HISTORY_RECALL_VECTOR"
    ]);
    expect(result.vectorState).toBe("DEGRADED");
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
        currentUserText: "What happened yesterday?",
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

  it("keeps medium and ambiguous temporal interpretations non-excluding", async () => {
    const mediumMocked = mockClient(snapshotRow({ referenceChatHistory: false }));
    const medium = await createPrismaLocalMemoryRetrievalRepository(mediumMocked.client)
      .retrieve({
        assistantId: null,
        chatId: "chat-1",
        now,
        plan: planMemoryRetrieval({ currentUserText: "on February 10", now }),
        userId: "user-1"
      });
    expect(medium.laneResults.map(({ lane }) => lane)).toEqual(expect.arrayContaining([
      "FACT_TEMPORAL_FILTERED",
      "FACT_TEMPORAL_UNRESTRICTED"
    ]));
    expect((mediumMocked.laneSql.join("\n").match(/IS NOT NULL AND TRUE/gu) ?? []).length)
      .toBeGreaterThanOrEqual(2);

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
    expect(result.laneResults.some((lane) => lane.lane === "FACT_FTS_SIMPLE")).toBe(true);
  });

  it("returns explicit failed-lane evidence instead of rejecting the whole retrieval", async () => {
    const mocked = mockClient(snapshotRow(), { failLaneQueries: true });
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
  });
});
