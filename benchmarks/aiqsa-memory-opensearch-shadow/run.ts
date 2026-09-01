import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  memorySha256,
  normalizeMemorySearchText
} from "../../lib/server/memory/persistence/lexical";
import {
  hasAcceptedCompleteMemoryLexicalVariant,
  type MemoryLexicalRawCandidate,
  type MemoryLexicalSearchRequest
} from "../../lib/server/memory/retrieval/lexical/contract";
import {
  OpenSearchMemoryLexicalCandidateProvider
} from "../../lib/server/memory/retrieval/lexical/opensearchProvider";
import {
  PostgresUnicodeMemoryLexicalCandidateProvider
} from "../../lib/server/memory/retrieval/lexical/postgresUnicodeProvider";
import {
  MemoryLexicalCircuitBreaker,
  RoutedMemoryLexicalCandidateProvider
} from "../../lib/server/memory/retrieval/lexical/cutover";
import {
  createKnowledgeOpenSearchTransport
} from "../../lib/server/search/opensearch/transport";
import {
  StrictMemoryOpenSearchClient,
  type MemoryOpenSearchClient
} from "../../lib/server/search/opensearch/memoryClient";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchDocument,
  type MemoryOpenSearchMutation
} from "../../lib/server/search/opensearch/memoryContract";
import {
  MEMORY_OPENSEARCH_SHADOW_CORPUS,
  MEMORY_OPENSEARCH_SHADOW_CORPUS_FINGERPRINT,
  MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION,
  MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS,
  qualificationAdditiveOverlapReview,
  qualificationJaccard,
  qualificationPercentile,
  qualificationSignedPercentile,
  type MemoryOpenSearchShadowCase,
  type MemoryOpenSearchShadowCohort,
  type MemoryOpenSearchShadowDocument
} from "./contract";

const LOAD_CORPUS_SIZES = Object.freeze([32, 512, 2_048, 5_000]);
const INDEX_BATCH_SIZE = 100;
const DATABASE_BATCH_SIZE = 250;
const SEARCH_ITERATIONS = 12;
const ISOLATION_SEARCHES = 32;
const ISOLATION_CONCURRENCY_PER_WORKLOAD = 6;

type FixtureDocument = Readonly<{
  chatId: string;
  entryId: string;
  generationId: string;
  hash: string;
  key: string;
  normalizedText: string;
  userId: string;
}>;

type OwnerFixture = Readonly<{
  documents: readonly FixtureDocument[];
  generationId: string;
  primaryChatId: string;
  secondaryChatId: string;
  userId: string;
}>;

type SearchExecution = Readonly<{
  candidates: readonly MemoryLexicalRawCandidate[];
  durationMs: number;
}>;

type CaseObservation = Readonly<{
  baselineContained: boolean;
  baselineNonEmpty: boolean;
  cohort: MemoryOpenSearchShadowCohort;
  expectedModeMatched: boolean;
  firstRelevantReciprocalRankDelta: number;
  highVolume: boolean;
  jaccard: number;
  key: string;
  openSearchRelevantRank: number | null;
  postgresDurationMs: number;
  postgresRelevantRank: number | null;
  relevantFound: boolean;
  top10BaselineContained: boolean;
}>;

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function exactDisposableDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return /^\/aiqsa_memory_shadow_qualification_[a-z0-9_]{1,40}$/u.test(
      parsed.pathname
    );
  } catch {
    return false;
  }
}

function qualificationEnvironment(): NodeJS.ProcessEnv {
  if (process.env.AIQSA_STATEFUL_TEST_TARGET !== "DISPOSABLE" ||
    !exactDisposableDatabase(process.env.DATABASE_URL)) {
    throw new Error("memory_shadow_qualification_requires_disposable_database");
  }
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return {
    ...process.env,
    AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID: `qual-${suffix}`,
    AIQSA_MEMORY_OPENSEARCH_READ_ALIAS: `aiqsa-memory-qual-${suffix}-read`,
    AIQSA_MEMORY_OPENSEARCH_WRITE_ALIAS: `aiqsa-memory-qual-${suffix}-write`,
    NODE_ENV: "test"
  };
}

function request(input: Readonly<{
  candidateLimit?: number;
  generationId: string;
  sourceChatIds?: readonly string[];
  terms: readonly string[];
  userId: string;
  variants?: readonly (readonly string[])[];
}>): MemoryLexicalSearchRequest {
  const variants = input.variants ?? [input.terms];
  return Object.freeze({
    activeGenerationId: input.generationId,
    analysisProfileVersion: MEMORY_LEXICAL_ANALYSIS_PROFILE,
    candidateLimitPerVariant: input.candidateLimit ?? 50,
    deadlineAtMs: Date.now() + 5_000,
    finalLimit: 10,
    itemFamily: "HISTORY" as const,
    memoryRevisionSnapshot: 0,
    ...(input.sourceChatIds
      ? { sourceChatIds: Object.freeze([...input.sourceChatIds]) }
      : {}),
    userId: input.userId,
    variants: Object.freeze(variants.map((terms, variantOrdinal) => {
      const normalizedTerms = terms.map((term) => term.normalize("NFKC"));
      return Object.freeze({
        logicalTerms: Object.freeze(normalizedTerms.map((value, ordinal) =>
          Object.freeze({
            characterLength: Array.from(value).length,
            ordinal,
            value
          }))),
        normalizedText: normalizedTerms.join(" ").normalize("NFKC"),
        ordinal: variantOrdinal
      });
    }))
  });
}

