import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ParsedDocumentBlock } from "../../lib/server/parsing";
import { finalizeParsedDocument } from "../../lib/server/parsing/assessment";
import {
  chunkKnowledgeDocument,
  type KnowledgeChunkPlanEntry
} from "../../lib/server/knowledge/chunking";
import {
  createPrismaKnowledgeHierarchicalIndexRepository
} from "../../lib/server/knowledge/hierarchicalIndexRepository";
import {
  KNOWLEDGE_EXACT_SCAN_MAX_BYTES,
  KnowledgeHierarchicalQueryError,
  type KnowledgeHierarchicalScope,
  type KnowledgeLexicalIndexHit
} from "../../lib/server/knowledge/hierarchicalRetrieval";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "../../lib/server/knowledge/indexProfile";
import {
  encodeKnowledgeNormalizedDocument,
  type StoredKnowledgeNormalizedDocument
} from "../../lib/server/knowledge/normalizedDocument";
import {
  createPrismaKnowledgeHierarchicalRetrievalRepository,
  knowledgeHierarchicalLexicalSearchSql,
  knowledgeHierarchicalMetadataDiscoverySql
} from "../../lib/server/knowledge/prismaHierarchicalRetrievalRepository";
import { knowledgeEvalSourceVector } from "./baseline";
import { knowledgeEvalSources, type KnowledgeEvalSource } from "./fixtures";

const now = new Date("2026-08-18T00:00:00.000Z");
const profileFixtureKey = "knowledge-hierarchical-eval-profile-v1";
const vectorSpaceFingerprint = "4".repeat(64);
const extractionConfig = Object.freeze({
  maxChunksPerDocument: 2_000,
  maxFileBytes: 8_000_000,
  maxNormalizedChars: 5_000_000,
  maxNormalizedObjectBytes: 8_000_000,
  maxPages: 2_000
});

export type KnowledgeHierarchicalEvaluationSource = Readonly<{
  displayName: string;
  fileName: string;
  headingPath: readonly string[];
  id: string;
  language: "en" | "mixed" | "ru";
  mediaType: string;
  page: number;
  tags: readonly string[];
  text: string;
}>;

export type KnowledgeHierarchicalEvaluationEntry = Readonly<{
  artifactId: string;
  chunks: readonly KnowledgeChunkPlanEntry[];
  document: StoredKnowledgeNormalizedDocument;
  logicalSourceId: string;
  normalizedChecksum: string;
  ownerUserId: string;
  source: KnowledgeHierarchicalEvaluationSource;
  sourceId: string;
  versionId: string;
}>;

export type KnowledgeHierarchicalEvaluationFixture = Readonly<{
  connectionId: string;
  entries: readonly KnowledgeHierarchicalEvaluationEntry[];
  foreignUserId: string;
  modelId: string;
  ownerUserId: string;
  prefix: string;
  profileId: string;
  profileRevisionId: string;
}>;

