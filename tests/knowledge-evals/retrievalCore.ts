import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { textMessageContent } from "../../lib/domain/content";
import {
  knowledgeAdaptiveVectorSearchSql,
  knowledgeVectorRetrievalBucket,
  KNOWLEDGE_VECTOR_ANN_EF_SEARCH,
  KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES
} from "../../lib/server/knowledge/prismaRetrievalCore";
import { createPrismaKnowledgeRetrievalStore } from "../../lib/server/knowledge/prismaRetrievalRepository";
import { normalizeReadSourceRequest } from "../../lib/server/knowledge/readSourceLocator";
import { buildAndPersistKnowledgeHierarchicalIndex } from "../../lib/server/knowledge/hierarchicalIndexRepository";
import type { KnowledgeChunkPlanEntry } from "../../lib/server/knowledge/chunking";
import type {
  KnowledgeAcceptedBinding,
  KnowledgeHybridSearchResult
} from "../../lib/server/knowledge/retrievalTypes";
import { knowledgeToolResultText } from "../../lib/server/knowledge/toolResult";
import { knowledgeEvalQueryVector } from "./baseline";
import {
  knowledgeEvalQueries,
  type KnowledgeEvalQuery
} from "./fixtures";
import {
  cleanupKnowledgeHierarchicalEvaluationFixture,
  createKnowledgeHierarchicalEvaluationFixture,
  persistKnowledgeHierarchicalEvaluationFixture,
  type KnowledgeHierarchicalEvaluationFixture
} from "./hierarchicalIndexes";

const now = new Date("2026-08-18T00:00:00.000Z");
const vectorSpaceFingerprint = "4".repeat(64);
const annP95LatencyGateMs = 100;
const retrievalP95LatencyGateMs = 250;

type RuntimeFixture = Readonly<{
  baseId: string;
  chunkToSource: ReadonlyMap<string, string>;
  credentialId: string;
  credentialVersionId: string;
  generationId: string;
  modelRunId: string;
  processingSourceId: string;
  processingVersionId: string;
  snapshotId: string;
}>;

type AnnBaseFixture = Readonly<{
  artifactId: string;
  baseId: string;
  generationId: string;
  profileId: string;
  profileRevisionId: string;
  rowCount: number;
  snapshotId: string;
  sourceId: string;
  targetDimension: 1_024 | 1_536;
  versionId: string;
}>;

type AnnFixture = Readonly<{
  bases: readonly AnnBaseFixture[];
  modelRunId: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

async function persistRuntimeFixtureTransaction(
  client: Prisma.TransactionClient,
  state: KnowledgeHierarchicalEvaluationFixture
): Promise<RuntimeFixture> {
  const prefix = `${state.prefix}-runtime`;
  const baseId = `${prefix}-base`;
  const generationId = `${prefix}-generation`;
  const credentialId = `${prefix}-credential`;
  const credentialVersionId = `${prefix}-credential-version`;
  const processingSourceId = `${prefix}-processing-source`;
  const processingVersionId = `${prefix}-processing-version`;
  const readyEntries = state.entries.filter((entry) =>
    entry.ownerUserId === state.ownerUserId && entry.logicalSourceId.startsWith("source-"));

  await client.providerCredential.create({
    data: {
      connectionId: state.connectionId,
      enabled: true,
      id: credentialId,
      label: `Knowledge retrieval eval credential ${state.prefix}`
    }
  });
  await client.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testEvidence: { synthetic: true },
      testedAt: now,
      version: 1
    }
  });
  await client.providerCredential.update({
    data: { activatedAt: now, activeVersionId: credentialVersionId },
    where: { id: credentialId }
  });
  await client.knowledgeBase.create({
    data: {
      contentRevision: 2,
      description: "Synthetic Stage 4 retrieval fixture",
      id: baseId,
      name: "Knowledge retrieval golden base",
      ownerUserId: state.ownerUserId
    }
  });
  await client.knowledgeIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: state.modelId,
      id: generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: baseId,
      profileRevisionId: state.profileRevisionId,
      readyAt: now,
      status: "active",
      targetDimension: 1_024,
      vectorSpaceFingerprint
    }
  });
  await client.knowledgeBase.update({
    data: { activeIndexGenerationId: generationId },
    where: { id: baseId }
  });
  await client.knowledgeBaseSource.createMany({
    data: readyEntries.map((entry) => ({
      knowledgeBaseId: baseId,
      ownerUserId: state.ownerUserId,
      sourceId: entry.sourceId
    }))
  });
  await client.knowledgeSource.create({
    data: {
      id: processingSourceId,
      name: "Still processing canary",
      ownerUserId: state.ownerUserId
    }
  });
  await client.knowledgeSourceVersion.create({
    data: {
      byteSize: 24,
      checksum: sha256("still-processing"),
      fileName: "still-processing.txt",
      id: processingVersionId,
      mimeType: "text/plain",
      ownerUserId: state.ownerUserId,
      sourceId: processingSourceId,
      versionNumber: 1
    }
  });
  await client.knowledgeSource.update({
    data: { currentVersionId: processingVersionId },
    where: { id: processingSourceId }
  });
  await client.knowledgeBaseSource.create({
    data: {
      knowledgeBaseId: baseId,
      ownerUserId: state.ownerUserId,
      sourceId: processingSourceId
    }
  });
  const logicalSourceByArtifact = new Map(readyEntries.map((entry) => [
    entry.artifactId,
    entry.logicalSourceId
  ]));
  const passages = await client.knowledgeArtifactPassageIndex.findMany({
    select: {
      id: true,
      indexArtifact: { select: { sourceArtifactId: true } }
    },
    where: {
      indexArtifact: { sourceArtifactId: { in: readyEntries.map((entry) => entry.artifactId) } }
    }
  });
  const chunkToSource = new Map(passages.flatMap((passage) => {
    const sourceId = logicalSourceByArtifact.get(passage.indexArtifact.sourceArtifactId);
    return sourceId ? [[passage.id, sourceId] as const] : [];
  }));
  const snapshotId = `${prefix}-snapshot`;
  await client.knowledgeBaseSnapshot.create({
    data: {
      evidenceFingerprint: sha256(`${snapshotId}\0${readyEntries.length}`),
      id: snapshotId,
      indexGenerationId: generationId,
      knowledgeBaseId: baseId,
      ownerUserId: state.ownerUserId,
      profileRevisionId: state.profileRevisionId,
      readySourceCount: readyEntries.length,
      sourceCount: readyEntries.length + 1,
      sourceRevision: readyEntries.length + 1
    }
  });
  await client.knowledgeBaseSnapshotSource.createMany({
    data: readyEntries.map((entry, ordinal) => ({
      artifactId: entry.artifactId,
      knowledgeBaseId: baseId,
      ordinal,
      ownerUserId: state.ownerUserId,
      snapshotId,
      sourceId: entry.sourceId,
      sourceVersionId: entry.versionId
    }))
  });
  const chat = await client.chat.create({
    data: { title: "Knowledge retrieval eval", userId: state.ownerUserId }
  });
  const message = await client.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Synthetic Stage 4 retrieval evaluation"),
      role: "user"
    }
  });
  await client.chat.update({
    data: { activeLeafMessageId: message.id },
    where: { id: chat.id }
  });
  const run = await client.modelRun.create({
    data: {
      chatId: chat.id,
      modelId: "knowledge-retrieval-eval-answer",
      normalizedRequest: {},
      provider: "fake",
      status: "in_progress",
      userId: state.ownerUserId,
      userMessageId: message.id
    }
  });
  await client.knowledgeRunBinding.create({
    data: {
      baseContentRevision: 2,
      embeddingConnectionId: state.connectionId,
      embeddingCredentialId: credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: credentialVersionId,
      embeddingExecutionSnapshot: json({ synthetic: true }),
      embeddingProviderModelId: state.modelId,
      indexGenerationId: generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: baseId,
      knowledgeBaseSnapshotId: snapshotId,
      modelRunId: run.id,
      ordinal: 0,
      targetDimension: 1_024,
      vectorSpaceFingerprint
    }
  });
  return Object.freeze({
    baseId,
    chunkToSource,
    credentialId,
    credentialVersionId,
    generationId,
    modelRunId: run.id,
    processingSourceId,
    processingVersionId,
    snapshotId
  });
}