function mergedLexicalCandidates(
  primary: readonly MemoryLexicalRawCandidate[],
  fallback: readonly MemoryLexicalRawCandidate[]
): readonly MemoryLexicalRawCandidate[] {
  const merged = new Map<string, MemoryLexicalRawCandidate>();
  for (const candidate of [...primary, ...fallback]) {
    const key = `${candidate.searchEntryId}\u0000${candidate.variantOrdinal}`;
    if (!merged.has(key)) merged.set(key, candidate);
  }
  return Object.freeze([...merged.values()]);
}

async function searchPostgres(
  prisma: PrismaClient,
  searchRequest: MemoryLexicalSearchRequest
): Promise<SearchExecution> {
  const primary = new PostgresUnicodeMemoryLexicalCandidateProvider(
    prisma,
    "HISTORY_RECALL_LEXICAL_UNICODE"
  );
  const fallback = new PostgresUnicodeMemoryLexicalCandidateProvider(
    prisma,
    "HISTORY_RECALL_LEXICAL_NGRAM"
  );
  const startedAt = performance.now();
  const primaryResult = await primary.search(searchRequest);
  const fallbackResult = !hasAcceptedCompleteMemoryLexicalVariant({
    acceptedSearchEntryIds: primaryResult.candidates.map(({ searchEntryId }) =>
      searchEntryId),
    candidates: primaryResult.candidates,
    request: searchRequest
  })
    ? await fallback.search({ ...searchRequest, deadlineAtMs: Date.now() + 5_000 })
    : null;
  return Object.freeze({
    candidates: mergedLexicalCandidates(
      primaryResult.candidates,
      fallbackResult?.candidates ?? []
    ),
    durationMs: Math.max(0, performance.now() - startedAt)
  });
}

async function searchOpenSearch(
  client: MemoryOpenSearchClient,
  searchRequest: MemoryLexicalSearchRequest
): Promise<SearchExecution> {
  const startedAt = performance.now();
  const primary = await client.searchLexical({
    phase: "PRIMARY",
    request: searchRequest
  });
  const fallback = !hasAcceptedCompleteMemoryLexicalVariant({
    acceptedSearchEntryIds: primary.candidates.map(({ searchEntryId }) => searchEntryId),
    candidates: primary.candidates,
    request: searchRequest
  })
    ? await client.searchLexical({
        phase: "FALLBACK",
        request: { ...searchRequest, deadlineAtMs: Date.now() + 5_000 }
      })
    : null;
  return Object.freeze({
    candidates: mergedLexicalCandidates(primary.candidates, fallback?.candidates ?? []),
    durationMs: Math.max(0, performance.now() - startedAt)
  });
}

async function createOwner(input: Readonly<{
  documents: readonly Readonly<{ chat: "PRIMARY" | "SECONDARY"; key: string;
    text: string }>[];
  label: string;
  prisma: PrismaClient;
}>): Promise<OwnerFixture> {
  const userId = randomUUID();
  const generationId = randomUUID();
  const primaryChatId = randomUUID();
  const secondaryChatId = randomUUID();
  const now = new Date("2026-08-31T00:00:00.000Z");
  await input.prisma.user.create({
    data: {
      displayName: `Shadow qualification ${input.label}`,
      id: userId,
      status: "active"
    }
  });
  await input.prisma.chat.createMany({ data: [{
    createdByDisplayName: "Shadow qualification",
    createdByUserId: userId,
    id: primaryChatId,
    title: "Shadow qualification primary",
    userId
  }, {
    createdByDisplayName: "Shadow qualification",
    createdByUserId: userId,
    id: secondaryChatId,
    title: "Shadow qualification secondary",
    userId
  }] });
  await input.prisma.memoryIndexGeneration.create({
    data: {
      chunkingVersion: "memory-shadow-qualification-v1",
      generation: 1,
      id: generationId,
      indexMode: "LEXICAL_ONLY",
      indexedThroughMemoryRevision: 0,
      languageProfile: MEMORY_LEXICAL_ANALYSIS_PROFILE,
      normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
      readyAt: now,
      retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
      state: "READY",
      targetMemoryRevision: 0,
      userId
    }
  });
  await input.prisma.$transaction(async (tx) => {
    await tx.userMemorySettings.update({
      data: { activeIndexGenerationId: generationId },
      where: { userId }
    });
    await tx.memoryIndexGeneration.update({
      data: { activatedAt: now, state: "ACTIVE" },
      where: { id: generationId }
    });
  });

  const ordinals = new Map<string, number>();
  const documents = input.documents.map((definition) => {
    const chatId = definition.chat === "PRIMARY"
      ? primaryChatId
      : secondaryChatId;
    const ordinal = ordinals.get(chatId) ?? 0;
    ordinals.set(chatId, ordinal + 1);
    const normalizedText = normalizeMemorySearchText(definition.text);
    const hash = memorySha256({
      key: definition.key,
      normalizedText,
      qualification: MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION,
      userId
    });
    return Object.freeze({
      chatId,
      chunkId: randomUUID(),
      entryId: randomUUID(),
      generationId,
      hash,
      key: definition.key,
      normalizedText,
      ordinal,
      userId
    });
  });
  for (const batch of chunks(documents, DATABASE_BATCH_SIZE)) {
    await input.prisma.memoryRecallChunk.createMany({ data: batch.map((entry) => ({
      branchGeneration: 0,
      chatId: entry.chatId,
      chunkOrdinal: entry.ordinal,
      chunkingVersion: "memory-shadow-qualification-v1",
      contentHash: entry.hash,
      id: entry.chunkId,
      languageCode: "und",
      normalizedSafeSearchText: entry.normalizedText,
      occurredFrom: now,
      occurredTo: now,
      redactionState: "NOT_NEEDED",
      safeProjectedText: entry.normalizedText,
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-shadow-qualification-v1",
      sourceRevisionAtCreation: 0,
      userId
    })) });
    await input.prisma.memorySearchEntry.createMany({ data: batch.map((entry) => ({
      embeddingState: "NOT_APPLICABLE",
      id: entry.entryId,
      indexGenerationId: generationId,
      itemType: "RECALL_CHUNK",
      languageCode: "und",
      normalizedSearchText: entry.normalizedText,
      recallChunkId: entry.chunkId,
      safeContentHash: entry.hash,
      safetyIdentitySnapshot: memorySha256({ safety: entry.hash }),
      sourceIdentitySnapshot: memorySha256({ source: entry.chunkId }),
      suppressionIdentitySnapshot: memorySha256({ suppression: entry.hash }),
      userId
    })) });
  }
  return Object.freeze({
    documents: Object.freeze(documents.map((entry) => Object.freeze({
      chatId: entry.chatId,
      entryId: entry.entryId,
      generationId,
      hash: entry.hash,
      key: entry.key,
      normalizedText: entry.normalizedText,
      userId
    }))),
    generationId,
    primaryChatId,
    secondaryChatId,
    userId
  });
}