type LexicalSlice = Readonly<{
  expectedSourceIds: readonly string[];
  query: string;
}>;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function fixtureVector(sourceId: string): number[] {
  if (/^source-\d{3}$/u.test(sourceId)) return knowledgeEvalSourceVector(sourceId);
  const vector = Array<number>(1_024).fill(0);
  vector[1_023] = 1;
  return vector;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function sourceFixture(source: KnowledgeEvalSource): KnowledgeHierarchicalEvaluationSource {
  const passage = source.passages[0]!;
  return Object.freeze({
    displayName: source.displayName,
    fileName: source.fileName,
    headingPath: passage.headingPath,
    id: source.id,
    language: source.language,
    mediaType: source.mediaType,
    page: passage.page,
    tags: source.traits,
    text: passage.text
  });
}

function languageHints(language: KnowledgeHierarchicalEvaluationSource["language"]): readonly string[] {
  if (language === "mixed") return Object.freeze(["en", "ru"]);
  return Object.freeze([language]);
}

function normalizedFixture(source: KnowledgeHierarchicalEvaluationSource): Readonly<{
  chunks: readonly KnowledgeChunkPlanEntry[];
  document: StoredKnowledgeNormalizedDocument;
  normalizedChecksum: string;
}> {
  const block: ParsedDocumentBlock = Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([]),
    headingPath: Object.freeze([...source.headingPath]),
    index: 0,
    isTable: false,
    languageHints: languageHints(source.language),
    page: source.page,
    pageEnd: source.page,
    readingOrder: 0,
    table: null,
    text: source.text,
    type: "paragraph"
  });
  const encoded = encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks: [block],
    engine: "inline",
    languages: languageHints(source.language),
    mediaType: source.mediaType,
    pageCount: source.page,
    status: "complete"
  }), extractionConfig, {
    sourceDisplayName: source.displayName,
    sourceMediaType: source.mediaType
  });
  return Object.freeze({
    chunks: Object.freeze(chunkKnowledgeDocument({
      document: encoded.document,
      maxChunks: extractionConfig.maxChunksPerDocument,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    })),
    document: encoded.document,
    normalizedChecksum: encoded.checksum
  });
}

function fixtureEntry(
  prefix: string,
  ownerUserId: string,
  source: KnowledgeHierarchicalEvaluationSource
): KnowledgeHierarchicalEvaluationEntry {
  const normalized = normalizedFixture(source);
  return Object.freeze({
    artifactId: `${prefix}-artifact-${source.id}`,
    chunks: normalized.chunks,
    document: normalized.document,
    logicalSourceId: source.id,
    normalizedChecksum: normalized.normalizedChecksum,
    ownerUserId,
    source,
    sourceId: `${prefix}-source-${source.id}`,
    versionId: `${prefix}-version-${source.id}`
  });
}

export function createKnowledgeHierarchicalEvaluationFixture(): KnowledgeHierarchicalEvaluationFixture {
  const prefix = `knowledge-hierarchical-eval-${randomUUID()}`;
  const ownerUserId = `${prefix}-owner`;
  const foreignUserId = `${prefix}-foreign-owner`;
  const readySources = knowledgeEvalSources
    .filter((source) => source.readiness === "ready" || source.readiness === "ready_with_warnings")
    .map(sourceFixture);
  const foreignSource: KnowledgeHierarchicalEvaluationSource = Object.freeze({
    displayName: "Foreign classified canary",
    fileName: "foreign-classified-canary.txt",
    headingPath: Object.freeze(["Foreign evidence"]),
    id: "foreign-canary",
    language: "en",
    mediaType: "text/plain",
    page: 1,
    tags: Object.freeze(["foreign"]),
    text: "Foreign canary identifier FOREIGN9911 is classified evidence."
  });
  const scanBoundarySource: KnowledgeHierarchicalEvaluationSource = Object.freeze({
    displayName: "Exact scan boundary probe",
    fileName: "exact-scan-boundary.txt",
    headingPath: Object.freeze(["Bounded scan probe"]),
    id: "scan-boundary",
    language: "en",
    mediaType: "text/plain",
    page: 1,
    tags: Object.freeze(["boundary-probe"]),
    text: "boundarypadding ".repeat(270_000).trim()
  });
  return Object.freeze({
    connectionId: `${profileFixtureKey}-connection`,
    entries: Object.freeze([
      ...readySources.map((source) => fixtureEntry(prefix, ownerUserId, source)),
      fixtureEntry(prefix, ownerUserId, scanBoundarySource),
      fixtureEntry(prefix, foreignUserId, foreignSource)
    ]),
    foreignUserId,
    modelId: `${profileFixtureKey}-model`,
    ownerUserId,
    prefix,
    profileId: profileFixtureKey,
    profileRevisionId: `${profileFixtureKey}-revision`
  });
}

