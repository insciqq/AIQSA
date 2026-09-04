import { Prisma, type PrismaClient } from "@prisma/client";
import type { EmbeddingUsage } from "../providers/embeddings";
import { KNOWLEDGE_EMBEDDING_BATCH_SIZE } from "./chunking";

export const KNOWLEDGE_BULK_EMBEDDING_MAX_INPUTS = KNOWLEDGE_EMBEDDING_BATCH_SIZE;
export const KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_MAX_WAIT_MS = 10_000;
export const KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_TIMEOUT_MS = 300_000;

export type KnowledgeBulkEmbeddingTarget = Readonly<{
  embeddingProviderModelId: string;
  generationId: string;
  knowledgeBaseId: string;
  ownerUserId: string;
  profileRevisionId: string;
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

export type KnowledgeBulkEmbeddingPassageIdentity = Readonly<{
  contentHash: string;
  embeddingTextHash: string;
  passageId: string;
  passageOrdinal: number;
  sourceArtifactId: string;
  sourceVersionId: string;
}>;

export type KnowledgeBulkEmbeddingPassageWrite =
  KnowledgeBulkEmbeddingPassageIdentity & Readonly<{
    vector: readonly number[];
  }>;

export type KnowledgeBulkEmbeddingBatchStatus = Readonly<{
  completeIndexes: readonly number[];
  missingIndexes: readonly number[];
}>;

export class KnowledgeBulkEmbeddingError extends Error {
  constructor(readonly code:
    | "knowledge_bulk_embedding_artifact_mismatch"
    | "knowledge_bulk_embedding_conflict"
    | "knowledge_bulk_embedding_identity_mismatch"
    | "knowledge_bulk_embedding_input_invalid"
    | "knowledge_bulk_embedding_membership_mismatch"
    | "knowledge_bulk_embedding_passage_set_mismatch"
    | "knowledge_bulk_embedding_pointer_mismatch"
    | "knowledge_bulk_embedding_target_invalid") {
    super(code);
    this.name = "KnowledgeBulkEmbeddingError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const passageIdPattern = /^kip_[0-9a-f]{40}$/u;

function exactString(value: string, maximum: number): boolean {
  return Boolean(value) && value === value.trim() && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTarget(target: KnowledgeBulkEmbeddingTarget): boolean {
  return uuidPattern.test(target.generationId) &&
    uuidPattern.test(target.knowledgeBaseId) &&
    exactString(target.ownerUserId, 128) &&
    uuidPattern.test(target.profileRevisionId) &&
    exactString(target.embeddingProviderModelId, 255) &&
    [1_024, 1_536].includes(target.targetDimension) &&
    sha256Pattern.test(target.vectorSpaceFingerprint);
}

export function assertKnowledgeBulkEmbeddingBatch(
  target: KnowledgeBulkEmbeddingTarget,
  passages: readonly KnowledgeBulkEmbeddingPassageIdentity[]
): void {
  if (!validTarget(target) || passages.length < 1 ||
    passages.length > KNOWLEDGE_BULK_EMBEDDING_MAX_INPUTS) {
    throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_input_invalid");
  }
  const passageIds = new Set<string>();
  const artifactOrdinals = new Set<string>();
  for (const passage of passages) {
    const artifactOrdinal = `${passage.sourceArtifactId}:${passage.passageOrdinal}`;
    if (!passageIdPattern.test(passage.passageId) ||
      !uuidPattern.test(passage.sourceArtifactId) ||
      !uuidPattern.test(passage.sourceVersionId) ||
      !Number.isSafeInteger(passage.passageOrdinal) || passage.passageOrdinal < 0 ||
      !sha256Pattern.test(passage.contentHash) ||
      !sha256Pattern.test(passage.embeddingTextHash) ||
      passageIds.has(passage.passageId) || artifactOrdinals.has(artifactOrdinal)) {
      throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_input_invalid");
    }
    passageIds.add(passage.passageId);
    artifactOrdinals.add(artifactOrdinal);
  }
}

function assertKnowledgeBulkEmbeddingWrite(
  target: KnowledgeBulkEmbeddingTarget,
  passages: readonly KnowledgeBulkEmbeddingPassageWrite[]
): void {
  assertKnowledgeBulkEmbeddingBatch(target, passages);
  if (passages.some(({ vector }) => vector.length !== target.targetDimension ||
    vector.some((value) => !Number.isFinite(value)))) {
    throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_input_invalid");
  }
}

type PassageRow = Readonly<{
  chunkCount: number | null;
  claimToken: string | null;
  contentHash: string;
  embeddedPassageCount: number;
  embeddedPassageId: string | null;
  embeddingDimension: number | null;
  embeddingTextHash: string;
  errorCode: string | null;
  inputIndex: number;
  nextAttemptAt: Date;
  ownerUserId: string;
  passageId: string;
  passageOrdinal: number;
  pendingVersionId: string | null;
  currentVersionId: string | null;
  profileRevisionId: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  state: "failed" | "pending" | "processing" | "ready";
  processingStage: "chunking" | "embedding" | null;
}>;

async function assertTarget(
  tx: Prisma.TransactionClient,
  target: KnowledgeBulkEmbeddingTarget,
  lock: "share" | "update"
): Promise<void> {
  const lockClause = lock === "update"
    ? Prisma.sql`FOR UPDATE OF base`
    : Prisma.sql`FOR SHARE OF base`;
  const rows = await tx.$queryRaw<Array<{
    embeddingProviderModelId: string;
    generationId: string;
    ownerUserId: string;
    profileRevisionId: string | null;
    targetDimension: number;
    vectorSpaceFingerprint: string;
  }>>(Prisma.sql`
    SELECT
      base."ownerUserId",
      generation."id" AS "generationId",
      generation."profileRevisionId",
      generation."embeddingProviderModelId",
      generation."targetDimension",
      generation."vectorSpaceFingerprint"
    FROM "KnowledgeBase" AS base
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND generation."id" = base."activeIndexGenerationId"
     AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
    WHERE base."id" = ${target.knowledgeBaseId}
      AND base."trashedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
    ${lockClause}
  `);
  const row = rows[0];
  if (rows.length !== 1 || row?.ownerUserId !== target.ownerUserId ||
    row.generationId !== target.generationId ||
    row.profileRevisionId !== target.profileRevisionId ||
    row.embeddingProviderModelId !== target.embeddingProviderModelId ||
    row.targetDimension !== target.targetDimension ||
    row.vectorSpaceFingerprint.trim() !== target.vectorSpaceFingerprint) {
    throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_target_invalid");
  }
}

async function passageRows(
  tx: Prisma.TransactionClient,
  target: KnowledgeBulkEmbeddingTarget,
  passages: readonly KnowledgeBulkEmbeddingPassageIdentity[],
  now: Date,
  lock: "share" | "update"
): Promise<PassageRow[]> {
  const expectedRows = passages.map((passage, inputIndex) => Prisma.sql`
    (${inputIndex}::integer, ${passage.passageId}, ${passage.sourceArtifactId},
      ${passage.sourceVersionId}, ${passage.passageOrdinal}::integer,
      ${passage.contentHash}, ${passage.embeddingTextHash})
  `);
  const lockClause = lock === "update"
    ? Prisma.sql`FOR UPDATE OF artifact, source`
    : Prisma.sql`FOR SHARE OF artifact, source`;
  const rows = await tx.$queryRaw<PassageRow[]>(Prisma.sql`
    SELECT
      expected."inputIndex",
      expected."passageId",
      expected."sourceArtifactId",
      expected."sourceVersionId",
      expected."passageOrdinal",
      passage."contentHash",
      passage."embeddingTextHash",
      version."sourceId",
      version."ownerUserId",
      source."currentVersionId",
      source."pendingVersionId",
      artifact."profileRevisionId",
      artifact."state"::text AS "state",
      artifact."processingStage"::text AS "processingStage",
      artifact."chunkCount",
      artifact."embeddedPassageCount",
      artifact."claimToken",
      artifact."nextAttemptAt",
      artifact."errorCode",
      embedding."passageId" AS "embeddedPassageId",
      embedding."embeddingDimension"
    FROM (VALUES ${Prisma.join(expectedRows)}) AS expected(
      "inputIndex", "passageId", "sourceArtifactId", "sourceVersionId",
      "passageOrdinal", "contentHash", "embeddingTextHash"
    )
    INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."id" = expected."sourceArtifactId"
     AND artifact."sourceVersionId" = expected."sourceVersionId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = artifact."sourceVersionId"
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = version."sourceId"
     AND source."ownerUserId" = version."ownerUserId"
    INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
      ON hierarchy."sourceArtifactId" = artifact."id"
     AND hierarchy."sourceVersionId" = artifact."sourceVersionId"
     AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
    INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
      ON passage."indexArtifactId" = hierarchy."id"
     AND passage."id" = expected."passageId"
     AND passage."ordinal" = expected."passageOrdinal"
     AND btrim(passage."contentHash") = expected."contentHash"
     AND btrim(passage."embeddingTextHash") = expected."embeddingTextHash"
    LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
      ON embedding."indexArtifactId" = passage."indexArtifactId"
     AND embedding."passageId" = passage."id"
     AND btrim(embedding."embeddingTextHash") = btrim(passage."embeddingTextHash")
    ORDER BY expected."inputIndex"
    ${lockClause}
  `);
  if (rows.length !== passages.length) {
    throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_passage_set_mismatch");
  }
  const sourceIds = new Set<string>();
  for (const [inputIndex, row] of rows.entries()) {
    const expected = passages[inputIndex];
    if (!expected || row.inputIndex !== inputIndex ||
      row.passageId !== expected.passageId ||
      row.sourceArtifactId !== expected.sourceArtifactId ||
      row.sourceVersionId !== expected.sourceVersionId ||
      row.passageOrdinal !== expected.passageOrdinal ||
      row.contentHash.trim() !== expected.contentHash ||
      row.embeddingTextHash.trim() !== expected.embeddingTextHash) {
      throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_identity_mismatch");
    }
    if (row.ownerUserId !== target.ownerUserId ||
      row.profileRevisionId !== target.profileRevisionId ||
      row.state !== "pending" || row.processingStage !== "embedding" ||
      row.chunkCount === null || row.chunkCount < 1 ||
      row.passageOrdinal >= row.chunkCount ||
      row.embeddedPassageCount < 0 || row.embeddedPassageCount > row.chunkCount ||
      row.claimToken !== null || row.errorCode !== null || row.nextAttemptAt <= now ||
      (row.embeddedPassageId !== null &&
        row.embeddingDimension !== target.targetDimension)) {
      throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_artifact_mismatch");
    }
    if (!((row.currentVersionId === null &&
      row.pendingVersionId === row.sourceVersionId) ||
      (row.currentVersionId === row.sourceVersionId &&
        row.pendingVersionId === null))) {
      throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_pointer_mismatch");
    }
    sourceIds.add(row.sourceId);
  }
  const membershipCount = await tx.knowledgeBaseSource.count({
    where: {
      knowledgeBaseId: target.knowledgeBaseId,
      ownerUserId: target.ownerUserId,
      removedAt: null,
      sourceId: { in: [...sourceIds] }
    }
  });
  if (membershipCount !== sourceIds.size) {
    throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_membership_mismatch");
  }
  return rows;
}

function statusFromRows(rows: readonly PassageRow[]): KnowledgeBulkEmbeddingBatchStatus {
  const completeIndexes: number[] = [];
  const missingIndexes: number[] = [];
  for (const row of rows) {
    (row.embeddedPassageId === null ? missingIndexes : completeIndexes)
      .push(row.inputIndex);
  }
  return Object.freeze({
    completeIndexes: Object.freeze(completeIndexes),
    missingIndexes: Object.freeze(missingIndexes)
  });
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function validUsage(usage: EmbeddingUsage): boolean {
  return (usage.inputTokens === null || Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0) &&
    (usage.totalTokens === null || Number.isSafeInteger(usage.totalTokens) &&
      usage.totalTokens >= 0) &&
    (usage.inputTokens === null || usage.totalTokens === null ||
      usage.totalTokens >= usage.inputTokens);
}

export function createPrismaKnowledgeBulkEmbeddingRepository(
  client: PrismaClient
) {
  return {
    async inspectBatch(input: KnowledgeBulkEmbeddingTarget & Readonly<{
      now: Date;
      passages: readonly KnowledgeBulkEmbeddingPassageIdentity[];
    }>): Promise<KnowledgeBulkEmbeddingBatchStatus> {
      assertKnowledgeBulkEmbeddingBatch(input, input.passages);
      if (!Number.isFinite(input.now.getTime())) {
        throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_input_invalid");
      }
      return client.$transaction(async (tx) => {
        await assertTarget(tx, input, "share");
        return statusFromRows(await passageRows(
          tx,
          input,
          input.passages,
          input.now,
          "share"
        ));
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_TIMEOUT_MS
      });
    },

    async persistBatch(input: KnowledgeBulkEmbeddingTarget & Readonly<{
      modelId: string;
      now: Date;
      passages: readonly KnowledgeBulkEmbeddingPassageWrite[];
      provider: string;
      usage: EmbeddingUsage;
      usageEventId: string;
    }>): Promise<"created" | "reused"> {
      assertKnowledgeBulkEmbeddingWrite(input, input.passages);
      if (!Number.isFinite(input.now.getTime()) ||
        !uuidPattern.test(input.usageEventId) || !validUsage(input.usage) ||
        !exactString(input.modelId, 255) || !exactString(input.provider, 128)) {
        throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_input_invalid");
      }
      return client.$transaction(async (tx) => {
        await assertTarget(tx, input, "share");
        const before = statusFromRows(await passageRows(
          tx,
          input,
          input.passages,
          input.now,
          "update"
        ));
        const existingUsage = await tx.usageEvent.findUnique({
          select: {
            inputTokens: true,
            modelId: true,
            provider: true,
            totalTokens: true,
            userId: true
          },
          where: { id: input.usageEventId }
        });
        if (before.completeIndexes.length === input.passages.length) {
          const inputTokens = input.usage.inputTokens ?? 0;
          const totalTokens = input.usage.totalTokens ?? inputTokens;
          if (!existingUsage || existingUsage.userId !== input.ownerUserId ||
            existingUsage.provider !== input.provider ||
            existingUsage.modelId !== input.modelId ||
            existingUsage.inputTokens !== inputTokens ||
            existingUsage.totalTokens !== totalTokens) {
            throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_conflict");
          }
          return "reused";
        }
        if (before.completeIndexes.length > 0 || existingUsage) {
          throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_conflict");
        }

        const valueRows = input.passages.map((passage) => Prisma.sql`
          (${passage.passageId}, ${passage.sourceArtifactId},
            ${passage.sourceVersionId}, ${passage.passageOrdinal},
            ${passage.contentHash}, ${passage.embeddingTextHash},
            ${vectorLiteral(passage.vector)})
        `);
        const inserted = await tx.$queryRaw<Array<{ passageId: string }>>(Prisma.sql`
          INSERT INTO "KnowledgeArtifactPassageEmbedding" (
            "passageId", "indexArtifactId", "embeddingTextHash",
            "embeddingDimension", "embedding", "createdAt"
          )
          SELECT
            passage."id",
            passage."indexArtifactId",
            passage."embeddingTextHash",
            ${input.targetDimension},
            expected."embedding"::vector,
            ${input.now}
          FROM (VALUES ${Prisma.join(valueRows)}) AS expected(
            "passageId", "sourceArtifactId", "sourceVersionId",
            "passageOrdinal", "contentHash", "embeddingTextHash", "embedding"
          )
          INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
            ON artifact."id" = expected."sourceArtifactId"
           AND artifact."sourceVersionId" = expected."sourceVersionId"
           AND artifact."profileRevisionId" = ${input.profileRevisionId}
           AND artifact."state" = 'pending'::"KnowledgeSourceArtifactState"
           AND artifact."processingStage" =
             'embedding'::"KnowledgeSourceArtifactProcessingStage"
           AND artifact."claimToken" IS NULL
          INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
            ON hierarchy."sourceArtifactId" = artifact."id"
           AND hierarchy."sourceVersionId" = artifact."sourceVersionId"
           AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
          INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
            ON passage."indexArtifactId" = hierarchy."id"
           AND passage."id" = expected."passageId"
           AND passage."ordinal" = expected."passageOrdinal"
           AND btrim(passage."contentHash") = expected."contentHash"
           AND btrim(passage."embeddingTextHash") = expected."embeddingTextHash"
          ON CONFLICT ("passageId") DO NOTHING
          RETURNING "passageId"
        `);
        if (inserted.length !== input.passages.length) {
          throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_conflict");
        }
        const inputTokens = input.usage.inputTokens ?? 0;
        await tx.usageEvent.create({
          data: {
            id: input.usageEventId,
            inputTokens,
            modelId: input.modelId,
            provider: input.provider,
            totalTokens: input.usage.totalTokens ?? inputTokens,
            userId: input.ownerUserId
          }
        });

        const artifactIds = [...new Set(input.passages.map(
          ({ sourceArtifactId }) => sourceArtifactId
        ))];
        const updated = await tx.$executeRaw(Prisma.sql`
          WITH totals AS (
            SELECT
              artifact."id" AS "artifactId",
              count(embedding."passageId")::integer AS "embeddedCount"
            FROM "KnowledgeSourceIndexArtifact" AS artifact
            INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS hierarchy
              ON hierarchy."sourceArtifactId" = artifact."id"
             AND hierarchy."sourceVersionId" = artifact."sourceVersionId"
             AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
            INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
              ON passage."indexArtifactId" = hierarchy."id"
            LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
              ON embedding."indexArtifactId" = passage."indexArtifactId"
             AND embedding."passageId" = passage."id"
             AND embedding."embeddingDimension" = ${input.targetDimension}
             AND btrim(embedding."embeddingTextHash") =
               btrim(passage."embeddingTextHash")
            WHERE artifact."id" IN (${Prisma.join(artifactIds)})
              AND artifact."profileRevisionId" = ${input.profileRevisionId}
            GROUP BY artifact."id"
          )
          UPDATE "KnowledgeSourceIndexArtifact" AS artifact
          SET "embeddedPassageCount" = totals."embeddedCount",
              "updatedAt" = ${input.now}
          FROM totals
          WHERE artifact."id" = totals."artifactId"
        `);
        if (updated !== artifactIds.length) {
          throw new KnowledgeBulkEmbeddingError("knowledge_bulk_embedding_conflict");
        }
        return "created";
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_BULK_EMBEDDING_TRANSACTION_TIMEOUT_MS
      });
    }
  };
}

export type PrismaKnowledgeBulkEmbeddingRepository = ReturnType<
  typeof createPrismaKnowledgeBulkEmbeddingRepository
>;