async function persistRuntimeFixture(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture
): Promise<RuntimeFixture> {
  return client.$transaction(
    (tx) => persistRuntimeFixtureTransaction(tx, state),
    { timeout: 120_000 }
  );
}

async function cleanupRuntimeFixture(
  client: PrismaClient,
  fixture: RuntimeFixture
): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.modelRun.deleteMany({ where: { id: fixture.modelRunId } });
    await tx.knowledgeBaseSnapshotSource.deleteMany({ where: { snapshotId: fixture.snapshotId } });
    await tx.knowledgeBaseSnapshot.deleteMany({ where: { id: fixture.snapshotId } });
    await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: fixture.baseId } });
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: fixture.baseId }
    });
    await tx.knowledgeIndexGeneration.deleteMany({ where: { id: fixture.generationId } });
    await tx.knowledgeBase.deleteMany({ where: { id: fixture.baseId } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null },
      where: { id: fixture.processingSourceId }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { id: fixture.processingVersionId } });
    await tx.knowledgeSource.deleteMany({ where: { id: fixture.processingSourceId } });
    await tx.providerCredential.updateMany({
      data: { activeVersionId: null },
      where: { id: fixture.credentialId }
    });
    await tx.providerCredentialVersion.deleteMany({ where: { id: fixture.credentialVersionId } });
    await tx.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
  });
}

function sourceIds(
  result: KnowledgeHybridSearchResult,
  chunkToSource: ReadonlyMap<string, string>
): string[] {
  return result.passages.flatMap((passage) => {
    const sourceId = chunkToSource.get(passage.chunkId);
    return sourceId ? [sourceId] : [];
  });
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const found = new Set(actual);
  return ratio(expected.filter((id) => found.has(id)).length, expected.length);
}

