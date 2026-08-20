import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeKnowledgeCitationHandle } from "../../lib/contracts/knowledge";
import { textMessageContent } from "../../lib/domain/content";
import { createKnowledgeVectorSpacePin } from "../../lib/server/knowledge/indexProfile";
import {
  createPrismaKnowledgeHierarchicalIndexRepository
} from "../../lib/server/knowledge/hierarchicalIndexRepository";
import {
  materializeKnowledgeBaseSnapshot
} from "../../lib/server/knowledge/sourcePersistence";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../../lib/server/knowledge/knowledgeBudget";
import { createPrismaKnowledgeRetrievalStore } from "../../lib/server/knowledge/prismaRetrievalRepository";
import {
  createKnowledgeToolExecutor,
  type KnowledgeEmbeddingRuntimeResolver
} from "../../lib/server/knowledge/toolExecutor";
import { knowledgeEvidenceFromToolResult } from "../../lib/server/knowledge/toolResult";
import {
  KNOWLEDGE_CANDIDATE_LIMIT,
  KNOWLEDGE_RESULT_LIMIT,
  KNOWLEDGE_SCORE_THRESHOLD
} from "../../lib/server/knowledge/retrievalTypes";
import { resolveDocumentParserRoute } from "../../lib/server/parsing/routing";
import {
  createKnowledgeStaticBaseline,
  knowledgeEvalQueryVector,
  knowledgeEvalSourceVector
} from "./baseline";
import {
  knowledgeEvalQueries,
  knowledgeEvalSources
} from "./fixtures";
import { createKnowledgeHierarchicalEvaluationFixture } from "./hierarchicalIndexes";

const now = new Date("2026-08-18T00:00:00.000Z");
const ANN_LIMIT = 10;
const ANN_SAMPLE_COUNT = 5;
const BASELINE_CONNECTION_ID = "knowledge-postgres-baseline-embedding-connection";
const BASELINE_MODEL_ID = "knowledge-eval-embedding-model";
const BASELINE_PROFILE_ID = "knowledge-postgres-baseline-profile-v2";
const BASELINE_PROFILE_REVISION_ID = `${BASELINE_PROFILE_ID}-revision-1`;

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_024,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_024
  },
  modelClass: "embedding",
  upstreamModelId: "knowledge-eval-embedding-v1"
} as const;

const candidatePin = createKnowledgeVectorSpacePin({
  configuration: embeddingConfiguration,
  deploymentId: "knowledge-eval-embedding-model"
});

if (!candidatePin?.indexSupported) {
  throw new Error("knowledge_eval_vector_pin_unavailable");
}
const pin = candidatePin as NonNullable<typeof candidatePin>;

type FixtureState = {
  baseIds: string[];
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  foreignUserId: string;
  modelId: string;
  modelRunId: string | null;
  ownerUserId: string;
  prefix: string;
};

type BaseFixture = Readonly<{
  baseId: string;
  generationId: string;
  name: string;
  rowCount: number;
  targetDimension: 1_024 | 1_536;
}>;