function loadDocuments(label: string, size: number) {
  const width = String(Math.max(0, size - 1)).length;
  return Object.freeze(Array.from({ length: size }, (_, index) => ({
    chat: "PRIMARY" as const,
    key: `${label}-${String(index).padStart(width, "0")}`,
    text: `qualification ${label} loadanchor${label} archive${
      String(index % 97).padStart(2, "0")
    } shard${index % 17}`
  })));
}

async function indexOwners(input: Readonly<{
  client: MemoryOpenSearchClient;
  configuration: ReturnType<typeof memoryOpenSearchConfigurationFromEnv>;
  owners: readonly OwnerFixture[];
}>): Promise<number> {
  let sequence = 0n;
  const mutations: MemoryOpenSearchMutation[] = [];
  for (const owner of input.owners) {
    const routing = memoryOpenSearchUserScope(owner.userId, input.configuration);
    for (const entry of owner.documents) {
      sequence += 1n;
      const document: MemoryOpenSearchDocument = Object.freeze({
        analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
        generationId: owner.generationId,
        itemType: "RECALL_CHUNK",
        lexicalText: entry.normalizedText,
        mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
        normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
        projectionSequence: sequence,
        retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
        safeContentHash: entry.hash,
        searchEntryId: entry.entryId,
        sourceChatId: entry.chatId,
        userScope: routing
      });
      mutations.push(Object.freeze({
        document,
        operation: "UPSERT",
        routing,
        sequence
      }));
    }
  }
  for (const batch of chunks(mutations, INDEX_BATCH_SIZE)) {
    await input.client.applyMutations(batch, "NONE");
  }
  await input.client.refreshIndex();
  return Number(sequence);
}

function fixtureEntry(owner: OwnerFixture, key: string): FixtureDocument {
  const found = owner.documents.find((entry) => entry.key === key);
  if (!found) throw new Error("memory_shadow_qualification_fixture_invalid");
  return found;
}

async function observeCase(input: Readonly<{
  corpusCase: MemoryOpenSearchShadowCase;
  client: MemoryOpenSearchClient;
  owner: OwnerFixture;
  prisma: PrismaClient;
}>): Promise<CaseObservation> {
  const expected = fixtureEntry(input.owner, input.corpusCase.expectedDocumentKey);
  const searchRequest = request({
    generationId: input.owner.generationId,
    ...(input.corpusCase.sourceScope === "SECONDARY"
      ? { sourceChatIds: [input.owner.secondaryChatId] }
      : {}),
    terms: input.corpusCase.terms,
    userId: input.owner.userId
  });
  const [postgres, openSearch] = await Promise.all([
    searchPostgres(input.prisma, searchRequest),
    searchOpenSearch(input.client, searchRequest)
  ]);
  const postgresTop = postgres.candidates.slice(0, 10).map(({ searchEntryId }) =>
    searchEntryId);
  const openSearchTop = openSearch.candidates.slice(0, 50)
    .map(({ searchEntryId }) => searchEntryId);
  const baselineContained = postgresTop.every((id) => openSearchTop.includes(id));
  const openSearchTop10 = openSearchTop.slice(0, 10);
  const openSearchIndex = openSearch.candidates.findIndex(({ searchEntryId }) =>
    searchEntryId === expected.entryId);
  const postgresIndex = postgres.candidates.findIndex(({ searchEntryId }) =>
    searchEntryId === expected.entryId);
  const relevant = openSearchIndex < 0 ? null : openSearch.candidates[openSearchIndex]!;
  return Object.freeze({
    baselineContained,
    baselineNonEmpty: postgresTop.length > 0,
    cohort: input.corpusCase.cohort,
    expectedModeMatched: relevant?.matchMode === input.corpusCase.expectedMode,
    firstRelevantReciprocalRankDelta:
      (openSearchIndex < 0 ? 0 : 1 / (openSearchIndex + 1)) -
      (postgresIndex < 0 ? 0 : 1 / (postgresIndex + 1)),
    highVolume: input.corpusCase.highVolume,
    jaccard: qualificationJaccard(postgresTop, openSearchTop10),
    key: input.corpusCase.key,
    openSearchRelevantRank: openSearchIndex < 0 ? null : openSearchIndex + 1,
    postgresDurationMs: postgres.durationMs,
    postgresRelevantRank: postgresIndex < 0 ? null : postgresIndex + 1,
    relevantFound: openSearchIndex >= 0,
    top10BaselineContained: postgresTop.every((id) => openSearchTop10.includes(id))
  });
}