function reciprocalRank(expected: readonly string[], actual: readonly string[]): number {
  const accepted = new Set(expected);
  const index = actual.findIndex((id) => accepted.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function ndcg(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const accepted = new Set(expected);
  const dcg = actual.reduce((sum, id, index) =>
    sum + (accepted.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(expected.length, 8) }, (_, index) =>
    1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function ordinaryProjectionTechnicalLeakage(result: KnowledgeHybridSearchResult): boolean {
  const results = result.passages.map((passage, index) => {
    const { text, ...privatePassage } = passage;
    return Object.freeze({
      ...privatePassage,
      handle: `K1.${index + 1}`,
      includedText: text,
      includedTextBytes: Buffer.byteLength(text, "utf8"),
      sourceTextBytes: Buffer.byteLength(text, "utf8"),
      textTruncated: false
    });
  });
  const projection = knowledgeToolResultText({
    outcome: results.length > 0
      ? "complete"
      : result.candidateCount > 0 ? "zero_above_threshold" : "base_empty",
    results
  });
  const privateValues = result.passages.flatMap((passage) => [
    passage.chunkId,
    passage.contentHash,
    passage.documentId,
    passage.documentVersionId,
    passage.knowledgeBaseId,
    passage.sectionId,
    passage.sourceArtifactId
  ]).filter((value): value is string => Boolean(value));
  const technicalMarkers = [
    "deterministic-token-vector-heuristic-v1",
    "weighted_rrf_v2",
    "fusedScore",
    "rerankScore",
    "signalProvenance",
    "vectorDistance",
    "passage_semantic",
    "section_lexical"
  ];
  return [...privateValues, ...technicalMarkers].some((value) => projection.includes(value));
}

const evaluatedQueries = knowledgeEvalQueries.filter((query) =>
  query.currentBaseline && query.intent !== "corpus_summary");

async function evaluateGoldenRetrieval(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  fixture: RuntimeFixture
) {
  const store = createPrismaKnowledgeRetrievalStore(client);
  const rows: Array<Readonly<{
    intent: KnowledgeEvalQuery["intent"];
    latencyMs: number;
    ndcgAt8: number;
    ordinaryProjectionTechnicalLeakage: boolean;
    resultCount: number;
    sourceIds: readonly string[];
    sourceRecallAt8: number;
  }>> = [];
  for (const query of evaluatedQueries) {
    const startedAt = performance.now();
    const result = await store.hybridSearch({
      candidateLimit: 40,
      operation: "automatic_search",
      query: query.question,
      resultLimit: 8,
      runId: fixture.modelRunId,
      threshold: 0.01,
      userId: state.ownerUserId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: fixture.generationId,
        knowledgeBaseId: fixture.baseId,
        targetDimension: 1_024,
        vector: knowledgeEvalQueryVector(query)
      }]
    });
    const mapped = sourceIds(result, fixture.chunkToSource);
    rows.push(Object.freeze({
      intent: query.intent,
      latencyMs: performance.now() - startedAt,
      ndcgAt8: ndcg(query.expectedSourceIds, mapped),
      ordinaryProjectionTechnicalLeakage: ordinaryProjectionTechnicalLeakage(result),
      resultCount: result.passages.length,
      sourceIds: Object.freeze(mapped),
      sourceRecallAt8: recall(query.expectedSourceIds, mapped)
    }));
  }
  return Object.freeze(rows);
}

function rowByIntent(
  rows: readonly Readonly<{
    intent: KnowledgeEvalQuery["intent"];
    resultCount: number;
    sourceIds: readonly string[];
    sourceRecallAt8: number;
  }>[],
  intent: KnowledgeEvalQuery["intent"]
) {
  return rows.find((row) => row.intent === intent)!;
}

async function evaluateFallbacks(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  fixture: RuntimeFixture
) {
  const exactQuery = knowledgeEvalQueries.find((query) => query.intent === "exact_lookup")!;
  const russianQuery = knowledgeEvalQueries.find((query) => query.intent === "russian_morphology")!;
  const comparisonQuery = knowledgeEvalQueries.find((query) =>
    query.intent === "multi_source_comparison")!;
  const lexicalStore = createPrismaKnowledgeRetrievalStore(client);
  const lexical = await Promise.all([exactQuery, russianQuery].map((query) =>
    lexicalStore.hybridSearch({
      candidateLimit: 40,
      operation: "automatic_search",
      query: query.question,
      resultLimit: 8,
      runId: fixture.modelRunId,
      threshold: 0.01,
      userId: state.ownerUserId,
      vectors: []
    }).then((result) => recall(
      query.expectedSourceIds,
      sourceIds(result, fixture.chunkToSource)
    ))));
  const outageStore = createPrismaKnowledgeRetrievalStore(client, {
    reranker: {
      rerank: async () => {
        throw new Error("knowledge_reranker_eval_outage");
      }
    }
  });
  const outage = await outageStore.hybridSearch({
    candidateLimit: 40,
    operation: "automatic_search",
    query: comparisonQuery.question,
    resultLimit: 8,
    runId: fixture.modelRunId,
    threshold: 0.01,
    userId: state.ownerUserId,
    vectors: [{
      bindingOrdinal: 0,
      indexGenerationId: fixture.generationId,
      knowledgeBaseId: fixture.baseId,
      targetDimension: 1_024,
      vector: knowledgeEvalQueryVector(comparisonQuery)
    }]
  });
  return Object.freeze({
    embeddingOutageExactRecallAt8: round(lexical[0]!),
    embeddingOutageRussianRecallAt8: round(lexical[1]!),
    rerankerOutageComparisonCoverage: round(recall(
      comparisonQuery.expectedSourceIds,
      sourceIds(outage, fixture.chunkToSource)
    )),
    rerankerOutageMode: outage.rankingEvidence?.rerankerBinding.status ?? "missing",
    rerankerOutageResultCount: outage.passages.length
  });
}

async function evaluateDeterministicSourceRead(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  fixture: RuntimeFixture
) {
  const source = state.entries.find((entry) =>
    entry.ownerUserId === state.ownerUserId && entry.logicalSourceId === "source-001")!;
  const outOfScope = state.entries.find((entry) => entry.ownerUserId === state.foreignUserId)!;
  const binding = {
    baseContentRevision: 2,
    baseName: "Knowledge retrieval golden base",
    embeddingConnectionId: state.connectionId,
    embeddingCredentialId: fixture.credentialId,
    embeddingCredentialSource: "default",
    embeddingCredentialVersionId: fixture.credentialVersionId,
    embeddingExecutionSnapshot: { synthetic: true },
    embeddingProviderModelId: state.modelId,
    includeWholeBase: true,
    indexedContentRevision: 1,
    indexGenerationId: fixture.generationId,
    knowledgeBaseId: fixture.baseId,
    knowledgeBaseSnapshotId: fixture.snapshotId,
    ordinal: 0,
    selectedSourceIds: [],
    targetDimension: 1_024,
    vectorSpaceFingerprint
  } satisfies KnowledgeAcceptedBinding;
  const readSource = createPrismaKnowledgeRetrievalStore(client).readSource;
  if (!readSource) throw new Error("knowledge_source_read_eval_unavailable");
  const common = {
    binding,
    runId: fixture.modelRunId,
    userId: state.ownerUserId
  } as const;
  const read = (locator: string, direction: "after" | "around") => {
    const request = normalizeReadSourceRequest({ direction, locator, window: 1 });
    if (!request) throw new Error("knowledge_source_read_eval_locator_invalid");
    return request;
  };
  const [page, heading, rejected] = await Promise.all([
    readSource({
      ...common,
      read: read(`page ${source.source.page}`, "around"),
      sourceArtifactId: source.artifactId,
      sourceId: source.sourceId
    }),
    readSource({
      ...common,
      read: read(`heading: ${source.source.headingPath.join(" › ")}`, "after"),
      sourceArtifactId: source.artifactId,
      sourceId: source.sourceId
    }),
    readSource({
      ...common,
      read: read(`page ${outOfScope.source.page}`, "around"),
      sourceArtifactId: outOfScope.artifactId,
      sourceId: outOfScope.sourceId
    })
  ]);
  const exact = (result: KnowledgeHybridSearchResult): boolean =>
    result.bindingCount === 1 && result.candidateCount === 1 &&
    result.passages.length === 1 &&
    result.passages[0]?.sourceArtifactId === source.artifactId &&
    result.passages[0]?.layoutKind === "body";
  return Object.freeze({
    headingReadExact: exact(heading) && heading.passages[0]?.chunkId === page.passages[0]?.chunkId,
    outOfScopeReadRejected: rejected.candidateCount === 0 && rejected.passages.length === 0,
    pageReadExact: exact(page)
  });
}

async function createAnnBase(
  client: Prisma.TransactionClient,
  input: Readonly<{
    modelId: string;
    ownerUserId: string;
    prefix: string;
    rowCount: number;
    targetDimension?: 1_024 | 1_536;
  }>
): Promise<AnnBaseFixture> {
  const targetDimension = input.targetDimension ?? 1_024;
  const baseId = `${input.prefix}-base`;
  const generationId = `${input.prefix}-generation`;
  const profileId = `${input.prefix}-profile`;
  const profileRevisionId = `${input.prefix}-profile-revision`;
  const sourceId = `${input.prefix}-source`;
  const versionId = `${input.prefix}-version`;
  const artifactId = `${input.prefix}-artifact`;
  const snapshotId = `${input.prefix}-snapshot`;
  const fingerprint = targetDimension === 1_024
    ? vectorSpaceFingerprint
    : "d".repeat(64);
  await client.knowledgeIndexProfile.create({ data: { id: profileId } });
  await client.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: input.modelId,
      executionAuthority: "installation",
      id: profileRevisionId,
      preflightCheckedAt: now,
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId,
      revisionNumber: 1,
      targetDimension,
      vectorSpaceFingerprint: fingerprint
    }
  });
  await client.knowledgeIndexProfile.update({
    data: { activeRevisionId: profileRevisionId },
    where: { id: profileId }
  });
  await client.knowledgeBase.create({
    data: {
      contentRevision: 1,
      id: baseId,
      name: `ANN ${input.rowCount} fixture`,
      ownerUserId: input.ownerUserId
    }
  });
  await client.knowledgeIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: {},
      embeddingProviderModelId: input.modelId,
      id: generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: baseId,
      profileRevisionId,
      readyAt: now,
      status: "active",
      targetDimension,
      vectorSpaceFingerprint: fingerprint
    }
  });
  await client.knowledgeBase.update({
    data: { activeIndexGenerationId: generationId },
    where: { id: baseId }
  });
  await client.knowledgeSource.create({
    data: {
      id: sourceId,
      name: `ANN ${input.rowCount} source`,
      ownerUserId: input.ownerUserId
    }
  });
  await client.knowledgeSourceVersion.create({
    data: {
      byteSize: input.rowCount,
      checksum: sha256(input.prefix),
      fileName: `${input.rowCount}-rows.txt`,
      id: versionId,
      mimeType: "text/plain",
      ownerUserId: input.ownerUserId,
      sourceId,
      versionNumber: 1,
    }
  });
  await client.knowledgeSource.update({
    data: { currentVersionId: versionId },
    where: { id: sourceId }
  });
  await client.knowledgeBaseSource.create({
    data: {
      knowledgeBaseId: baseId,
      ownerUserId: input.ownerUserId,
      sourceId
    }
  });
  await client.knowledgeSourceIndexArtifact.create({
    data: {
      chunkCount: input.rowCount,
      id: artifactId,
      normalizedTextByteSize: input.rowCount,
      normalizedTextChecksum: sha256(`${input.prefix}:normalized`),
      normalizedTextStorageKey: `${input.prefix}/normalized.json`,
      pageCount: 1,
      processingStage: "embedding",
      profileRevisionId,
      sourceVersionId: versionId,
      state: "processing"
    }
  });
  const chunks: KnowledgeChunkPlanEntry[] = Array.from(
    { length: input.rowCount },
    (_, index) => {
      const contentHash = sha256(`${input.prefix}:content:${index}`);
      const embeddingTextHash = sha256(`${input.prefix}:embedding:${index}`);
      const text = targetDimension === 1_024
        ? "ANN qualification passage"
        : "Incompatible ANN qualification passage";
      return {
        contentHash,
        contextPrefix: "",
        documentContext: null,
        embeddingText: text,
        embeddingTextHash,
        headingPath: ["ANN qualification"],
        index,
        page: 1,
        pageEnd: 1,
        sourceBlockEnd: index,
        sourceBlockIds: [`block-${index}`],
        sourceBlockStart: index,
        text,
        tokenCount: 4
      };
    }
  );
  await buildAndPersistKnowledgeHierarchicalIndex(client, {
    chunks,
    document: null,
    now,
    sourceArtifactId: artifactId,
    sourceVersionId: versionId
  });
  const hierarchy = await client.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
    select: { id: true },
    where: { sourceArtifactId: artifactId, state: "ready" }
  });
  // Consecutive rows remain ordered but have representatively separable cosine
  // distances; sub-float near-ties would measure tie-breaking, not ANN recall.
  const divisor = input.rowCount;
  if (targetDimension === 1_024) {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeArtifactPassageEmbedding" (
        "passageId", "indexArtifactId", "embeddingTextHash",
        "embeddingDimension", "embedding", "createdAt"
      )
      SELECT
        passage."id",
        passage."indexArtifactId",
        passage."embeddingTextHash",
        1024,
        (ARRAY[1::real] || array_fill((n::real / ${divisor}), ARRAY[1023]))::vector,
        ${now}
      FROM generate_series(1, ${input.rowCount}) AS n
      INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
        ON passage."indexArtifactId" = ${hierarchy.id}
       AND passage."ordinal" = n - 1
    `);
  } else {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeArtifactPassageEmbedding" (
        "passageId", "indexArtifactId", "embeddingTextHash",
        "embeddingDimension", "embedding", "createdAt"
      )
      SELECT
        passage."id",
        passage."indexArtifactId",
        passage."embeddingTextHash",
        1536,
        (ARRAY[1::real] || array_fill((n::real / ${divisor}), ARRAY[1535]))::vector,
        ${now}
      FROM generate_series(1, ${input.rowCount}) AS n
      INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
        ON passage."indexArtifactId" = ${hierarchy.id}
       AND passage."ordinal" = n - 1
    `);
  }
  await client.knowledgeSourceIndexArtifact.update({
    data: {
      embeddedPassageCount: input.rowCount,
      processingStage: null,
      readyAt: now,
      state: "ready"
    },
    where: { id: artifactId }
  });
  await client.knowledgeBaseSnapshot.create({
    data: {
      evidenceFingerprint: sha256(`${snapshotId}:evidence`),
      id: snapshotId,
      indexGenerationId: generationId,
      knowledgeBaseId: baseId,
      ownerUserId: input.ownerUserId,
      profileRevisionId,
      readySourceCount: 1,
      sourceCount: 1,
      sourceRevision: 1
    }
  });
  await client.knowledgeBaseSnapshotSource.create({
    data: {
      artifactId,
      knowledgeBaseId: baseId,
      ordinal: 0,
      ownerUserId: input.ownerUserId,
      snapshotId,
      sourceId,
      sourceVersionId: versionId
    }
  });
  return Object.freeze({
    artifactId,
    baseId,
    generationId,
    profileId,
    profileRevisionId,
    rowCount: input.rowCount,
    snapshotId,
    sourceId,
    targetDimension,
    versionId
  });
}