type GoldenFixture = BaseFixture & Readonly<{
  chunkToPassage: ReadonlyMap<string, string>;
  chunkToSource: ReadonlyMap<string, string>;
  snapshotId: string;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function goldenSourceId(prefix: string, sourceId: string): string {
  return `${prefix}-golden-source-${sourceId}`;
}

function goldenSourceVersionId(prefix: string, sourceId: string): string {
  return `${prefix}-golden-source-version-${sourceId}`;
}

function goldenSourceArtifactId(prefix: string, sourceId: string): string {
  return `${prefix}-golden-source-artifact-${sourceId}`;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("knowledge_eval_latency_sample_missing");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function recall(expected: ReadonlySet<string>, actual: ReadonlySet<string>): number | null {
  if (expected.size === 0) return null;
  return ratio([...expected].filter((id) => actual.has(id)).length, expected.size);
}

function reciprocalRank(expected: ReadonlySet<string>, actual: readonly string[]): number | null {
  if (expected.size === 0) return null;
  const index = actual.findIndex((id) => expected.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function ndcg(expected: ReadonlySet<string>, actual: readonly string[]): number | null {
  if (expected.size === 0) return null;
  const dcg = actual.reduce((sum, id, index) =>
    sum + (expected.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from(
    { length: Math.min(expected.size, actual.length || KNOWLEDGE_RESULT_LIMIT) },
    (_, index) => 1 / Math.log2(index + 2)
  ).reduce((sum, value) => sum + value, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function snapshot(state: FixtureState) {
  return {
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://knowledge-eval.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Knowledge eval endpoint",
    connectionId: state.connectionId,
    credentialId: state.credentialId,
    credentialVersionId: state.credentialVersionId,
    model: embeddingConfiguration,
    modelDisplayName: "Knowledge eval embedding",
    providerFamily: "openai_compatible",
    providerModelId: state.modelId,
    version: 1
  } as const;
}

async function createProviderAndOwners(
  client: PrismaClient,
  state: FixtureState
): Promise<void> {
  await client.user.createMany({
    data: [
      {
        displayName: "Knowledge eval owner",
        email: `${state.prefix}-owner@example.test`,
        id: state.ownerUserId,
        status: "active"
      },
      {
        displayName: "Knowledge eval foreign owner",
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
      activeConfig: json(snapshot(state).connection),
      activeVersion: 1,
      activatedAt: now,
      displayName: "Knowledge eval provider",
      draftConfig: json(snapshot(state).connection),
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: state.connectionId
    }
  });
  const existingModel = await client.providerModel.findUnique({
    select: { id: true },
    where: { id: state.modelId }
  });
  if (!existingModel) await client.providerModel.create({
    data: {
      activeConfig: json(embeddingConfiguration),
      activeVersion: 1,
      activatedAt: now,
      capabilities: json(embeddingConfiguration.capabilities),
      connectionId: state.connectionId,
      defaultParams: {},
      displayName: "Knowledge eval embedding",
      draftConfig: json(embeddingConfiguration),
      draftVersion: 1,
      enabled: true,
      id: state.modelId,
      modelClass: "embedding",
      modelId: embeddingConfiguration.upstreamModelId,
      provider: "openai_compatible"
    }
  });
  const existingProfile = await client.knowledgeIndexProfile.findUnique({
    select: { id: true },
    where: { id: BASELINE_PROFILE_ID }
  });
  if (!existingProfile) {
    await client.knowledgeIndexProfile.create({ data: { id: BASELINE_PROFILE_ID } });
  }
  const existingProfileRevision = await client.knowledgeIndexProfileRevision.findUnique({
    select: { id: true },
    where: { id: BASELINE_PROFILE_REVISION_ID }
  });
  if (!existingProfileRevision) await client.knowledgeIndexProfileRevision.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      egressPolicy: {},
      embeddingConfiguration: json(embeddingConfiguration),
      embeddingProviderModelId: state.modelId,
      executionAuthority: "installation",
      id: BASELINE_PROFILE_REVISION_ID,
      preflightCheckedAt: now,
      preflightStatus: "ready",
      profileConfiguration: {},
      profileId: BASELINE_PROFILE_ID,
      revisionNumber: 1,
      targetDimension: 1_024,
      vectorSpaceFingerprint: pin.fingerprint
    }
  });
  await client.knowledgeIndexProfile.update({
    data: { activeRevisionId: BASELINE_PROFILE_REVISION_ID },
    where: { id: BASELINE_PROFILE_ID }
  });
  await client.providerCredential.create({
    data: {
      connectionId: state.connectionId,
      enabled: true,
      id: state.credentialId,
      label: "Knowledge eval credential"
    }
  });
  await client.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId: state.credentialId,
      id: state.credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testEvidence: { synthetic: true },
      testedAt: now,
      version: 1
    }
  });
  await client.providerCredential.update({
    data: {
      activatedAt: now,
      activeVersionId: state.credentialVersionId
    },
    where: { id: state.credentialId }
  });
  await client.providerConnection.update({
    data: { defaultCredentialId: state.credentialId },
    where: { id: state.connectionId }
  });
}

async function createBase(
  client: PrismaClient,
  state: FixtureState,
  input: Readonly<{
    name: string;
    ownerUserId: string;
    profileRevisionId?: string;
    targetDimension?: 1_024 | 1_536;
  }>
): Promise<BaseFixture> {
  const baseId = `${state.prefix}-${input.name}-base`;
  const generationId = `${state.prefix}-${input.name}-generation`;
  const targetDimension = input.targetDimension ?? 1_024;
  await client.knowledgeBase.create({
    data: {
      contentRevision: 1,
      description: "Synthetic Knowledge baseline fixture",
      id: baseId,
      name: `Knowledge eval ${input.name}`,
      ownerUserId: input.ownerUserId
    }
  });
  state.baseIds.push(baseId);
  await client.knowledgeIndexGeneration.create({
    data: {
      activatedAt: now,
      chunkingProfileVersion: 1,
      embeddingConfiguration: json(embeddingConfiguration),
      embeddingProviderModelId: state.modelId,
      id: generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: baseId,
      profileRevisionId: input.profileRevisionId,
      readyAt: now,
      status: "active",
      targetDimension,
      vectorSpaceFingerprint: targetDimension === 1_024
        ? pin.fingerprint
        : "d".repeat(64)
    }
  });
  await client.knowledgeBase.update({
    data: { activeIndexGenerationId: generationId },
    where: { id: baseId }
  });
  return {
    baseId,
    generationId,
    name: `Knowledge eval ${input.name}`,
    rowCount: 0,
    targetDimension
  };
}

async function createGoldenFixture(
  client: PrismaClient,
  state: FixtureState
): Promise<GoldenFixture> {
  const base = await createBase(client, state, {
    name: "golden",
    ownerUserId: state.ownerUserId,
    profileRevisionId: BASELINE_PROFILE_REVISION_ID
  });
  const sources = knowledgeEvalSources.filter((source) => source.readiness !== "deleted");
  const hierarchicalEntries = new Map(
    createKnowledgeHierarchicalEvaluationFixture().entries.map((entry) => [
      entry.logicalSourceId,
      entry
    ] as const)
  );
  const chunkToPassage = new Map<string, string>();
  const chunkToSource = new Map<string, string>();
  await client.knowledgeSource.createMany({
    data: sources.map((source) => ({
      description: `Synthetic Knowledge baseline fixture: ${source.traits.join(", ")}`,
      id: goldenSourceId(state.prefix, source.id),
      name: source.displayName,
      ownerUserId: state.ownerUserId,
      tags: [...source.traits]
    }))
  });
  await client.knowledgeSourceVersion.createMany({
    data: sources.map((source) => {
      const passage = source.passages[0]!;
      return {
        byteSize: Buffer.byteLength(passage.text, "utf8"),
        checksum: sha256(`${source.id}\0${source.fileName}\0${passage.text}`),
        fileName: source.fileName,
        id: goldenSourceVersionId(state.prefix, source.id),
        mimeType: source.mediaType,
        ownerUserId: state.ownerUserId,
        sourceId: goldenSourceId(state.prefix, source.id),
        versionNumber: 1
      };
    })
  });
  await client.$transaction(sources.map((source) => client.knowledgeSource.update({
    data: { currentVersionId: goldenSourceVersionId(state.prefix, source.id) },
    where: { id: goldenSourceId(state.prefix, source.id) }
  })));
  await client.knowledgeSourceIndexArtifact.createMany({
    data: sources.map((source) => {
      const entry = hierarchicalEntries.get(source.id);
      if (!entry) throw new Error("knowledge_baseline_hierarchy_fixture_missing");
      return {
        chunkCount: entry.chunks.length,
        id: goldenSourceArtifactId(state.prefix, source.id),
        normalizedTextByteSize: Buffer.byteLength(JSON.stringify(entry.document), "utf8"),
        normalizedTextChecksum: entry.normalizedChecksum,
        normalizedTextStorageKey:
          `knowledge-eval/${state.prefix}/${source.id}/normalized-v2.json`,
        pageCount: entry.document.pageCount,
        processingStage: "embedding" as const,
        profileRevisionId: BASELINE_PROFILE_REVISION_ID,
        sourceVersionId: goldenSourceVersionId(state.prefix, source.id),
        state: "processing" as const
      };
    })
  });
  const hierarchicalRepository = createPrismaKnowledgeHierarchicalIndexRepository(client);
  for (const source of sources) {
    const entry = hierarchicalEntries.get(source.id);
    if (!entry) throw new Error("knowledge_baseline_hierarchy_fixture_missing");
    const artifactId = goldenSourceArtifactId(state.prefix, source.id);
    const sourceVersionId = goldenSourceVersionId(state.prefix, source.id);
    const disposition = await hierarchicalRepository.build({
      chunks: entry.chunks,
      document: entry.document,
      now,
      sourceArtifactId: artifactId,
      sourceVersionId
    });
    if (disposition !== "created") {
      throw new Error("knowledge_baseline_hierarchy_build_failed");
    }
    const hierarchy = await client.knowledgeHierarchicalIndexArtifact.findFirstOrThrow({
      select: { id: true },
      where: { sourceArtifactId: artifactId, state: "ready" }
    });
    const passages = await client.knowledgeArtifactPassageIndex.findMany({
      orderBy: { ordinal: "asc" },
      select: { embeddingTextHash: true, id: true, indexArtifactId: true },
      where: { indexArtifactId: hierarchy.id }
    });
    const vector = vectorLiteral(knowledgeEvalSourceVector(source.id));
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
    for (const passage of passages) {
      chunkToPassage.set(passage.id, source.passages[0]!.id);
      chunkToSource.set(passage.id, source.id);
    }
    await client.knowledgeSourceIndexArtifact.update({
      data: {
        embeddedPassageCount: passages.length,
        processingStage: null,
        readyAt: now,
        state: "ready"
      },
      where: { id: artifactId }
    });
  }
  await client.knowledgeBaseSource.createMany({
    data: sources.map((source) => ({
      knowledgeBaseId: base.baseId,
      ownerUserId: state.ownerUserId,
      sourceId: goldenSourceId(state.prefix, source.id)
    }))
  });
  const snapshot = await client.$transaction((tx) =>
    materializeKnowledgeBaseSnapshot(tx, {
      indexGenerationId: base.generationId,
      knowledgeBaseId: base.baseId
    }));
  const snapshotId = snapshot.snapshotId;
  await client.knowledgeDocument.createMany({
    data: sources.map((source) => ({
      id: `${state.prefix}-golden-document-${source.id}`,
      knowledgeBaseId: base.baseId
    }))
  });
  await client.knowledgeDocumentVersion.createMany({
    data: sources.map((source) => {
      const passage = source.passages[0]!;
      return {
        byteSize: Buffer.byteLength(passage.text, "utf8"),
        checksum: sha256(source.id + source.fileName),
        documentId: `${state.prefix}-golden-document-${source.id}`,
        fileName: source.fileName,
        id: `${state.prefix}-golden-version-${source.id}`,
        ingestChunkCount: 1,
        ingestCompletedAt: now,
        ingestEmbeddedChunkCount: 1,
        ingestGenerationId: base.generationId,
        ingestState: "ready" as const,
        knowledgeBaseId: base.baseId,
        mimeType: source.mediaType,
        ownerUserId: state.ownerUserId,
        pageCount: passage.page,
        versionNumber: 1,
        visibleFromRevision: 1
      };
    })
  });
  await client.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeDocument" AS document
    SET "currentVersionId" = version."id"
    FROM "KnowledgeDocumentVersion" AS version
    WHERE document."knowledgeBaseId" = ${base.baseId}
      AND version."documentId" = document."id"
      AND version."knowledgeBaseId" = document."knowledgeBaseId"
  `);
  await client.knowledgeV1DocumentSourceMap.createMany({
    data: sources.map((source) => ({
      documentId: `${state.prefix}-golden-document-${source.id}`,
      knowledgeBaseId: base.baseId,
      ownerUserId: state.ownerUserId,
      sourceId: goldenSourceId(state.prefix, source.id)
    }))
  });
  await client.knowledgeV1DocumentVersionSourceMap.createMany({
    data: sources.map((source) => ({
      documentId: `${state.prefix}-golden-document-${source.id}`,
      documentVersionId: `${state.prefix}-golden-version-${source.id}`,
      knowledgeBaseId: base.baseId,
      ownerUserId: state.ownerUserId,
      sourceId: goldenSourceId(state.prefix, source.id),
      sourceVersionId: goldenSourceVersionId(state.prefix, source.id)
    }))
  });
  await client.knowledgeV1GenerationArtifactMap.createMany({
    data: sources.map((source) => ({
      artifactId: goldenSourceArtifactId(state.prefix, source.id),
      documentVersionId: `${state.prefix}-golden-version-${source.id}`,
      indexGenerationId: base.generationId,
      knowledgeBaseId: base.baseId,
      sourceVersionId: goldenSourceVersionId(state.prefix, source.id)
    }))
  });
  const rows = sources.map((source) => {
    const passage = source.passages[0]!;
    const chunkId = `${state.prefix}-golden-chunk-${source.id}`;
    chunkToPassage.set(chunkId, passage.id);
    chunkToSource.set(chunkId, source.id);
    return Prisma.sql`(
      ${chunkId},
      ${base.baseId},
      ${`${state.prefix}-golden-version-${source.id}`},
      ${base.generationId},
      0,
      ${passage.page},
      ${passage.page},
      ${passage.text},
      ${sha256(passage.text)},
      ${sha256(passage.text)},
      0,
      0,
      ${Math.max(1, passage.text.trim().split(/\s+/u).length)},
      1024,
      ${vectorLiteral(knowledgeEvalSourceVector(source.id))}::vector(1024),
      ${now}
    )`;
  });
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeChunk" (
      "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
      "chunkIndex", "page", "pageEnd", "text", "contentHash", "embeddingTextHash",
      "sourceBlockStart", "sourceBlockEnd", "tokenCount", "embeddingDimension",
      "embedding", "createdAt"
    )
    VALUES ${Prisma.join(rows)}
  `);
  return {
    ...base,
    chunkToPassage,
    chunkToSource,
    rowCount: sources.length,
    snapshotId
  };
}

async function createBenchmarkBase(
  client: PrismaClient,
  state: FixtureState,
  input: Readonly<{
    count: number;
    divisor: number;
    name: string;
    ownerUserId: string;
    targetDimension?: 1_024 | 1_536;
  }>
): Promise<BaseFixture> {
  const base = await createBase(client, state, input);
  const documentId = `${state.prefix}-${input.name}-document`;
  const versionId = `${state.prefix}-${input.name}-version`;
  await client.knowledgeDocument.create({
    data: { id: documentId, knowledgeBaseId: base.baseId }
  });
  await client.knowledgeDocumentVersion.create({
    data: {
      byteSize: input.count,
      checksum: sha256(input.name),
      documentId,
      fileName: `${input.name}.txt`,
      id: versionId,
      ingestChunkCount: input.count,
      ingestCompletedAt: now,
      ingestEmbeddedChunkCount: input.count,
      ingestGenerationId: base.generationId,
      ingestState: "ready",
      knowledgeBaseId: base.baseId,
      mimeType: "text/plain",
      ownerUserId: input.ownerUserId,
      pageCount: 1,
      versionNumber: 1,
      visibleFromRevision: 1
    }
  });
  await client.knowledgeDocument.update({
    data: { currentVersionId: versionId },
    where: { id: documentId }
  });
  const idPrefix = `${state.prefix}-${input.name}-chunk-`;
  if (base.targetDimension === 1_024) {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeChunk" (
        "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
        "chunkIndex", "page", "pageEnd", "text", "contentHash", "embeddingTextHash",
        "sourceBlockStart", "sourceBlockEnd", "tokenCount", "embeddingDimension",
        "embedding", "createdAt"
      )
      SELECT
        ${idPrefix} || n,
        ${base.baseId},
        ${versionId},
        ${base.generationId},
        n - 1,
        1,
        1,
        'synthetic benchmark passage ' || n,
        md5('content:' || n::text) || md5('content-2:' || n::text),
        md5('embedding:' || n::text) || md5('embedding-2:' || n::text),
        n - 1,
        n - 1,
        4,
        1024,
        (ARRAY[1::real] || array_fill((n::real / ${input.divisor}), ARRAY[1023]))::vector,
        ${now}
      FROM generate_series(1, ${input.count}) AS n
    `);
  } else {
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeChunk" (
        "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
        "chunkIndex", "page", "pageEnd", "text", "contentHash", "embeddingTextHash",
        "sourceBlockStart", "sourceBlockEnd", "tokenCount", "embeddingDimension",
        "embedding", "createdAt"
      )
      SELECT
        ${idPrefix} || n,
        ${base.baseId},
        ${versionId},
        ${base.generationId},
        n - 1,
        1,
        1,
        'synthetic incompatible passage ' || n,
        md5('content:' || n::text) || md5('content-2:' || n::text),
        md5('embedding:' || n::text) || md5('embedding-2:' || n::text),
        n - 1,
        n - 1,
        4,
        1536,
        (ARRAY[1::real] || array_fill((n::real / ${input.divisor}), ARRAY[1535]))::vector,
        ${now}
      FROM generate_series(1, ${input.count}) AS n
    `);
  }
  return { ...base, rowCount: input.count };
}