function cohortReport(observations: readonly CaseObservation[]) {
  return MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS.map((cohort) => {
    const rows = observations.filter((observation) => observation.cohort === cohort);
    const baselineRows = rows.filter(({ baselineNonEmpty }) => baselineNonEmpty);
    const firstRelevantReciprocalRankDeltas = rows.map(
      ({ firstRelevantReciprocalRankDelta }) => firstRelevantReciprocalRankDelta
    );
    const top10JaccardMedian = qualificationPercentile(
      rows.map(({ jaccard }) => jaccard),
      0.5
    );
    const additiveReview = top10JaccardMedian < 0.85 &&
      qualificationAdditiveOverlapReview({
        firstRelevantReciprocalRankDeltas,
        top10BaselineContained: rows.map(({ top10BaselineContained }) =>
          top10BaselineContained)
      });
    return Object.freeze({
      baselineContainmentRate: baselineRows.length === 0
        ? null
        : baselineRows.filter(({ baselineContained }) => baselineContained).length /
          baselineRows.length,
      caseCount: rows.length,
      cohort,
      firstRelevantReciprocalRankDeltaMinimum: Math.min(
        ...firstRelevantReciprocalRankDeltas
      ),
      rankOverlapReview: additiveReview
        ? "ADDITIVE_NO_BASELINE_OR_RELEVANT_RANK_REGRESSION" as const
        : null,
      relevantRecall: rows.filter(({ relevantFound }) => relevantFound).length /
        rows.length,
      top10BaselineContainmentRate: rows.filter(({ top10BaselineContained }) =>
        top10BaselineContained).length / rows.length,
      top10JaccardMedian
    });
  });
}

async function markProjectionReady(input: Readonly<{
  client: MemoryOpenSearchClient;
  configuration: ReturnType<typeof memoryOpenSearchConfigurationFromEnv>;
  owner: OwnerFixture;
  prisma: PrismaClient;
}>): Promise<void> {
  const routing = memoryOpenSearchUserScope(input.owner.userId, input.configuration);
  const visible = await input.client.inspectGeneration({
    generationId: input.owner.generationId,
    routing,
    userScope: routing
  });
  const now = new Date();
  await input.prisma.memoryLexicalProjectionEvent.updateMany({
    data: {
      completedAt: now,
      errorCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: null,
      state: "SUCCEEDED",
      updatedAt: now
    },
    where: { userId: input.owner.userId }
  });
  const state = await input.prisma.memoryLexicalProjectionState.findUniqueOrThrow({
    where: { userId_indexGenerationId: {
      indexGenerationId: input.owner.generationId,
      userId: input.owner.userId
    } }
  });
  await input.prisma.memoryLexicalProjectionState.update({
    data: {
      analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
      backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
      expectedContentFingerprint: visible.fingerprint,
      expectedDocumentCount: visible.documentCount,
      lastErrorCode: null,
      lastIntegrityCheckAt: now,
      lastSuccessfulRefreshAt: now,
      mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
      normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
      projectedThroughRevision: 0,
      projectionFingerprint: memoryOpenSearchProjectionFingerprint(
        input.configuration
      ),
      readyAt: now,
      retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
      status: "READY",
      targetMemoryRevision: 0,
      visibleContentFingerprint: visible.fingerprint,
      visibleDocumentCount: visible.documentCount,
      visibleThroughSequence: state.enqueuedThroughSequence
    },
    where: { id: state.id }
  });
}