export async function persistKnowledgeHierarchicalEvaluationFixture(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture
): Promise<void> {
  await client.user.createMany({
    data: [
      {
        displayName: "Knowledge hierarchical eval owner",
        email: `${state.prefix}-owner@example.test`,
        id: state.ownerUserId,
        status: "active"
      },
      {
        displayName: "Knowledge hierarchical eval foreign owner",
        email: `${state.prefix}-foreign@example.test`,
        id: state.foreignUserId,
        status: "active"
      }
    ]
  });
  const existingConnection = await client.providerConnection.findUnique({
    select: { id: true },
    where: { id: state.connectionId }
  });
  if (!existingConnection) await client.providerConnection.create({
    data: {
      displayName: "Knowledge hierarchical eval embeddings",
      family: "test",
      id: state.connectionId
    }
  });
  const existingModel = await client.providerModel.findUnique({
    select: { id: true },
    where: { id: state.modelId }
  });
  if (!existingModel) await client.providerModel.create({
    data: {
      capabilities: {},
      connectionId: state.connectionId,
      defaultParams: {},
      displayName: "Knowledge hierarchical eval embedding model",
      id: state.modelId,
      modelClass: "embedding",
      modelId: "knowledge-hierarchical-eval-embedding-v1",
      provider: "test"
    }
  });
  const existingProfile = await client.knowledgeIndexProfile.findUnique({
    select: { id: true },
    where: { id: state.profileId }
  });
  if (!existingProfile) {
    await client.knowledgeIndexProfile.create({ data: { id: state.profileId } });
  }
  const existingRevision = await client.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: state.profileRevisionId }
  });
  if (!existingRevision) await client.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      egressPolicy: {},
      embeddingConfiguration: {},
      embeddingProviderModelId: state.modelId,
      executionAuthority: "installation",
      id: state.profileRevisionId,
      preflightCheckedAt: now,
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId: state.profileId,
      revisionNumber: 1,
      targetDimension: 1_024,
      vectorSpaceFingerprint
    }
  });
  await client.knowledgeIndexProfile.update({
    data: { activeRevisionId: state.profileRevisionId },
    where: { id: state.profileId }
  });
  await client.knowledgeSource.createMany({
    data: state.entries.map((entry) => ({
      description: `Golden retrieval fixture: ${entry.source.tags.join(", ")}`,
      id: entry.sourceId,
      name: entry.source.displayName,
      ownerUserId: entry.ownerUserId,
      tags: [...entry.source.tags]
    }))
  });
  await client.knowledgeSourceVersion.createMany({
    data: state.entries.map((entry) => ({
      byteSize: Buffer.byteLength(entry.source.text, "utf8"),
      checksum: sha256(`${entry.logicalSourceId}\0${entry.source.text}`),
      fileName: entry.source.fileName,
      id: entry.versionId,
      mimeType: entry.source.mediaType,
      ownerUserId: entry.ownerUserId,
      sourceId: entry.sourceId,
      versionNumber: 1
    }))
  });
  await client.$transaction(state.entries.map((entry) => client.knowledgeSource.update({
    data: { currentVersionId: entry.versionId },
    where: { id: entry.sourceId }
  })));
  await client.knowledgeSourceIndexArtifact.createMany({
    data: state.entries.map((entry) => ({
      chunkCount: entry.chunks.length,
      id: entry.artifactId,
      normalizedTextByteSize: Buffer.byteLength(JSON.stringify(entry.document), "utf8"),
      normalizedTextChecksum: entry.normalizedChecksum,
      normalizedTextStorageKey: `knowledge-eval/${entry.artifactId}/normalized-v2.json`,
      pageCount: entry.document.pageCount,
      processingStage: "embedding" as const,
      profileRevisionId: state.profileRevisionId,
      sourceVersionId: entry.versionId,
      state: "processing"
    }))
  });
  const repository = createPrismaKnowledgeHierarchicalIndexRepository(client);
  for (const entry of state.entries) {
    const disposition = await repository.build({
      chunks: entry.chunks,
      document: entry.document,
      now,
      sourceArtifactId: entry.artifactId,
      sourceVersionId: entry.versionId
    });
    if (disposition !== "created") throw new Error("knowledge_hierarchical_fixture_build_failed");
    const hierarchy = await client.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
      select: { id: true },
      where: { sourceArtifactId: entry.artifactId, state: "ready" }
    });
    const passages = await client.knowledgeArtifactPassageIndex.findMany({
      orderBy: { ordinal: "asc" },
      select: { embeddingTextHash: true, id: true, indexArtifactId: true },
      where: { indexArtifactId: hierarchy.id }
    });
    const vector = vectorLiteral(fixtureVector(entry.logicalSourceId));
    if (passages.length > 0) {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "KnowledgeArtifactPassageEmbedding" (
          "passageId", "indexArtifactId", "embeddingTextHash",
          "embeddingDimension", "embedding", "createdAt"
        ) VALUES ${Prisma.join(passages.map((passage) => Prisma.sql`(
          ${passage.id}, ${passage.indexArtifactId}, ${passage.embeddingTextHash},
          1024, ${vector}::vector, ${now}
        )`))}
      `);
    }
    await client.knowledgeSourceIndexArtifact.update({
      data: {
        embeddedPassageCount: passages.length,
        processingStage: null,
        readyAt: now,
        state: "ready"
      },
      where: { id: entry.artifactId }
    });
  }
}

export async function cleanupKnowledgeHierarchicalEvaluationFixture(
  client: PrismaClient,
  state: KnowledgeHierarchicalEvaluationFixture
): Promise<void> {
  const artifactIds = state.entries.map((entry) => entry.artifactId);
  const sourceIds = state.entries.map((entry) => entry.sourceId);
  const versionIds = state.entries.map((entry) => entry.versionId);
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    await tx.knowledgeHierarchicalIndexArtifact.deleteMany({
      where: { sourceArtifactId: { in: artifactIds } }
    });
    await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: { in: artifactIds } } });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null, pendingVersionId: null },
      where: { id: { in: sourceIds } }
    });
    await tx.knowledgeSourceVersion.deleteMany({ where: { id: { in: versionIds } } });
    await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } });
    await tx.user.deleteMany({
      where: { id: { in: [state.ownerUserId, state.foreignUserId] } }
    });
  });
}

function mappedSources(
  hits: readonly Readonly<{ sourceArtifactId: string }>[],
  sourceByArtifact: ReadonlyMap<string, string>
): string[] {
  return hits.flatMap((hit) => {
    const sourceId = sourceByArtifact.get(hit.sourceArtifactId);
    return sourceId ? [sourceId] : [];
  });
}

function recall(expected: readonly string[], actual: readonly string[]): number {
  const actualSet = new Set(actual);
  return ratio(expected.filter((sourceId) => actualSet.has(sourceId)).length, expected.length);
}

function reciprocalRank(expected: readonly string[], actual: readonly string[]): number {
  const expectedSet = new Set(expected);
  const index = actual.findIndex((sourceId) => expectedSet.has(sourceId));
  return index < 0 ? 0 : 1 / (index + 1);
}

async function evaluateLexicalSlices(
  slices: readonly LexicalSlice[],
  sourceByArtifact: ReadonlyMap<string, string>,
  search: (query: string) => Promise<readonly KnowledgeLexicalIndexHit[]>
): Promise<Readonly<{ latenciesMs: readonly number[]; recallAt10: number }>> {
  const recalls: number[] = [];
  const latenciesMs: number[] = [];
  for (const slice of slices) {
    const startedAt = performance.now();
    const hits = await search(slice.query);
    latenciesMs.push(performance.now() - startedAt);
    recalls.push(recall(
      slice.expectedSourceIds,
      mappedSources(hits, sourceByArtifact)
    ));
  }
  return Object.freeze({
    latenciesMs: Object.freeze(latenciesMs),
    recallAt10: round(mean(recalls))
  });
}

function planUses(rows: readonly unknown[], indexName: string): boolean {
  return JSON.stringify(rows).includes(indexName);
}

async function queryPlanEvidence(
  client: PrismaClient,
  scope: KnowledgeHierarchicalScope
): Promise<Readonly<{
  forcedEnglishGin: boolean;
  forcedMetadataTrigramGin: boolean;
  forcedRussianGin: boolean;
  naturalEnglishGin: boolean;
  naturalMetadataTrigramGin: boolean;
  naturalRussianGin: boolean;
}>> {
  const englishSql = knowledgeHierarchicalLexicalSearchSql({
    level: "passage",
    limit: 10,
    query: "completed Atlas exports retained",
    scope
  });
  const russianSql = knowledgeHierarchicalLexicalSearchSql({
    level: "passage",
    limit: 10,
    query: "Сколько дней хранятся архивные материалы Бересты?",
    scope
  });
  const metadataSql = knowledgeHierarchicalMetadataDiscoverySql({
    limit: 10,
    query: "mercury budjet 2026",
    scope
  });
  const directEnglishSql = Prisma.sql`
    SELECT passage."id"
    FROM "KnowledgeArtifactPassageIndex" AS passage
    WHERE passage."englishSearchVector" @@ to_tsquery(
      'english'::regconfig,
      replace(plainto_tsquery('english'::regconfig, 'completed Atlas exports retained')::text, ' & ', ' | ')
    )
    LIMIT 10
  `;
  const directRussianSql = Prisma.sql`
    SELECT passage."id"
    FROM "KnowledgeArtifactPassageIndex" AS passage
    WHERE passage."russianSearchVector" @@ to_tsquery(
      'russian'::regconfig,
      replace(plainto_tsquery(
        'russian'::regconfig,
        'Сколько дней хранятся архивные материалы Бересты?'
      )::text, ' & ', ' | ')
    )
    LIMIT 10
  `;
  const directMetadataSql = Prisma.sql`
    SELECT entry."id"
    FROM "KnowledgeArtifactExactEntry" AS entry
    WHERE entry."normalizedValue" % 'mercury budjet 2026'
    LIMIT 10
  `;
  const [naturalEnglish, naturalRussian, naturalMetadata] = await Promise.all([
    client.$queryRaw<unknown[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${englishSql}`),
    client.$queryRaw<unknown[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${russianSql}`),
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.2`;
      return tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${metadataSql}`
      );
    })
  ]);
  const forced = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    await tx.$executeRaw`SET LOCAL pg_trgm.similarity_threshold = 0.2`;
    return Promise.all([
      tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${directEnglishSql}`
      ),
      tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${directRussianSql}`
      ),
      tx.$queryRaw<unknown[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${directMetadataSql}`
      )
    ]);
  });
  return Object.freeze({
    forcedEnglishGin: planUses(forced[0], "KAPI_english_fts_idx"),
    forcedMetadataTrigramGin: planUses(forced[2], "KAEI_normalized_value_trgm_idx"),
    forcedRussianGin: planUses(forced[1], "KAPI_russian_fts_idx"),
    naturalEnglishGin: planUses(naturalEnglish, "KAPI_english_fts_idx"),
    naturalMetadataTrigramGin: planUses(naturalMetadata, "KAEI_normalized_value_trgm_idx"),
    naturalRussianGin: planUses(naturalRussian, "KAPI_russian_fts_idx")
  });
}