function automaticArguments(query: string) {
  return {
    coverage: { expectedPassageCount: null, mode: "partial" },
    exactTerms: [],
    lanes: ["exact", "lexical", "metadata", "semantic"],
    operation: "automatic_search",
    phaseOrdinal: 0,
    plannerVersion: 2,
    purpose: "answer",
    query,
    strategy: "focused",
    subqueryOrdinal: 0,
    targetNames: [],
    targetResolution: null,
    targetSourceIds: []
  } as const;
}

async function createRun(
  client: PrismaClient,
  state: FixtureState,
  golden: GoldenFixture
): Promise<Readonly<{ toolCallId: string }>> {
  const chat = await client.chat.create({
    data: { title: "Knowledge eval", userId: state.ownerUserId }
  });
  const message = await client.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Synthetic Knowledge evaluation"),
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
      modelId: "knowledge-eval-answer-model",
      normalizedRequest: {},
      provider: "fake",
      status: "in_progress",
      userId: state.ownerUserId,
      userMessageId: message.id
    }
  });
  state.modelRunId = run.id;
  await client.knowledgeRunBinding.create({
    data: {
      baseContentRevision: 1,
      embeddingConnectionId: state.connectionId,
      embeddingCredentialId: state.credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: state.credentialVersionId,
      embeddingExecutionSnapshot: json(snapshot(state)),
      embeddingProviderModelId: state.modelId,
      indexGenerationId: golden.generationId,
      indexedContentRevision: 1,
      knowledgeBaseId: golden.baseId,
      knowledgeBaseSnapshotId: golden.snapshotId,
      modelRunId: run.id,
      ordinal: 0,
      targetDimension: 1_024,
      vectorSpaceFingerprint: pin.fingerprint
    }
  });
  await client.knowledgeRunScope.create({
    data: {
      budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
      exclusions: [],
      modelRunId: run.id,
      resolvedBaseCount: 1,
      resolvedSourceCount: 0,
      selection: {
        baseIds: [golden.baseId],
        mode: "explicit",
        sourceIds: [],
        version: 1
      }
    }
  });
  const toolCall = await client.modelRunToolCall.create({
    data: {
      arguments: automaticArguments("How long does Atlas retain completed exports?"),
      modelRunId: run.id,
      ordinal: 0,
      providerCallId: "knowledge-eval-provider-call",
      roundIndex: 0,
      toolName: "retrieve_knowledge"
    }
  });
  return { toolCallId: toolCall.id };
}