async function createAdditionalDocuments(input: Readonly<{
  definitions: readonly Readonly<{ chat: "PRIMARY" | "SECONDARY"; key: string;
    text: string }>[];
  owner: OwnerFixture;
  prisma: PrismaClient;
}>): Promise<readonly FixtureDocument[]> {
  const now = new Date();
  const current = await input.prisma.memoryRecallChunk.count({
    where: { chatId: input.owner.primaryChatId, userId: input.owner.userId }
  });
  const created = input.definitions.map((definition, index) => {
    const chatId = definition.chat === "PRIMARY"
      ? input.owner.primaryChatId
      : input.owner.secondaryChatId;
    const normalizedText = normalizeMemorySearchText(definition.text);
    const hash = memorySha256({
      key: definition.key,
      normalizedText,
      qualification: MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION,
      userId: input.owner.userId
    });
    return Object.freeze({
      chatId,
      chunkId: randomUUID(),
      entryId: randomUUID(),
      generationId: input.owner.generationId,
      hash,
      key: definition.key,
      normalizedText,
      ordinal: current + index,
      userId: input.owner.userId
    });
  });
  await input.prisma.memoryRecallChunk.createMany({ data: created.map((entry) => ({
    branchGeneration: 0,
    chatId: entry.chatId,
    chunkOrdinal: entry.ordinal,
    chunkingVersion: "memory-shadow-qualification-v1",
    contentHash: entry.hash,
    id: entry.chunkId,
    languageCode: "und",
    normalizedSafeSearchText: entry.normalizedText,
    occurredFrom: now,
    occurredTo: now,
    redactionState: "NOT_NEEDED",
    safeProjectedText: entry.normalizedText,
    safetyClass: "NORMAL",
    sourceProjectionVersion: "memory-shadow-qualification-v1",
    sourceRevisionAtCreation: 0,
    userId: entry.userId
  })) });
  await input.prisma.memorySearchEntry.createMany({ data: created.map((entry) => ({
    embeddingState: "NOT_APPLICABLE",
    id: entry.entryId,
    indexGenerationId: entry.generationId,
    itemType: "RECALL_CHUNK",
    languageCode: "und",
    normalizedSearchText: entry.normalizedText,
    recallChunkId: entry.chunkId,
    safeContentHash: entry.hash,
    safetyIdentitySnapshot: memorySha256({ safety: entry.hash }),
    sourceIdentitySnapshot: memorySha256({ source: entry.chunkId }),
    suppressionIdentitySnapshot: memorySha256({ suppression: entry.hash }),
    userId: entry.userId
  })) });
  return Object.freeze(created.map((entry) => Object.freeze({
    chatId: entry.chatId,
    entryId: entry.entryId,
    generationId: entry.generationId,
    hash: entry.hash,
    key: entry.key,
    normalizedText: entry.normalizedText,
    userId: entry.userId
  })));
}

async function freshnessQualification(input: Readonly<{
  client: MemoryOpenSearchClient;
  configuration: ReturnType<typeof memoryOpenSearchConfigurationFromEnv>;
  env: NodeJS.ProcessEnv;
  nextSequence: bigint;
  owner: OwnerFixture;
  prisma: PrismaClient;
}>) {
  await markProjectionReady(input);
  const provider = new OpenSearchMemoryLexicalCandidateProvider(
    input.prisma,
    "HISTORY_RECALL_LEXICAL_UNICODE",
    input.client,
    input.env
  );
  const dirtyEntry = (await createAdditionalDocuments({
    definitions: [{
      chat: "PRIMARY",
      key: "freshness-beacon",
      text: "freshnessbeacon committed memory"
    }],
    owner: input.owner,
    prisma: input.prisma
  }))[0]!;
  const searchRequest = request({
    generationId: input.owner.generationId,
    terms: ["freshnessbeacon"],
    userId: input.owner.userId
  });
  const [dirtyOpenSearch, postgres] = await Promise.all([
    provider.search(searchRequest),
    searchPostgres(input.prisma, searchRequest)
  ]);
  const postgresProvider = new PostgresUnicodeMemoryLexicalCandidateProvider(
    input.prisma,
    "HISTORY_RECALL_LEXICAL_UNICODE"
  );
  const routed = new RoutedMemoryLexicalCandidateProvider({
    breaker: new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 2
    }),
    configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
    openSearch: provider,
    postgres: postgresProvider
  });
  const dirtyRouted = await routed.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 5_000
  });
  const routing = memoryOpenSearchUserScope(input.owner.userId, input.configuration);
  const document: MemoryOpenSearchDocument = {
    analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
    generationId: input.owner.generationId,
    itemType: "RECALL_CHUNK",
    lexicalText: dirtyEntry.normalizedText,
    mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
    normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
    projectionSequence: input.nextSequence,
    retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
    safeContentHash: dirtyEntry.hash,
    searchEntryId: dirtyEntry.entryId,
    sourceChatId: dirtyEntry.chatId,
    userScope: routing
  };
  await input.client.applyMutations([{
    document,
    operation: "UPSERT",
    routing,
    sequence: input.nextSequence
  }], "WAIT_FOR");
  await markProjectionReady(input);
  const readyOpenSearch = await provider.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 5_000
  });
  const canary = new RoutedMemoryLexicalCandidateProvider({
    breaker: new MemoryLexicalCircuitBreaker({
      cooldownMs: 1_000,
      failureThreshold: 2
    }),
    configuration: { backend: "OPENSEARCH_CANARY", canaryPercent: 100 },
    openSearch: provider,
    postgres: postgresProvider,
    userScopeForUser: (userId) => memoryOpenSearchUserScope(
      userId,
      input.configuration
    )
  });
  const readyCanary = await canary.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 5_000
  });
  const outageEnv = {
    ...input.env,
    AIQSA_OPENSEARCH_URL: "http://127.0.0.1:1"
  };
  const outageProvider = new OpenSearchMemoryLexicalCandidateProvider(
    input.prisma,
    "HISTORY_RECALL_LEXICAL_UNICODE",
    new StrictMemoryOpenSearchClient(outageEnv),
    outageEnv
  );
  const outage = await outageProvider.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 1_000
  });
  const outageRouted = new RoutedMemoryLexicalCandidateProvider({
    breaker: new MemoryLexicalCircuitBreaker({
      cooldownMs: 5_000,
      failureThreshold: 1
    }),
    configuration: { backend: "OPENSEARCH", canaryPercent: 1 },
    openSearch: outageProvider,
    postgres: postgresProvider
  });
  const outageFallback = await outageRouted.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 1_000
  });
  const circuitFallback = await outageRouted.search({
    ...searchRequest,
    deadlineAtMs: Date.now() + 1_000
  });
  return Object.freeze({
    canarySelectedOpenSearch: readyCanary.evidence.backend === "OPENSEARCH" &&
      readyCanary.candidates.some(({ searchEntryId }) =>
        searchEntryId === dirtyEntry.entryId),
    circuitSkippedToPostgres: circuitFallback.evidence.backend === "POSTGRES" &&
      circuitFallback.evidence.failureCode === "memory_opensearch_circuit_open" &&
      circuitFallback.candidates.some(({ searchEntryId }) =>
        searchEntryId === dirtyEntry.entryId),
    dirtyAutomaticPostgresFallback:
      dirtyRouted.evidence.backend === "POSTGRES" &&
      dirtyRouted.evidence.fallbackUsed &&
      dirtyRouted.evidence.failureCode ===
        "memory_lexical_projection_not_ready" &&
      dirtyRouted.candidates.some(({ searchEntryId }) =>
        searchEntryId === dirtyEntry.entryId),
    dirtyFallbackCandidatePresent: postgres.candidates.some(({ searchEntryId }) =>
      searchEntryId === dirtyEntry.entryId),
    dirtyProjectionRejected: dirtyOpenSearch.candidates.length === 0 &&
      dirtyOpenSearch.evidence.failureCode ===
        "memory_lexical_projection_not_ready",
    outageFailedClosed: outage.candidates.length === 0 &&
      outage.evidence.failureCode === "memory_opensearch_connection_failed",
    outageRoutedToPostgres: outageFallback.evidence.backend === "POSTGRES" &&
      outageFallback.evidence.fallbackUsed &&
      outageFallback.evidence.failureCode ===
        "memory_opensearch_connection_failed" &&
      outageFallback.candidates.some(({ searchEntryId }) =>
        searchEntryId === dirtyEntry.entryId),
    readyProjectionFoundFreshItem: readyOpenSearch.candidates.some(
      ({ searchEntryId }) => searchEntryId === dirtyEntry.entryId
    )
  });
}