async function persistAnnFixture(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  runtime: RuntimeFixture
): Promise<AnnFixture> {
  const prefix = `${state.prefix}-ann`;
  return client.$transaction(async (tx) => {
    const usedBuckets = new Set<number>();
    const distinctPrefix = (label: string): string => {
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const candidate = `${prefix}-${label}-${attempt}`;
        const bucket = knowledgeVectorRetrievalBucket(`${candidate}-base`);
        if (!usedBuckets.has(bucket)) {
          usedBuckets.add(bucket);
          return candidate;
        }
      }
      throw new Error("knowledge_ann_eval_bucket_fixture_unavailable");
    };
    const bases = await Promise.all([
      createAnnBase(tx, {
        modelId: state.modelId,
        ownerUserId: state.ownerUserId,
        prefix: distinctPrefix("small"),
        rowCount: 640
      }),
      createAnnBase(tx, {
        modelId: state.modelId,
        ownerUserId: state.ownerUserId,
        prefix: distinctPrefix("medium"),
        rowCount: 1_024
      }),
      createAnnBase(tx, {
        modelId: state.modelId,
        ownerUserId: state.ownerUserId,
        prefix: distinctPrefix("wide"),
        rowCount: 2_048,
        targetDimension: 1_536
      })
    ]);
    const collidingPrefix = (label: string, retrievalBucket: number): string => {
      for (let attempt = 0; attempt < 256; attempt += 1) {
        const candidate = `${prefix}-${label}-${attempt}`;
        if (knowledgeVectorRetrievalBucket(`${candidate}-base`) === retrievalBucket) {
          return candidate;
        }
      }
      throw new Error("knowledge_ann_eval_colliding_bucket_fixture_unavailable");
    };
    await createAnnBase(tx, {
      modelId: state.modelId,
      ownerUserId: state.foreignUserId,
      prefix: collidingPrefix(
        "foreign-1024-small",
        knowledgeVectorRetrievalBucket(bases[0]!.baseId)
      ),
      rowCount: 1_500
    });
    await createAnnBase(tx, {
      modelId: state.modelId,
      ownerUserId: state.foreignUserId,
      prefix: collidingPrefix(
        "foreign-1024-medium",
        knowledgeVectorRetrievalBucket(bases[1]!.baseId)
      ),
      rowCount: 1_500
    });
    await createAnnBase(tx, {
      modelId: state.modelId,
      ownerUserId: state.foreignUserId,
      prefix: collidingPrefix(
        "foreign-1536",
        knowledgeVectorRetrievalBucket(bases[2]!.baseId)
      ),
      rowCount: 3_000,
      targetDimension: 1_536
    });
    const chat = await tx.chat.create({
      data: { title: "Knowledge ANN eval", userId: state.ownerUserId }
    });
    const message = await tx.message.create({
      data: {
        chatId: chat.id,
        content: textMessageContent("Synthetic ANN parity evaluation"),
        role: "user"
      }
    });
    await tx.chat.update({
      data: { activeLeafMessageId: message.id },
      where: { id: chat.id }
    });
    const run = await tx.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "knowledge-ann-eval-answer",
        normalizedRequest: {},
        provider: "fake",
        status: "in_progress",
        userId: state.ownerUserId,
        userMessageId: message.id
      }
    });
    await tx.knowledgeRunBinding.createMany({
      data: bases.map((base, ordinal) => ({
        baseContentRevision: 1,
        embeddingConnectionId: state.connectionId,
        embeddingCredentialId: runtime.credentialId,
        embeddingCredentialSource: "default" as const,
        embeddingCredentialVersionId: runtime.credentialVersionId,
        embeddingExecutionSnapshot: json({ synthetic: true }),
        embeddingProviderModelId: state.modelId,
        indexGenerationId: base.generationId,
        indexedContentRevision: 1,
        knowledgeBaseId: base.baseId,
        knowledgeBaseSnapshotId: base.snapshotId,
        modelRunId: run.id,
        ordinal,
        targetDimension: base.targetDimension,
        vectorSpaceFingerprint: base.targetDimension === 1_024
          ? vectorSpaceFingerprint
          : "d".repeat(64)
      }))
    });
    return Object.freeze({ bases: Object.freeze(bases), modelRunId: run.id });
  }, { timeout: 300_000 });
}