async function cleanupFixture(client: PrismaClient, state: FixtureState): Promise<void> {
  const fixtureSources = knowledgeEvalSources.filter((source) => source.readiness !== "deleted");
  const sourceIds = fixtureSources.map((source) => goldenSourceId(state.prefix, source.id));
  const sourceVersionIds = fixtureSources.map((source) =>
    goldenSourceVersionId(state.prefix, source.id));
  const sourceArtifactIds = fixtureSources.map((source) =>
    goldenSourceArtifactId(state.prefix, source.id));
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
    if (state.modelRunId) {
      await tx.modelRun.deleteMany({ where: { id: state.modelRunId } });
    }
    for (const baseId of state.baseIds) {
      await tx.knowledgeBase.updateMany({
        data: { activeIndexGenerationId: null },
        where: { id: baseId }
      });
      await tx.knowledgeBaseSnapshotSource.deleteMany({
        where: { knowledgeBaseId: baseId }
      });
      await tx.knowledgeBaseSnapshot.deleteMany({
        where: { knowledgeBaseId: baseId }
      });
      await tx.knowledgeDocument.updateMany({
        data: { currentVersionId: null },
        where: { knowledgeBaseId: baseId }
      });
      await tx.knowledgeChunk.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeV1GenerationArtifactMap.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeV1DocumentVersionSourceMap.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeV1DocumentSourceMap.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeGenerationDocument.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeDocumentVersion.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeIndexGeneration.deleteMany({ where: { knowledgeBaseId: baseId } });
      await tx.knowledgeBase.deleteMany({ where: { id: baseId } });
    }
    await tx.knowledgeSourceIndexArtifact.deleteMany({
      where: { id: { in: sourceArtifactIds } }
    });
    await tx.knowledgeSource.updateMany({
      data: { currentVersionId: null },
      where: { id: { in: sourceIds } }
    });
    await tx.knowledgeSourceVersion.deleteMany({
      where: { id: { in: sourceVersionIds } }
    });
    await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } });
    await tx.user.deleteMany({
      where: { id: { in: [state.ownerUserId, state.foreignUserId] } }
    });
    await tx.providerConnection.updateMany({
      data: { defaultCredentialId: null },
      where: { defaultCredentialId: state.credentialId, id: state.connectionId }
    });
    await tx.providerCredential.updateMany({
      data: { activeVersionId: null },
      where: { id: state.credentialId }
    });
    await tx.providerCredentialVersion.deleteMany({
      where: { id: state.credentialVersionId }
    });
    await tx.providerCredential.deleteMany({ where: { id: state.credentialId } });
  }, { timeout: 120_000 });
  await client.$executeRawUnsafe('VACUUM (ANALYZE) "KnowledgeChunk"');
}