async function runBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number
): Promise<Readonly<{ durations: readonly number[]; errors: number;
  values: readonly T[] }>> {
  let next = 0;
  let errors = 0;
  const durations: number[] = [];
  const values: T[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) return;
      const startedAt = performance.now();
      try {
        values.push(await task());
      } catch {
        errors += 1;
      } finally {
        durations.push(Math.max(0, performance.now() - startedAt));
      }
    }
  }));
  return Object.freeze({
    durations: Object.freeze(durations),
    errors,
    values: Object.freeze(values)
  });
}

async function loadQualification(input: Readonly<{
  client: MemoryOpenSearchClient;
  knowledge: ReturnType<typeof createKnowledgeOpenSearchTransport>;
  loadOwners: readonly OwnerFixture[];
  prisma: PrismaClient;
}>) {
  const rows = [];
  for (const [index, owner] of input.loadOwners.entries()) {
    const label = `size${LOAD_CORPUS_SIZES[index]}`;
    const searchRequest = request({
      generationId: owner.generationId,
      terms: [`loadanchor${label}`, "archive42"],
      userId: owner.userId
    });
    await searchPostgres(input.prisma, searchRequest);
    await searchOpenSearch(input.client, searchRequest);
    const postgresDurations: number[] = [];
    const openSearchDurations: number[] = [];
    let maximumCandidates = 0;
    for (let iteration = 0; iteration < SEARCH_ITERATIONS; iteration += 1) {
      const postgres = await searchPostgres(input.prisma, {
        ...searchRequest,
        deadlineAtMs: Date.now() + 5_000
      });
      const openSearch = await searchOpenSearch(input.client, {
        ...searchRequest,
        deadlineAtMs: Date.now() + 5_000
      });
      postgresDurations.push(postgres.durationMs);
      openSearchDurations.push(openSearch.durationMs);
      maximumCandidates = Math.max(maximumCandidates, openSearch.candidates.length);
    }
    rows.push(Object.freeze({
      maximumCandidates,
      openSearchMs: Object.freeze({
        p50: qualificationPercentile(openSearchDurations, 0.5),
        p95: qualificationPercentile(openSearchDurations, 0.95),
        p99: qualificationPercentile(openSearchDurations, 0.99)
      }),
      postgresMs: Object.freeze({
        p50: qualificationPercentile(postgresDurations, 0.5),
        p95: qualificationPercentile(postgresDurations, 0.95),
        p99: qualificationPercentile(postgresDurations, 0.99)
      }),
      size: LOAD_CORPUS_SIZES[index]!
    }));
  }

  const knowledgeArtifactId = `memory-shadow-${randomUUID()}`;
  const knowledgeOwnerId = randomUUID();
  const knowledgeDocuments = Array.from({ length: 256 }, (_, index) => ({
    body: `synthetic shared cluster knowledge anchor passage ${index}`,
    contentHash: memorySha256({ index, knowledgeArtifactId }),
    heading: "synthetic qualification",
    indexArtifactId: knowledgeArtifactId,
    layoutKind: "paragraph",
    ownerUserId: knowledgeOwnerId,
    passageId: `passage-${index}`,
    sourceVersionId: `source-${index}`,
    tableContext: ""
  }));
  await input.knowledge.bulkUpsertKnowledgeDocuments(knowledgeDocuments);
  await input.knowledge.refreshKnowledgeIndex();
  try {
    const memoryTasks = Array.from({ length: ISOLATION_SEARCHES }, (_, index) => {
      const owner = input.loadOwners[index % input.loadOwners.length]!;
      const label = `size${LOAD_CORPUS_SIZES[index % LOAD_CORPUS_SIZES.length]}`;
      return () => searchOpenSearch(input.client, request({
        generationId: owner.generationId,
        terms: [`loadanchor${label}`, "archive42"],
        userId: owner.userId
      }));
    });
    const knowledgeTasks = Array.from({ length: ISOLATION_SEARCHES }, () => () =>
      input.knowledge.searchKnowledgePassages({
        indexArtifactIds: [knowledgeArtifactId],
        ownerUserId: knowledgeOwnerId,
        queryVariants: ["synthetic shared cluster anchor"]
      }));
    const memoryStandalone = await runBounded(
      memoryTasks,
      ISOLATION_CONCURRENCY_PER_WORKLOAD
    );
    const knowledgeStandalone = await runBounded(
      knowledgeTasks,
      ISOLATION_CONCURRENCY_PER_WORKLOAD
    );
    const [memoryConcurrent, knowledgeConcurrent] = await Promise.all([
      runBounded(memoryTasks, ISOLATION_CONCURRENCY_PER_WORKLOAD),
      runBounded(knowledgeTasks, ISOLATION_CONCURRENCY_PER_WORKLOAD)
    ]);
    const p95 = (values: readonly number[]) => qualificationPercentile(values, 0.95);
    return Object.freeze({
      corpusRows: Object.freeze(rows),
      isolation: Object.freeze({
        concurrencyPerWorkload: ISOLATION_CONCURRENCY_PER_WORKLOAD,
        knowledgeConcurrentErrors: knowledgeConcurrent.errors,
        knowledgeConcurrentP95Ms: p95(knowledgeConcurrent.durations),
        knowledgeStandaloneP95Ms: p95(knowledgeStandalone.durations),
        memoryConcurrentErrors: memoryConcurrent.errors,
        memoryConcurrentP95Ms: p95(memoryConcurrent.durations),
        memoryStandaloneP95Ms: p95(memoryStandalone.durations),
        searchesPerWorkload: ISOLATION_SEARCHES
      })
    });
  } finally {
    await input.knowledge.deleteKnowledgeArtifact(knowledgeArtifactId);
  }
}