const documentSlices: readonly LexicalSlice[] = Object.freeze([
  { expectedSourceIds: ["source-001"], query: "completed Atlas exports retained" },
  { expectedSourceIds: ["source-002"], query: "Сколько дней хранятся архивные материалы Бересты?" },
  { expectedSourceIds: ["source-004"], query: "critical incident assisted response" },
  { expectedSourceIds: ["source-005"], query: "Mercury budget approved amount" },
  { expectedSourceIds: ["source-015"], query: "Indigo tier approval four hours" }
]);

const sectionSlices: readonly LexicalSlice[] = Object.freeze([
  { expectedSourceIds: ["source-001"], query: "Retention Standard period" },
  { expectedSourceIds: ["source-002"], query: "Архив Сроки" },
  { expectedSourceIds: ["source-005"], query: "Approved amount" },
  { expectedSourceIds: ["source-006"], query: "Termination Exceptions" },
  { expectedSourceIds: ["source-007", "source-008", "source-009"], query: "Plan limits" }
]);

const passageSlices: readonly LexicalSlice[] = Object.freeze([
  { expectedSourceIds: ["source-001"], query: "completed Atlas exports retained" },
  { expectedSourceIds: ["source-002"], query: "Сколько дней хранятся архивные материалы Бересты?" },
  { expectedSourceIds: ["source-003"], query: "Orion pressure limit 1013" },
  {
    expectedSourceIds: ["source-011", "source-012", "source-013"],
    query: "Northwind Aurora migration programme eligible"
  },
  { expectedSourceIds: ["source-015"], query: "Indigo tier approval four hours" }
]);