async function currentRetrievalBaseline(
  client: PrismaClient,
  state: FixtureState,
  golden: GoldenFixture
) {
  const store = createPrismaKnowledgeRetrievalStore(client);
  const queryRows: Array<Readonly<{
    intent: string;
    latencyMs: number;
    ndcgAt8: number | null;
    passageRecallAt8: number | null;
    reciprocalRank: number | null;
    resultCount: number;
    sourceRecallAt8: number | null;
  }>> = [];
  let noAnswerFalsePositives = 0;
  let comparisonCoverage = 0;
  let exhaustiveCoverage = 0;
  let duplicateResults = 0;
  const evaluated = knowledgeEvalQueries.filter((query) => query.currentBaseline);
  for (const query of evaluated) {
    const startedAt = performance.now();
    const result = await store.hybridSearch({
      candidateLimit: KNOWLEDGE_CANDIDATE_LIMIT,
      operation: "automatic_search",
      query: query.question,
      resultLimit: KNOWLEDGE_RESULT_LIMIT,
      runId: state.modelRunId!,
      threshold: KNOWLEDGE_SCORE_THRESHOLD,
      userId: state.ownerUserId,
      vectors: [{
        bindingOrdinal: 0,
        indexGenerationId: golden.generationId,
        knowledgeBaseId: golden.baseId,
        targetDimension: 1_024,
        vector: knowledgeEvalQueryVector(query)
      }]
    });
    const latencyMs = performance.now() - startedAt;
    const sourceIds = result.passages.map((passage) =>
      golden.chunkToSource.get(passage.chunkId) ?? "unmapped");
    const passageIds = result.passages.map((passage) =>
      golden.chunkToPassage.get(passage.chunkId) ?? "unmapped");
    const expectedSources = new Set(query.expectedSourceIds);
    const expectedPassages = new Set(query.expectedPassageIds);
    const uniqueSources = new Set(sourceIds);
    const uniquePassages = new Set(passageIds);
    duplicateResults += result.passages.length - new Set(
      result.passages.map((passage) => passage.chunkId)
    ).size;
    if (query.noAnswer && result.passages.length > 0) noAnswerFalsePositives += 1;
    const sourceRecall = recall(expectedSources, uniqueSources);
    if (query.intent === "multi_source_comparison") comparisonCoverage = sourceRecall ?? 0;
    if (query.intent === "exhaustive_corpus_search") exhaustiveCoverage = sourceRecall ?? 0;
    queryRows.push({
      intent: query.intent,
      latencyMs,
      ndcgAt8: ndcg(expectedSources, sourceIds),
      passageRecallAt8: recall(expectedPassages, uniquePassages),
      reciprocalRank: reciprocalRank(expectedSources, sourceIds),
      resultCount: result.passages.length,
      sourceRecallAt8: sourceRecall
    });
  }
  const exactLookup = queryRows.find((row) => row.intent === "exact_lookup");
  const russian = queryRows.filter((row) => row.intent === "russian_morphology");
  const english = queryRows.filter((row) => row.intent !== "russian_morphology");
  type NumericMetric =
    | "latencyMs"
    | "ndcgAt8"
    | "passageRecallAt8"
    | "reciprocalRank"
    | "resultCount"
    | "sourceRecallAt8";
  const numeric = (key: NumericMetric, rows = queryRows): number[] =>
    rows.flatMap((row) => {
      const value = row[key];
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });
  return Object.freeze({
    comparisonTargetCoverage: round(comparisonCoverage),
    duplicateRate: round(ratio(duplicateResults, queryRows.reduce(
      (sum, row) => sum + row.resultCount, 0
    ))),
    englishSourceRecallAt8: round(mean(numeric("sourceRecallAt8", english)) ?? 0),
    evaluatedQueryCount: queryRows.length,
    exactIdentifierRecallAt8: round(exactLookup?.sourceRecallAt8 ?? 0),
    exactLookupMrr: round(exactLookup?.reciprocalRank ?? 0),
    exhaustiveDocumentRecallAt8: round(exhaustiveCoverage),
    latencyMs: Object.freeze({
      p50: round(percentile(numeric("latencyMs"), 0.5)),
      p95: round(percentile(numeric("latencyMs"), 0.95)),
      samples: queryRows.length
    }),
    macroNdcgAt8: round(mean(numeric("ndcgAt8")) ?? 0),
    macroPassageRecallAt8: round(mean(numeric("passageRecallAt8")) ?? 0),
    macroSourceRecallAt8: round(mean(numeric("sourceRecallAt8")) ?? 0),
    noAnswerFalsePositiveRate: round(ratio(
      noAnswerFalsePositives,
      evaluated.filter((query) => query.noAnswer).length
    )),
    perIntent: Object.freeze(queryRows.map((row) => Object.freeze({
      intent: row.intent,
      ndcgAt8: row.ndcgAt8 === null ? null : round(row.ndcgAt8),
      passageRecallAt8: row.passageRecallAt8 === null
        ? null
        : round(row.passageRecallAt8),
      resultCount: row.resultCount,
      sourceRecallAt8: row.sourceRecallAt8 === null ? null : round(row.sourceRecallAt8)
    }))),
    russianSourceRecallAt8: round(mean(numeric("sourceRecallAt8", russian)) ?? 0)
  });
}