async function maximumRequestQualification(
  client: MemoryOpenSearchClient,
  owner: OwnerFixture
): Promise<boolean> {
  const terms = Array.from({ length: 64 }, (_, index) =>
    index === 0 ? "qualification" : `absentterm${index}`);
  const variants = Array.from({ length: 4 }, () => terms);
  const result = await client.searchLexical({
    phase: "PRIMARY",
    request: request({
      candidateLimit: 50,
      generationId: owner.generationId,
      terms,
      userId: owner.userId,
      variants
    })
  });
  return result.candidates.length <= 4 * 50;
}

async function deleteMemoryQualificationIndex(
  env: NodeJS.ProcessEnv,
  indexName: string
): Promise<void> {
  const root = new URL(env.AIQSA_OPENSEARCH_URL ?? "http://opensearch:9200");
  root.pathname = `${root.pathname.replace(/\/+$/u, "")}/`;
  const response = await fetch(new URL(indexName, root), { method: "DELETE" });
  if (response.status !== 200 && response.status !== 404) {
    throw new Error("memory_shadow_qualification_cleanup_failed");
  }
}

async function main(): Promise<void> {
  const env = qualificationEnvironment();
  const configuration = memoryOpenSearchConfigurationFromEnv(env);
  const client = new StrictMemoryOpenSearchClient(env);
  const knowledge = createKnowledgeOpenSearchTransport(env);
  const prisma = new PrismaClient();
  let indexCreated = false;
  try {
    await client.ensureIndex();
    indexCreated = true;
    await knowledge.ensureKnowledgeIndex();
    const corpusDefinitions: MemoryOpenSearchShadowDocument[] = [];
    for (const corpusCase of MEMORY_OPENSEARCH_SHADOW_CORPUS) {
      corpusDefinitions.push(...corpusCase.documents);
    }
    const corpusOwner = await createOwner({
      documents: corpusDefinitions,
      label: "corpus",
      prisma
    });
    const loadOwners: OwnerFixture[] = [];
    for (const size of LOAD_CORPUS_SIZES) {
      const label = `size${size}`;
      loadOwners.push(await createOwner({
        documents: loadDocuments(label, size),
        label,
        prisma
      }));
    }
    const indexedDocuments = await indexOwners({
      client,
      configuration,
      owners: [corpusOwner, ...loadOwners]
    });
    const observations: CaseObservation[] = [];
    for (const corpusCase of MEMORY_OPENSEARCH_SHADOW_CORPUS) {
      observations.push(await observeCase({
        client,
        corpusCase,
        owner: corpusOwner,
        prisma
      }));
    }
    const cohorts = cohortReport(observations);
    const baselineRows = observations.filter(({ baselineNonEmpty }) =>
      baselineNonEmpty);
    const highVolumeCohorts = cohorts.filter(({ cohort }) =>
      observations.some((row) => row.cohort === cohort && row.highVolume));
    const parity = Object.freeze({
      baselineCaseContainmentRate: baselineRows.filter(({ baselineContained }) =>
        baselineContained).length / baselineRows.length,
      baselineNonEmptyCases: baselineRows.length,
      cohorts,
      expectedModePassRate: observations.filter(({ expectedModeMatched }) =>
        expectedModeMatched).length / observations.length,
      firstRelevantReciprocalRankDeltaMedian: qualificationSignedPercentile(
        observations.map(({ firstRelevantReciprocalRankDelta }) =>
          firstRelevantReciprocalRankDelta),
        0.5
      ),
      failedCaseKeys: Object.freeze(observations.filter((observation) =>
        !observation.baselineContained || !observation.relevantFound ||
        !observation.expectedModeMatched).map(({ key }) => key)),
      rankOverlapReviews: Object.freeze(cohorts
        .filter(({ rankOverlapReview }) => rankOverlapReview !== null)
        .map(({ cohort, rankOverlapReview }) => Object.freeze({
          cohort,
          disposition: rankOverlapReview
        }))),
      relevantRecall: observations.filter(({ relevantFound }) => relevantFound).length /
        observations.length,
      top10JaccardMedian: qualificationPercentile(
        observations.map(({ jaccard }) => jaccard),
        0.5
      )
    });
    const freshness = await freshnessQualification({
      client,
      configuration,
      env,
      nextSequence: BigInt(indexedDocuments + 1),
      owner: corpusOwner,
      prisma
    });
    const load = await loadQualification({
      client,
      knowledge,
      loadOwners,
      prisma
    });
    const maximumRequestPassed = await maximumRequestQualification(
      client,
      loadOwners.at(-1)!
    );
    const crossOwner = await searchOpenSearch(client, request({
      generationId: loadOwners.at(-1)!.generationId,
      terms: ["loadanchorsize5000"],
      userId: loadOwners[0]!.userId
    }));
    const authorityPassed = crossOwner.candidates.length === 0;
    const isolation = load.isolation;
    const isolationLatencyPassed =
      isolation.memoryConcurrentP95Ms <= Math.max(
        250,
        isolation.memoryStandaloneP95Ms * 5
      ) && isolation.knowledgeConcurrentP95Ms <= Math.max(
        250,
        isolation.knowledgeStandaloneP95Ms * 5
      );
    const gates = Object.freeze({
      authority: authorityPassed,
      baselineContainmentOverall: parity.baselineCaseContainmentRate >= 0.99,
      baselineContainmentPerHighVolumeCohort: highVolumeCohorts.every((cohort) =>
        cohort.baselineContainmentRate === null ||
        cohort.baselineContainmentRate >= 0.98),
      cohortRankOverlap: cohorts.every(({ rankOverlapReview, top10JaccardMedian }) =>
        top10JaccardMedian >= 0.85 || rankOverlapReview !== null),
      freshness: Object.values(freshness).every(Boolean),
      isolation: isolation.knowledgeConcurrentErrors === 0 &&
        isolation.memoryConcurrentErrors === 0 && isolationLatencyPassed,
      maximumBoundedRequest: maximumRequestPassed,
      rankOverlapMedian: parity.top10JaccardMedian >= 0.9,
      relevantRecall: parity.relevantRecall === 1,
      requestedModes: parity.expectedModePassRate === 1
    });
    const passed = Object.values(gates).every(Boolean);
    const report = Object.freeze({
      contract: Object.freeze({
        analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
        backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
        mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
        normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
        retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION
      }),
      corpus: Object.freeze({
        caseCount: MEMORY_OPENSEARCH_SHADOW_CORPUS.length,
        cohortCount: MEMORY_OPENSEARCH_SHADOW_REQUIRED_COHORTS.length,
        fingerprint: MEMORY_OPENSEARCH_SHADOW_CORPUS_FINGERPRINT,
        indexedDocuments,
        loadCorpusSizes: LOAD_CORPUS_SIZES
      }),
      freshness,
      gates,
      generatedAt: new Date().toISOString(),
      load,
      parity,
      passed,
      privacy: Object.freeze({
        contentFieldsEmitted: false,
        opaqueEntryIdentitiesEmitted: false,
        syntheticCorpusOnly: true
      }),
      version: MEMORY_OPENSEARCH_SHADOW_QUALIFICATION_VERSION
    });
    console.info(JSON.stringify(report));
    if (!passed) throw new Error("memory_shadow_qualification_gate_failed");
  } finally {
    await prisma.$disconnect();
    if (indexCreated) {
      await deleteMemoryQualificationIndex(env, configuration.physicalIndexName);
    }
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[a-z0-9_]{1,80}$/u.test(error.message)
    ? error.message
    : "memory_shadow_qualification_failed";
  console.error(code);
  process.exitCode = 1;
});