export async function runKnowledgeHierarchicalIndexEvaluation(client: PrismaClient) {
  const state = createKnowledgeHierarchicalEvaluationFixture();
  try {
    await persistKnowledgeHierarchicalEvaluationFixture(client, state);
    const ownedEntries = state.entries.filter((entry) => entry.ownerUserId === state.ownerUserId);
    const goldenEntries = ownedEntries.filter((entry) => entry.logicalSourceId.startsWith("source-"));
    const scanBoundaryEntry = ownedEntries.find((entry) =>
      entry.logicalSourceId === "scan-boundary")!;
    const foreignEntry = state.entries.find((entry) => entry.ownerUserId === state.foreignUserId)!;
    const sourceByArtifact = new Map(state.entries.map((entry) => [
      entry.artifactId,
      entry.logicalSourceId
    ]));
    const scope = Object.freeze({
      ownerUserId: state.ownerUserId,
      sourceArtifactIds: Object.freeze([
        ...goldenEntries.map((entry) => entry.artifactId),
        foreignEntry.artifactId
      ])
    });
    const repository = createPrismaKnowledgeHierarchicalRetrievalRepository(client);
    const document = await evaluateLexicalSlices(
      documentSlices,
      sourceByArtifact,
      (query) => repository.discoverDocuments({ ...scope, limit: 10, query })
    );
    const section = await evaluateLexicalSlices(
      sectionSlices,
      sourceByArtifact,
      (query) => repository.discoverSections({ ...scope, limit: 10, query })
    );
    const passage = await evaluateLexicalSlices(
      passageSlices,
      sourceByArtifact,
      (query) => repository.searchPassages({ ...scope, limit: 10, query })
    );
    const englishHits = await repository.searchPassages({
      ...scope,
      limit: 10,
      query: "completed Atlas exports retained"
    });
    const russianHits = await repository.searchPassages({
      ...scope,
      limit: 10,
      query: "Сколько дней хранятся архивные материалы Бересты?"
    });
    const exactIdentifier = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "identifier",
      query: "AX20260842"
    });
    const exactFilename = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "filename",
      query: "mercury_budget_2026.md"
    });
    const exactHeading = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "heading",
      query: "Exceptions"
    });
    const exactPhrase = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "phrase",
      query: "completed exports for 37 days"
    });
    const exactToken = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "token",
      query: "SAFE-2718"
    });
    const safeRegex = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "regex",
      query: "AX[0-9]{8}"
    });
    const boundaryScan = await repository.findExact({
      ownerUserId: state.ownerUserId,
      sourceArtifactIds: [scanBoundaryEntry.artifactId],
      limit: 10,
      operation: "regex",
      query: "nevermatches"
    });
    const metadata = await repository.discoverMetadata({
      ...scope,
      limit: 10,
      query: "mercury budjet 2026"
    });
    const outOfScope = await repository.searchPassages({
      ownerUserId: state.ownerUserId,
      sourceArtifactIds: [goldenEntries.find((entry) =>
        entry.logicalSourceId === "source-001")!.artifactId],
      limit: 10,
      query: "840000 credits"
    });
    const foreignLexical = await repository.searchPassages({
      ...scope,
      limit: 10,
      query: "foreign classified canary"
    });
    const foreignExact = await repository.findExact({
      ...scope,
      limit: 10,
      operation: "identifier",
      query: "FOREIGN9911"
    });
    let unsafeRegexRejected = false;
    try {
      await repository.findExact({
        ...scope,
        limit: 10,
        operation: "regex",
        query: "(a+)+"
      });
    } catch (error) {
      unsafeRegexRejected = error instanceof KnowledgeHierarchicalQueryError &&
        error.code === "knowledge_exact_pattern_unsafe";
    }
    const reused = await createPrismaKnowledgeHierarchicalIndexRepository(client).build({
      chunks: goldenEntries[0]!.chunks,
      document: goldenEntries[0]!.document,
      now,
      sourceArtifactId: goldenEntries[0]!.artifactId,
      sourceVersionId: goldenEntries[0]!.versionId
    });
    const parentArtifacts = await client.knowledgeSourceIndexArtifact.findMany({
      select: { id: true, normalizedTextChecksum: true, state: true },
      where: { id: { in: state.entries.map((entry) => entry.artifactId) } }
    });
    const normalizedByArtifact = new Map(state.entries.map((entry) => [
      entry.artifactId,
      entry.normalizedChecksum
    ]));
    const acceptedParentsUnchanged = parentArtifacts.length === state.entries.length &&
      parentArtifacts.every((artifact) =>
        artifact.state === "ready" &&
        artifact.normalizedTextChecksum?.trim() === normalizedByArtifact.get(artifact.id));
    const firstHierarchy = await client.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
      select: { id: true },
      where: { sourceArtifactId: goldenEntries[0]!.artifactId }
    });
    let readyChildImmutable = false;
    try {
      await client.knowledgeArtifactDocumentIndex.update({
        data: { sourceName: "mutated" },
        where: { indexArtifactId: firstHierarchy.id }
      });
    } catch (error) {
      readyChildImmutable = String(error).includes("knowledge_hierarchical_index_child_immutable");
    }
    const plans = await queryPlanEvidence(client, scope);
    const hierarchyCounts = await client.knowledgeHierarchicalIndexArtifact.aggregate({
      _sum: { documentCount: true, exactEntryCount: true, passageCount: true, sectionCount: true },
      where: { sourceArtifactId: { in: state.entries.map((entry) => entry.artifactId) } }
    });
    const sourceIds = (hits: readonly Readonly<{ sourceArtifactId: string }>[]) =>
      mappedSources(hits, sourceByArtifact);
    const lexicalLatencies = [
      ...document.latenciesMs,
      ...section.latenciesMs,
      ...passage.latenciesMs
    ];
    const report = Object.freeze({
      artifacts: Object.freeze({
        acceptedParentsUnchanged,
        documentCount: hierarchyCounts._sum.documentCount ?? 0,
        exactEntryCount: hierarchyCounts._sum.exactEntryCount ?? 0,
        indexedSourceCount: goldenEntries.length,
        passageCount: hierarchyCounts._sum.passageCount ?? 0,
        readyChildImmutable,
        reusedReadyArtifact: reused === "reused",
        sectionCount: hierarchyCounts._sum.sectionCount ?? 0,
        shadowArtifactCount: state.entries.length
      }),
      exact: Object.freeze({
        boundedScanMaximumBytes: KNOWLEDGE_EXACT_SCAN_MAX_BYTES,
        boundedScanTruncated: exactPhrase.scanTruncated || exactToken.scanTruncated ||
          safeRegex.scanTruncated,
        boundaryProbeScanTruncated: boundaryScan.scanTruncated,
        filenameRecallAt10: round(recall(["source-005"], sourceIds(exactFilename.results))),
        headingRecallAt10: round(recall(["source-006"], sourceIds(exactHeading.results))),
        identifierMrr: round(reciprocalRank(["source-001"], sourceIds(exactIdentifier.results))),
        identifierRecallAt10: round(recall(["source-001"], sourceIds(exactIdentifier.results))),
        maximumObservedScannedBytes: Math.max(
          exactPhrase.scannedBytes,
          exactToken.scannedBytes,
          safeRegex.scannedBytes,
          boundaryScan.scannedBytes
        ),
        phraseRecallAt10: round(recall(["source-001"], sourceIds(exactPhrase.results))),
        regexRecallAt10: round(recall(["source-001"], sourceIds(safeRegex.results))),
        tokenRecallAt10: round(recall(["source-022"], sourceIds(exactToken.results))),
        unsafeRegexRejected
      }),
      plans,
      reportVersion: "knowledge-hierarchical-index-eval-v1",
      retrieval: Object.freeze({
        documentRecallAt10: document.recallAt10,
        englishPassageRecallAt10: round(recall(["source-001"], sourceIds(englishHits))),
        latencyMs: Object.freeze({
          p50: round(percentile(lexicalLatencies, 0.5)),
          p95: round(percentile(lexicalLatencies, 0.95)),
          samples: lexicalLatencies.length
        }),
        metadataTypoRecallAt10: round(recall(["source-005"], sourceIds(metadata))),
        passageRecallAt10: passage.recallAt10,
        russianPassageRecallAt10: round(recall(["source-002"], sourceIds(russianHits))),
        sectionRecallAt10: section.recallAt10
      }),
      safety: Object.freeze({
        crossOwnerExactLeakageCount: foreignExact.results.length,
        crossOwnerLexicalLeakageCount: foreignLexical.length,
        foreignArtifactWasExplicitlyRequested: scope.sourceArtifactIds.includes(foreignEntry.artifactId),
        outOfScopeLeakageCount: outOfScope.length
      }),
      sanitizedAggregatesOnly: true
    });
    return report;
  } finally {
    await cleanupKnowledgeHierarchicalEvaluationFixture(client, state);
  }
}