async function citationBaseline(
  client: PrismaClient,
  state: FixtureState,
  golden: GoldenFixture,
  toolCallId: string
) {
  const query = knowledgeEvalQueries.find((candidate) =>
    candidate.id === "query-fact-atlas-retention")!;
  const embeddingRuntime: KnowledgeEmbeddingRuntimeResolver = {
    resolve: async () => ({
      adapter: {
        embed: async (request) => ({
          model: embeddingConfiguration.upstreamModelId,
          requestId: "knowledge-eval-request",
          usage: { inputTokens: 0, totalTokens: 0 },
          vectors: request.texts.map(() => knowledgeEvalQueryVector(query))
        })
      },
      configuration: embeddingConfiguration,
      provider: "openai_compatible",
      providerModelId: state.modelId
    })
  };
  const executor = createKnowledgeToolExecutor({
    embeddingRuntime,
    store: createPrismaKnowledgeRetrievalStore(client)
  });
  const result = await executor.execute({
    arguments: automaticArguments(query.question),
    id: "knowledge-eval-provider-call",
    name: "retrieve_knowledge"
  }, {
    persistedToolCallId: toolCallId,
    request: {} as never,
    runId: state.modelRunId!,
    userId: state.ownerUserId
  });
  const evidence = knowledgeEvidenceFromToolResult(result);
  if (!evidence) throw new Error("knowledge_eval_citation_evidence_unavailable");
  const sourceIds = evidence.results.map((item) =>
    golden.chunkToSource.get(item.chunkId) ?? "unmapped");
  const expected = new Set(query.expectedCitationSourceIds);
  const relevant = sourceIds.filter((id) => expected.has(id)).length;
  // Human-readable Base/Source labels are admitted private context used by the
  // model-facing aliases. Storage identities, hashes, and index fingerprints are not.
  const structuredIdentitySentinels = [
    golden.baseId,
    golden.generationId,
    ...evidence.bases.flatMap((base) => [
      base.knowledgeBaseId,
      base.indexGenerationId,
      base.vectorSpaceFingerprint
    ]),
    ...evidence.results.flatMap((item) => [
      item.chunkId,
      item.documentId,
      item.documentVersionId,
      item.knowledgeBaseId,
      ...(item.contentHash ? [item.contentHash] : []),
      ...(item.sectionId ? [item.sectionId] : []),
      ...(item.sourceArtifactId ? [item.sourceArtifactId] : [])
    ])
  ];
  return Object.freeze({
    citationPrecision: round(ratio(relevant, sourceIds.length)),
    citationRecall: round(ratio(new Set(
      sourceIds.filter((id) => expected.has(id))
    ).size, expected.size)),
    handleValidity: evidence.results.every((item) => {
      const decoded = decodeKnowledgeCitationHandle(item.handle);
      return decoded !== null && "evidenceOrdinal" in decoded;
    }) ? 1 : 0,
    persistedReceipt: await client.knowledgeRun.count({
      where: { modelRunToolCallId: toolCallId }
    }) === 1,
    providerTextContainsStructuredIdentity: structuredIdentitySentinels.some((sentinel) =>
      evidence.providerText.includes(sentinel)),
    resultCount: evidence.results.length,
    resultVersion: evidence.version,
    status: result.status
  });
}