async function cleanupAnnFixture(client: PrismaClient, state: KnowledgeHierarchicalEvaluationFixture) {
  const basePrefix = `${state.prefix}-ann-`;
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.modelRun.deleteMany({ where: { chat: { title: "Knowledge ANN eval" } } });
    const bases = await tx.knowledgeBase.findMany({
      select: { id: true },
      where: { id: { startsWith: basePrefix } }
    });
    const baseIds = bases.map((base) => base.id);
    if (baseIds.length === 0) return;
    const memberships = await tx.knowledgeBaseSource.findMany({
      select: { sourceId: true },
      where: { knowledgeBaseId: { in: baseIds } }
    });
    const sourceIds = memberships.map(({ sourceId }) => sourceId);
    await tx.knowledgeBaseSnapshotSource.deleteMany({
      where: { knowledgeBaseId: { in: baseIds } }
    });
    await tx.knowledgeBaseSnapshot.deleteMany({
      where: { knowledgeBaseId: { in: baseIds } }
    });
    await tx.knowledgeBaseSource.deleteMany({
      where: { knowledgeBaseId: { in: baseIds } }
    });
    if (sourceIds.length > 0) {
      await tx.knowledgeSourceIndexArtifact.deleteMany({
        where: { sourceVersion: { sourceId: { in: sourceIds } } }
      });
    }
    await tx.knowledgeBase.updateMany({
      data: { activeIndexGenerationId: null },
      where: { id: { in: baseIds } }
    });
    await tx.knowledgeIndexGeneration.deleteMany({ where: { knowledgeBaseId: { in: baseIds } } });
    await tx.knowledgeBase.deleteMany({ where: { id: { in: baseIds } } });
    if (sourceIds.length > 0) {
      await tx.knowledgeSource.updateMany({
        data: { currentVersionId: null, pendingVersionId: null },
        where: { id: { in: sourceIds } }
      });
      await tx.knowledgeSourceVersion.deleteMany({ where: { sourceId: { in: sourceIds } } });
      await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } });
    }
  }, { timeout: 120_000 });
}