export type KnowledgeHierarchicalIndexEvaluationReport = Awaited<
  ReturnType<typeof runKnowledgeHierarchicalIndexEvaluation>
>;

export function assertKnowledgeHierarchicalIndexEvaluation(
  report: KnowledgeHierarchicalIndexEvaluationReport
): void {
  const passed =
    report.artifacts.acceptedParentsUnchanged &&
    report.artifacts.readyChildImmutable &&
    report.artifacts.reusedReadyArtifact &&
    report.retrieval.documentRecallAt10 >= 0.95 &&
    report.retrieval.sectionRecallAt10 >= 0.9 &&
    report.retrieval.passageRecallAt10 >= 0.9 &&
    report.retrieval.englishPassageRecallAt10 >= 0.95 &&
    report.retrieval.russianPassageRecallAt10 >= 0.95 &&
    report.retrieval.metadataTypoRecallAt10 >= 0.95 &&
    report.exact.identifierRecallAt10 >= 0.99 &&
    report.exact.identifierMrr >= 0.99 &&
    report.exact.filenameRecallAt10 >= 0.99 &&
    report.exact.headingRecallAt10 >= 0.99 &&
    report.exact.phraseRecallAt10 >= 0.99 &&
    report.exact.tokenRecallAt10 >= 0.99 &&
    report.exact.regexRecallAt10 >= 0.99 &&
    report.exact.unsafeRegexRejected &&
    !report.exact.boundedScanTruncated &&
    report.exact.boundaryProbeScanTruncated &&
    report.exact.maximumObservedScannedBytes <= report.exact.boundedScanMaximumBytes &&
    report.plans.forcedEnglishGin &&
    report.plans.forcedRussianGin &&
    report.plans.forcedMetadataTrigramGin &&
    report.safety.foreignArtifactWasExplicitlyRequested &&
    report.safety.crossOwnerExactLeakageCount === 0 &&
    report.safety.crossOwnerLexicalLeakageCount === 0 &&
    report.safety.outOfScopeLeakageCount === 0;
  if (!passed) throw new Error("knowledge_hierarchical_index_eval_gate_failed");
}
