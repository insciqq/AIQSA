import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeBulkEmbeddingTarget } from "./bulkEmbedding";

export const KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES = 500;
export const KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_MAX_WAIT_MS = 10_000;
export const KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_TIMEOUT_MS = 300_000;

export type KnowledgeBulkActivationResult = Readonly<{
  activatedSources: number;
}>;

export type KnowledgeBulkActivationInspection = Readonly<{
  pendingSources: number;
  readySources: number;
  totalSources: number;
}>;

export class KnowledgeBulkActivationError extends Error {
  constructor(readonly code:
    | "knowledge_bulk_activation_conflict"
    | "knowledge_bulk_activation_input_invalid"
    | "knowledge_bulk_activation_target_invalid") {
    super(code);
    this.name = "KnowledgeBulkActivationError";
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

function exactString(value: string, maximum: number): boolean {
  return Boolean(value) && value === value.trim() && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function assertKnowledgeBulkActivationInput(
  target: KnowledgeBulkEmbeddingTarget,
  limit: number,
  now: Date
): void {
  if (!uuidPattern.test(target.generationId) ||
    !uuidPattern.test(target.knowledgeBaseId) ||
    !uuidPattern.test(target.profileRevisionId) ||
    !uuidPattern.test(target.embeddingProviderModelId) ||
    !exactString(target.ownerUserId, 128) ||
    !sha256Pattern.test(target.vectorSpaceFingerprint) ||
    ![1_024, 1_536].includes(target.targetDimension) ||
    !Number.isSafeInteger(limit) || limit < 1 ||
    limit > KNOWLEDGE_BULK_ACTIVATION_MAX_SOURCES ||
    !Number.isFinite(now.getTime())) {
    throw new KnowledgeBulkActivationError("knowledge_bulk_activation_input_invalid");
  }
}

async function assertTarget(
  tx: Prisma.TransactionClient,
  target: KnowledgeBulkEmbeddingTarget,
  lock: "share" | "update"
): Promise<void> {
  const lockClause = lock === "update"
    ? Prisma.sql`FOR UPDATE OF base, generation`
    : Prisma.sql`FOR SHARE OF base, generation`;
  const rows = await tx.$queryRaw<Array<{
    embeddingProviderModelId: string;
    ownerUserId: string;
    profileRevisionId: string | null;
    targetDimension: number;
    vectorSpaceFingerprint: string;
  }>>(Prisma.sql`
    SELECT
      base."ownerUserId",
      generation."profileRevisionId",
      generation."embeddingProviderModelId",
      generation."targetDimension",
      generation."vectorSpaceFingerprint"
    FROM "KnowledgeBase" AS base
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND generation."id" = base."activeIndexGenerationId"
     AND generation."id" = ${target.generationId}
     AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
    WHERE base."id" = ${target.knowledgeBaseId}
      AND base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
    ${lockClause}
  `);
  const row = rows[0];
  if (rows.length !== 1 || row?.ownerUserId !== target.ownerUserId ||
    row.profileRevisionId !== target.profileRevisionId ||
    row.embeddingProviderModelId !== target.embeddingProviderModelId ||
    row.targetDimension !== target.targetDimension ||
    row.vectorSpaceFingerprint.trim() !== target.vectorSpaceFingerprint) {
    throw new KnowledgeBulkActivationError("knowledge_bulk_activation_target_invalid");
  }
}

type ActivationCandidate = Readonly<{
  artifactId: string;
  chunkCount: number;
  sourceId: string;
  sourceVersionId: string;
}>;

async function activationCandidates(
  tx: Prisma.TransactionClient,
  target: KnowledgeBulkEmbeddingTarget,
  limit: number,
  now: Date
): Promise<readonly ActivationCandidate[]> {
  return tx.$queryRaw<ActivationCandidate[]>(Prisma.sql`
    SELECT
      artifact."id" AS "artifactId",
      artifact."chunkCount",
      source."id" AS "sourceId",
      version."id" AS "sourceVersionId"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = membership."sourceId"
     AND source."ownerUserId" = membership."ownerUserId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = source."pendingVersionId"
     AND version."sourceId" = source."id"
     AND version."ownerUserId" = source."ownerUserId"
    INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."sourceVersionId" = version."id"
     AND artifact."profileRevisionId" = ${target.profileRevisionId}
    WHERE membership."knowledgeBaseId" = ${target.knowledgeBaseId}
      AND membership."ownerUserId" = ${target.ownerUserId}
      AND membership."removedAt" IS NULL
      AND source."currentVersionId" IS NULL
      AND source."trashedAt" IS NULL
      AND source."deletionRequestedAt" IS NULL
      AND artifact."state" = 'pending'::"KnowledgeSourceArtifactState"
      AND artifact."processingStage" =
        'embedding'::"KnowledgeSourceArtifactProcessingStage"
      AND artifact."claimToken" IS NULL
      AND artifact."errorCode" IS NULL
      AND artifact."attemptCount" = 0
      AND artifact."nextAttemptAt" > ${now}
      AND artifact."chunkCount" IS NOT NULL
      AND artifact."chunkCount" > 0
      AND artifact."embeddedPassageCount" = artifact."chunkCount"
      AND NOT EXISTS (
        SELECT 1
        FROM "KnowledgeBaseSource" AS other_membership
        WHERE other_membership."sourceId" = source."id"
          AND other_membership."ownerUserId" = source."ownerUserId"
          AND other_membership."removedAt" IS NULL
          AND other_membership."knowledgeBaseId" <> ${target.knowledgeBaseId}
      )
    LIMIT ${limit}
    FOR UPDATE OF artifact, source SKIP LOCKED
  `);
}

async function assertCandidatePassages(
  tx: Prisma.TransactionClient,
  target: KnowledgeBulkEmbeddingTarget,
  candidates: readonly ActivationCandidate[]
): Promise<void> {
  if (candidates.length === 0) return;
  const rows = await tx.$queryRaw<Array<{
    artifactId: string;
    embeddingCount: number;
    passageCount: number;
  }>>(Prisma.sql`
    SELECT
      artifact."id" AS "artifactId",
      count(passage."id")::integer AS "passageCount",
      count(embedding."passageId")::integer AS "embeddingCount"
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
     AND embedding."embeddingDimension" = ${target.targetDimension}
     AND btrim(embedding."embeddingTextHash") =
         btrim(passage."embeddingTextHash")
    WHERE artifact."id" IN (${Prisma.join(
      candidates.map(({ artifactId }) => artifactId)
    )})
      AND artifact."profileRevisionId" = ${target.profileRevisionId}
    GROUP BY artifact."id"
  `);
  const byArtifact = new Map(rows.map((row) => [row.artifactId, row]));
  if (rows.length !== candidates.length || candidates.some((candidate) => {
    const row = byArtifact.get(candidate.artifactId);
    return !row || row.passageCount !== candidate.chunkCount ||
      row.embeddingCount !== candidate.chunkCount;
  })) {
    throw new KnowledgeBulkActivationError("knowledge_bulk_activation_conflict");
  }
}

export function createPrismaKnowledgeBulkActivationRepository(
  client: PrismaClient
) {
  return Object.freeze({
    async activateNextBatch(input: KnowledgeBulkEmbeddingTarget & Readonly<{
      limit: number;
      now: Date;
    }>): Promise<KnowledgeBulkActivationResult> {
      assertKnowledgeBulkActivationInput(input, input.limit, input.now);
      return client.$transaction(async (tx) => {
        await assertTarget(tx, input, "update");
        const candidates = await activationCandidates(
          tx,
          input,
          input.limit,
          input.now
        );
        if (candidates.length === 0) {
          return Object.freeze({ activatedSources: 0 });
        }
        await assertCandidatePassages(tx, input, candidates);
        const rows = candidates.map((candidate) => Prisma.sql`
          (${candidate.artifactId}, ${candidate.sourceId}, ${candidate.sourceVersionId})
        `);
        const activatedArtifacts = await tx.$executeRaw(Prisma.sql`
          UPDATE "KnowledgeSourceIndexArtifact" AS artifact
          SET "attemptCount" = 0,
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "errorCode" = NULL,
              "nextAttemptAt" = ${input.now},
              "processingStage" = NULL,
              "readyAt" = ${input.now},
              "state" = 'ready'::"KnowledgeSourceArtifactState",
              "updatedAt" = ${input.now}
          FROM (VALUES ${Prisma.join(rows)})
            AS expected("artifactId", "sourceId", "sourceVersionId")
          WHERE artifact."id" = expected."artifactId"
            AND artifact."sourceVersionId" = expected."sourceVersionId"
            AND artifact."profileRevisionId" = ${input.profileRevisionId}
            AND artifact."state" = 'pending'::"KnowledgeSourceArtifactState"
            AND artifact."processingStage" =
              'embedding'::"KnowledgeSourceArtifactProcessingStage"
            AND artifact."claimToken" IS NULL
            AND artifact."embeddedPassageCount" = artifact."chunkCount"
        `);
        const activatedSources = await tx.$executeRaw(Prisma.sql`
          UPDATE "KnowledgeSource" AS source
          SET "currentVersionId" = expected."sourceVersionId",
              "pendingVersionId" = NULL,
              "version" = source."version" + 1,
              "updatedAt" = ${input.now}
          FROM (VALUES ${Prisma.join(rows)})
            AS expected("artifactId", "sourceId", "sourceVersionId")
          WHERE source."id" = expected."sourceId"
            AND source."ownerUserId" = ${input.ownerUserId}
            AND source."currentVersionId" IS NULL
            AND source."pendingVersionId" = expected."sourceVersionId"
            AND source."trashedAt" IS NULL
            AND source."deletionRequestedAt" IS NULL
        `);
        if (activatedArtifacts !== candidates.length ||
          activatedSources !== candidates.length) {
          throw new KnowledgeBulkActivationError("knowledge_bulk_activation_conflict");
        }
        const updatedBase = await tx.knowledgeBase.updateMany({
          data: {
            updatedAt: input.now,
            version: { increment: candidates.length }
          },
          where: {
            activeIndexGenerationId: input.generationId,
            archivedAt: null,
            deletionRequestedAt: null,
            id: input.knowledgeBaseId,
            ownerUserId: input.ownerUserId,
            trashedAt: null
          }
        });
        if (updatedBase.count !== 1) {
          throw new KnowledgeBulkActivationError("knowledge_bulk_activation_conflict");
        }
        return Object.freeze({ activatedSources });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_TIMEOUT_MS
      });
    },

    async inspect(input: KnowledgeBulkEmbeddingTarget):
    Promise<KnowledgeBulkActivationInspection> {
      assertKnowledgeBulkActivationInput(input, 1, new Date());
      return client.$transaction(async (tx) => {
        await assertTarget(tx, input, "share");
        const rows = await tx.$queryRaw<Array<{
          pendingSources: number;
          readySources: number;
          totalSources: number;
        }>>(Prisma.sql`
          SELECT
            count(*)::integer AS "totalSources",
            count(*) FILTER (WHERE
              source."currentVersionId" = version."id"
              AND source."pendingVersionId" IS NULL
              AND artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
              AND artifact."processingStage" IS NULL
              AND artifact."readyAt" IS NOT NULL
              AND artifact."chunkCount" = artifact."embeddedPassageCount"
            )::integer AS "readySources",
            count(*) FILTER (WHERE
              source."currentVersionId" IS NULL
              AND source."pendingVersionId" = version."id"
              AND artifact."state" = 'pending'::"KnowledgeSourceArtifactState"
              AND artifact."processingStage" =
                'embedding'::"KnowledgeSourceArtifactProcessingStage"
            )::integer AS "pendingSources"
          FROM "KnowledgeBaseSource" AS membership
          INNER JOIN "KnowledgeSource" AS source
            ON source."id" = membership."sourceId"
           AND source."ownerUserId" = membership."ownerUserId"
          INNER JOIN "KnowledgeSourceVersion" AS version
            ON version."sourceId" = source."id"
           AND version."ownerUserId" = source."ownerUserId"
           AND (source."currentVersionId" = version."id" OR
                source."pendingVersionId" = version."id")
          INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
            ON artifact."sourceVersionId" = version."id"
           AND artifact."profileRevisionId" = ${input.profileRevisionId}
          WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
            AND membership."ownerUserId" = ${input.ownerUserId}
            AND membership."removedAt" IS NULL
            AND source."trashedAt" IS NULL
            AND source."deletionRequestedAt" IS NULL
        `);
        const row = rows[0];
        if (rows.length !== 1 || !row) {
          throw new KnowledgeBulkActivationError("knowledge_bulk_activation_conflict");
        }
        return Object.freeze(row);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_BULK_ACTIVATION_TRANSACTION_TIMEOUT_MS
      });
    }
  });
}

export type PrismaKnowledgeBulkActivationRepository = ReturnType<
  typeof createPrismaKnowledgeBulkActivationRepository
>;