function queryVector(targetDimension: 1_024 | 1_536): number[] {
  const vector = Array<number>(targetDimension).fill(0);
  vector[0] = 1;
  return vector;
}

async function configuredVectorQuery<T>(
  client: PrismaClient,
  mode: "ann" | "exact",
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
    if (mode === "ann") {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      await tx.$executeRaw`SET LOCAL jit = off`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(KNOWLEDGE_VECTOR_ANN_EF_SEARCH)}, true)`;
      await tx.$executeRaw`SELECT set_config('hnsw.max_scan_tuples', ${String(KNOWLEDGE_VECTOR_ANN_MAX_SCAN_TUPLES)}, true)`;
    }
    return operation(tx);
  }, { timeout: 30_000 });
}

function planHnswIndexes(plan: readonly unknown[]): readonly string[] {
  return Object.freeze([
    ...new Set(
      JSON.stringify(plan).match(/KAPE_embedding_(?:1024|1536)_hnsw_idx/g) ?? []
    )
  ].sort());
}

async function evaluateAnn(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture,
  fixture: AnnFixture
) {
  await client.$executeRawUnsafe('VACUUM (ANALYZE) "KnowledgeArtifactPassageEmbedding"');
  const [global1024Rows, global1536Rows] = await Promise.all([
    client.knowledgeArtifactPassageEmbedding.count({ where: { embeddingDimension: 1_024 } }),
    client.knowledgeArtifactPassageEmbedding.count({ where: { embeddingDimension: 1_536 } })
  ]);
  const slices = [];
  for (const [bindingOrdinal, base] of fixture.bases.entries()) {
    const vector = {
      bindingOrdinal,
      indexGenerationId: base.generationId,
      knowledgeBaseId: base.baseId,
      targetDimension: base.targetDimension,
      vector: queryVector(base.targetDimension)
    };
    const exactSql = knowledgeAdaptiveVectorSearchSql({
      candidateLimit: 10,
      mode: "exact",
      runId: fixture.modelRunId,
      userId: state.ownerUserId,
      vector
    });
    const annSql = knowledgeAdaptiveVectorSearchSql({
      candidateLimit: 10,
      mode: "ann",
      runId: fixture.modelRunId,
      userId: state.ownerUserId,
      vector
    });
    const [exactPlan, annPlan] = await Promise.all([
      configuredVectorQuery(client, "exact", (tx) => tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${exactSql}`
      )),
      configuredVectorQuery(client, "ann", (tx) => tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${annSql}`
      ))
    ]);
    const exact = await configuredVectorQuery(client, "exact", (tx) =>
      tx.$queryRaw<Array<{ chunkId: string; sourceArtifactId: string }>>(exactSql));
    const latencies: number[] = [];
    let ann: Array<{ chunkId: string; sourceArtifactId: string }> = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const startedAt = performance.now();
      ann = await configuredVectorQuery(client, "ann", (tx) =>
        tx.$queryRaw<Array<{ chunkId: string; sourceArtifactId: string }>>(annSql));
      latencies.push(performance.now() - startedAt);
    }
    const expected = new Set(exact.map((row) => row.chunkId));
    const actual = new Set(ann.map((row) => row.chunkId));
    const annPlanIndexes = planHnswIndexes(annPlan);
    const exactPlanIndexes = planHnswIndexes(exactPlan);
    const retrievalBucket = knowledgeVectorRetrievalBucket(base.baseId);
    const expectedAnnIndex = `KAPE_embedding_${base.targetDimension}_hnsw_idx`;
    const globalRows = base.targetDimension === 1_024 ? global1024Rows : global1536Rows;
    slices.push(Object.freeze({
      annP95LatencyMs: round(percentile(latencies, 0.95)),
      annPlanUsesHnsw: annPlanIndexes.includes(expectedAnnIndex),
      annRecallAt10: round(ratio(
        [...expected].filter((id) => actual.has(id)).length,
        expected.size
      )),
      exactPlanUsesHnsw: exactPlanIndexes.length > 0,
      incompatibleOrCrossScopeLeakageCount: ann.filter((row) =>
        row.sourceArtifactId !== base.artifactId).length,
      sampleCount: latencies.length,
      scopeFraction: round(base.rowCount / globalRows),
      retrievalBucket,
      selectedRows: base.rowCount,
      targetDimension: base.targetDimension
    }));
  }
  const store = createPrismaKnowledgeRetrievalStore(client);
  const adaptive = await store.hybridSearch({
    candidateLimit: 40,
    operation: "automatic_search",
    query: "vector-only qualification zxqv",
    resultLimit: 8,
    runId: fixture.modelRunId,
    threshold: 0.01,
    userId: state.ownerUserId,
    vectors: fixture.bases.map((base, bindingOrdinal) => ({
      bindingOrdinal,
      indexGenerationId: base.generationId,
      knowledgeBaseId: base.baseId,
      targetDimension: base.targetDimension,
      vector: queryVector(base.targetDimension)
    }))
  });
  return Object.freeze({
    adaptiveModes: Object.freeze(adaptive.vectorSearchEvidence?.map((entry) => entry.mode) ?? []),
    global1024Rows,
    global1536Rows,
    slices: Object.freeze(slices)
  });
}

export async function runKnowledgeRetrievalCoreEvaluation(client: PrismaClient) {
  const state = createKnowledgeHierarchicalEvaluationFixture();
  let runtime: RuntimeFixture | null = null;
  let annFixture: AnnFixture | null = null;
  try {
    await persistKnowledgeHierarchicalEvaluationFixture(client, state);
    runtime = await persistRuntimeFixture(client, state);
    annFixture = await persistAnnFixture(client, state, runtime);
    const ann = await evaluateAnn(client, state, annFixture);
    const rows = await evaluateGoldenRetrieval(client, state, runtime);
    const fallback = await evaluateFallbacks(client, state, runtime);
    const sourceRead = await evaluateDeterministicSourceRead(client, state, runtime);
    const factRows = rows.filter((row) => [
      "fact_lookup",
      "paraphrase",
      "russian_morphology",
      "source_prompt_injection"
    ].includes(row.intent));
    const comparison = rowByIntent(rows, "multi_source_comparison");
    const exact = rowByIntent(rows, "exact_lookup");
    const russian = rowByIntent(rows, "russian_morphology");
    const heading = rowByIntent(rows, "section_heading_lookup");
    const noAnswer = rowByIntent(rows, "no_answer");
    const totalResults = rows.reduce((sum, row) => sum + row.resultCount, 0);
    const duplicates = rows.reduce((sum, row) =>
      sum + row.sourceIds.length - new Set(row.sourceIds).size, 0);
    const latencies = rows.map((row) => row.latencyMs);
    const report = Object.freeze({
      ann,
      fallback,
      profileBenchmark: Object.freeze({
        costMicrosPerQuery: 0,
        egress: "none",
        failureBehavior: "deterministic weighted-fusion order",
        hardware: "CPU-only; no GPU requirement",
        languages: Object.freeze(["en", "ru"]),
        local: true,
        memory: "O(candidate pool), bounded at 100 candidates per lane",
        p50LatencyMs: round(percentile(latencies, 0.5)),
        p95LatencyMs: round(percentile(latencies, 0.95)),
        profile: "deterministic-token-vector-heuristic-v1",
        throughputQueriesPerSecond: round(1_000 / Math.max(0.001, mean(latencies))),
        version: 1
      }),
      reportVersion: "knowledge-retrieval-core-eval-v1",
      retrieval: Object.freeze({
        comparisonTargetCoverage: round(comparison.sourceRecallAt8),
        documentRecallAt8: round(mean(factRows.map((row) => row.sourceRecallAt8))),
        duplicateRate: round(ratio(duplicates, totalResults)),
        englishFactRecallAt8: round(mean(factRows
          .filter((row) => row.intent !== "russian_morphology")
          .map((row) => row.sourceRecallAt8))),
        exactIdentifierMrr: round(reciprocalRank(["source-001"], exact.sourceIds)),
        exactIdentifierRecallAt8: round(exact.sourceRecallAt8),
        macroNdcgAt8: round(mean(rows.map((row) => row.ndcgAt8))),
        noAnswerFalsePositiveRate: noAnswer.resultCount === 0 ? 0 : 1,
        passageRecallAt8: round(mean(factRows.map((row) => row.sourceRecallAt8))),
        processingSourceDidNotBlockReadyEvidence: factRows.every((row) => row.resultCount > 0),
        russianRecallAt8: round(russian.sourceRecallAt8),
        sectionHeadingRecallAt8: round(heading.sourceRecallAt8)
      }),
      safety: Object.freeze({
        deterministicSourceHeadingRead: sourceRead.headingReadExact,
        deterministicSourcePageRead: sourceRead.pageReadExact,
        ordinaryProjectionTechnicalLeakage: rows.some((row) =>
          row.ordinaryProjectionTechnicalLeakage),
        outOfScopeSourceReadRejected: sourceRead.outOfScopeReadRejected,
        snapshotReadySourceCount: state.entries.filter((entry) =>
          entry.ownerUserId === state.ownerUserId && entry.logicalSourceId.startsWith("source-")).length,
        snapshotSourceCountIncludesProcessing: true
      }),
      sanitizedAggregatesOnly: true,
      vectorEvidence: Object.freeze({
        fixture: "deterministic-source-oracle-v1",
        purpose: "retrieval_plumbing",
        qualityGateEligible: false,
        realEmbeddingExecution: "not_measured"
      })
    });
    return report;
  } finally {
    if (annFixture) await cleanupAnnFixture(client, state);
    if (runtime) await cleanupRuntimeFixture(client, runtime);
    await cleanupKnowledgeHierarchicalEvaluationFixture(client, state);
  }
}

export type KnowledgeRetrievalCoreEvaluationReport = Awaited<
  ReturnType<typeof runKnowledgeRetrievalCoreEvaluation>
>;

export function assertKnowledgeRetrievalCoreEvaluation(
  report: KnowledgeRetrievalCoreEvaluationReport
): void {
  const passed =
    report.ann.slices.every((slice) =>
      slice.annRecallAt10 >= 0.95 &&
      slice.annP95LatencyMs <= annP95LatencyGateMs &&
      slice.annPlanUsesHnsw &&
      !slice.exactPlanUsesHnsw &&
      slice.incompatibleOrCrossScopeLeakageCount === 0) &&
    new Set(report.ann.slices.map((slice) => slice.targetDimension)).size === 2 &&
    report.ann.adaptiveModes.length === 3 &&
    report.ann.adaptiveModes.every((mode) => mode === "ann") &&
    report.retrieval.passageRecallAt8 >= 0.9 &&
    report.retrieval.documentRecallAt8 >= 0.95 &&
    report.retrieval.exactIdentifierRecallAt8 >= 0.99 &&
    report.retrieval.exactIdentifierMrr >= 0.99 &&
    report.retrieval.comparisonTargetCoverage === 1 &&
    report.retrieval.russianRecallAt8 >= 0.95 &&
    report.retrieval.sectionHeadingRecallAt8 >= 0.9 &&
    report.retrieval.noAnswerFalsePositiveRate === 0 &&
    report.retrieval.duplicateRate === 0 &&
    report.retrieval.processingSourceDidNotBlockReadyEvidence &&
    report.fallback.embeddingOutageExactRecallAt8 >= 0.99 &&
    report.fallback.embeddingOutageRussianRecallAt8 >= 0.95 &&
    report.fallback.rerankerOutageComparisonCoverage === 1 &&
    report.fallback.rerankerOutageMode === "degraded" &&
    report.fallback.rerankerOutageResultCount > 0 &&
    report.profileBenchmark.p95LatencyMs <= retrievalP95LatencyGateMs &&
    report.safety.deterministicSourceHeadingRead &&
    report.safety.deterministicSourcePageRead &&
    !report.safety.ordinaryProjectionTechnicalLeakage &&
    report.safety.outOfScopeSourceReadRejected &&
    report.safety.snapshotSourceCountIncludesProcessing;
  if (!passed) throw new Error("knowledge_retrieval_core_eval_gate_failed");
}