function vectorSearchSql(base: BaseFixture): Prisma.Sql {
  const query = vectorLiteral(knowledgeEvalQueryVector(
    knowledgeEvalQueries.find((candidate) =>
      candidate.id === "query-fact-atlas-retention")!
  ));
  return Prisma.sql`
    SELECT chunk."id"
    FROM "KnowledgeChunk" AS chunk
    WHERE chunk."knowledgeBaseId" = ${base.baseId}
      AND chunk."indexGenerationId" = ${base.generationId}
      AND chunk."embeddingDimension" = 1024
    ORDER BY chunk."embedding"::vector(1024) <=> ${query}::vector(1024)
    LIMIT ${ANN_LIMIT}
  `;
}

async function explain(
  client: PrismaClient,
  statement: Prisma.Sql,
  mode: "current" | "exact" | "tuned"
): Promise<unknown[]> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
    if (mode === "exact") {
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
    }
    if (mode === "tuned") {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      await tx.$executeRaw`SET LOCAL hnsw.max_scan_tuples = 20000`;
    }
    return tx.$queryRaw<unknown[]>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}
    `);
  });
}

async function searchIds(
  client: PrismaClient,
  statement: Prisma.Sql,
  mode: "current" | "exact" | "tuned"
): Promise<Array<{ id: string }>> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`;
    if (mode === "exact") {
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
    }
    if (mode === "tuned") {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      await tx.$executeRaw`SET LOCAL hnsw.max_scan_tuples = 20000`;
    }
    return tx.$queryRaw<Array<{ id: string }>>(statement);
  });
}

function explainExecutionMs(rows: readonly unknown[]): number {
  const first = rows[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("knowledge_eval_explain_invalid");
  }
  const payload = (first as Record<string, unknown>)["QUERY PLAN"];
  const root = Array.isArray(payload) ? payload[0] : null;
  const value = root && typeof root === "object"
    ? (root as Record<string, unknown>)["Execution Time"]
    : null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("knowledge_eval_explain_invalid");
  }
  return value;
}

async function annSlice(
  client: PrismaClient,
  base: BaseFixture,
  globalRows: number
) {
  const statement = vectorSearchSql(base);
  const [currentPlan, exactPlan, tunedPlan] = await Promise.all([
    explain(client, statement, "current"),
    explain(client, statement, "exact"),
    explain(client, statement, "tuned")
  ]);
  const exact = await searchIds(client, statement, "exact");
  const currentLatencies: number[] = [];
  const exactLatencies: number[] = [];
  const tunedLatencies: number[] = [];
  let current: Array<{ id: string }> = [];
  let tuned: Array<{ id: string }> = [];
  for (let sample = 0; sample < ANN_SAMPLE_COUNT; sample += 1) {
    let startedAt = performance.now();
    current = await searchIds(client, statement, "current");
    currentLatencies.push(performance.now() - startedAt);
    startedAt = performance.now();
    await searchIds(client, statement, "exact");
    exactLatencies.push(performance.now() - startedAt);
    startedAt = performance.now();
    tuned = await searchIds(client, statement, "tuned");
    tunedLatencies.push(performance.now() - startedAt);
  }
  const expected = new Set(exact.map(({ id }) => id));
  const currentIds = new Set(current.map(({ id }) => id));
  const tunedIds = new Set(tuned.map(({ id }) => id));
  const currentPlanJson = JSON.stringify(currentPlan);
  const exactPlanJson = JSON.stringify(exactPlan);
  const tunedPlanJson = JSON.stringify(tunedPlan);
  const expectedPrefix = base.baseId.replace(/-base$/u, "-chunk-");
  return Object.freeze({
    currentPlanRecallAt10: round(ratio(
      [...expected].filter((id) => currentIds.has(id)).length,
      expected.size
    )),
    currentExecutionMs: round(explainExecutionMs(currentPlan)),
    currentP95LatencyMs: round(percentile(currentLatencies, 0.95)),
    currentPlanUsesHnsw: currentPlanJson.includes(
      "KnowledgeChunk_embedding_1024_hnsw_idx"
    ),
    exactExecutionMs: round(explainExecutionMs(exactPlan)),
    exactP95LatencyMs: round(percentile(exactLatencies, 0.95)),
    exactPlanUsesHnsw: exactPlanJson.includes(
      "KnowledgeChunk_embedding_1024_hnsw_idx"
    ),
    incompatibleOrCrossOwnerLeakageCount: [...currentIds, ...tunedIds].filter((id) =>
      !id.startsWith(expectedPrefix)).length,
    diagnosticMode: "forced_hnsw_strict_order" as const,
    forcedHnswExecutionMs: round(explainExecutionMs(tunedPlan)),
    forcedHnswP95LatencyMs: round(percentile(tunedLatencies, 0.95)),
    forcedHnswPlanUsesIndex: tunedPlanJson.includes(
      "KnowledgeChunk_embedding_1024_hnsw_idx"
    ),
    forcedHnswRecallAt10: round(ratio(
      [...expected].filter((id) => tunedIds.has(id)).length,
      expected.size
    )),
    sampleCount: ANN_SAMPLE_COUNT,
    scopeFraction: round(base.rowCount / globalRows),
    selectedRows: base.rowCount
  });
}

function ingestionBaseline() {
  const admitted = knowledgeEvalSources.filter((source) =>
    Boolean(resolveDocumentParserRoute(source.fileName, source.mediaType)));
  const sidecar = admitted.filter((source) =>
    resolveDocumentParserRoute(source.fileName, source.mediaType)?.kind === "sidecar");
  return Object.freeze({
    actualPipelineThroughput: Object.freeze({
      reason: "synthetic manifest baseline does not call external parser sidecars",
      status: "not_measured"
    }),
    admittedSourceCount: admitted.length,
    fileAdmissionAccuracy: round(admitted.length / knowledgeEvalSources.length),
    inlineSourceCount: admitted.length - sidecar.length,
    partialParseAcceptedByCurrentPipeline: true,
    sidecarFallbackEnabledByCurrentKnowledgeIngestion: true,
    sidecarSourceCount: sidecar.length,
    sourceCount: knowledgeEvalSources.length
  });
}

export async function runKnowledgePostgresBaseline(client: PrismaClient) {
  const unique = randomUUID();
  const prefix = `knowledge-eval-${unique}`;
  const state: FixtureState = {
    baseIds: [],
    connectionId: BASELINE_CONNECTION_ID,
    credentialId: `${prefix}-credential`,
    credentialVersionId: `${prefix}-credential-version`,
    foreignUserId: `${prefix}-foreign-user`,
    modelId: BASELINE_MODEL_ID,
    modelRunId: null,
    ownerUserId: `${prefix}-owner-user`,
    prefix
  };
  await client.$executeRawUnsafe('VACUUM (ANALYZE) "KnowledgeChunk"');
  try {
    await createProviderAndOwners(client, state);
    const golden = await createGoldenFixture(client, state);
    const [small, medium, wide, foreign, incompatible] = await Promise.all([
      createBenchmarkBase(client, state, {
        count: 8,
        divisor: 10_000,
        name: "small",
        ownerUserId: state.ownerUserId
      }),
      createBenchmarkBase(client, state, {
        count: 128,
        divisor: 100_000,
        name: "medium",
        ownerUserId: state.ownerUserId
      }),
      createBenchmarkBase(client, state, {
        count: 512,
        divisor: 1_000_000,
        name: "wide",
        ownerUserId: state.ownerUserId
      }),
      createBenchmarkBase(client, state, {
        count: 5_000,
        divisor: 100_000_000,
        name: "foreign",
        ownerUserId: state.foreignUserId
      }),
      createBenchmarkBase(client, state, {
        count: 128,
        divisor: 100_000,
        name: "incompatible",
        ownerUserId: state.ownerUserId,
        targetDimension: 1_536
      })
    ]);
    await client.$executeRaw`ANALYZE "KnowledgeChunk"`;
    const run = await createRun(client, state, golden);
    const versions = await client.$queryRaw<Array<{
      pgvector: string;
      postgres: string;
    }>>(Prisma.sql`
      SELECT
        current_setting('server_version') AS postgres,
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector
    `);
    const database = versions[0];
    if (!database) throw new Error("knowledge_eval_database_profile_unavailable");
    const globalRows = golden.rowCount + small.rowCount + medium.rowCount +
      wide.rowCount + foreign.rowCount;
    const [retrieval, citations, annSlices, staticBaseline] = await Promise.all([
      currentRetrievalBaseline(client, state, golden),
      citationBaseline(client, state, golden, run.toolCallId),
      Promise.all([
        annSlice(client, small, globalRows),
        annSlice(client, medium, globalRows),
        annSlice(client, wide, globalRows)
      ]),
      createKnowledgeStaticBaseline()
    ]);
    return Object.freeze({
      answer: Object.freeze({
        reason: "production answer-provider calls are outside the deterministic Stage 0 baseline",
        status: "not_measured"
      }),
      citations,
      database: Object.freeze({
        pgvectorVersion: database.pgvector,
        postgresVersion: database.postgres
      }),
      ingestion: ingestionBaseline(),
      reportVersion: "knowledge-engine-current-baseline-v1",
      retrieval,
      sanitizedAggregatesOnly: true,
      static: staticBaseline,
      vectorEvidence: Object.freeze({
        fixture: "deterministic-source-oracle-v1",
        purpose: "database_plumbing",
        qualityGateEligible: false,
        realEmbeddingExecution: "not_measured"
      }),
      vectorQualification: Object.freeze({
        global1024Rows: globalRows,
        incompatible1536Rows: incompatible.rowCount,
        slices: Object.freeze(annSlices)
      })
    });
  } finally {
    await cleanupFixture(client, state);
  }
}

export type KnowledgePostgresBaselineReport = Awaited<
  ReturnType<typeof runKnowledgePostgresBaseline>
>;
