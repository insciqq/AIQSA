import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { KNOWLEDGE_EMBEDDING_BATCH_SIZE, type KnowledgeChunkPlanEntry } from "./chunking";
import {
  buildAndPersistKnowledgeHierarchicalIndex,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS
} from "./hierarchicalIndexRepository";
import type { StoredKnowledgeNormalizedDocument } from "./normalizedDocument";
import type {
  KnowledgeEmbeddingBatchWrite,
  KnowledgeSourceArtifactPinRecord,
  KnowledgeIngestionFailureCode,
  KnowledgeIngestionWarningCode,
  KnowledgeSourceWorkClaim,
  KnowledgeWorkClaim,
  KnowledgeWorkIdentity
} from "./ingestionTypes";
import {
  knowledgeProfileMigrationChanged,
  reconcileActiveKnowledgeProfileMigrations,
  settleKnowledgeProfileMigrationsForSource
} from "./profileMigration";
import { knowledgeSourceNormalizedTextStorageKey } from "./sourceArtifactKeys";

type SourceClaimRow = Readonly<{
  artifactId: string;
  attemptCount: number;
  byteSize: number;
  checksum: string;
  chunkCount: number | null;
  chunkingProfileVersion: number;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  fileName: string;
  knowledgeBaseId: string;
  mimeType: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  originalStorageKey: string | null;
  ownerUserId: string;
  pdfParserProfileVersion: number;
  pdfProcessingMode: "local" | "system_model_direct_pdf" | "system_model_vision";
  pdfSystemModelPolicyVersion: number | null;
  pdfSystemModelSnapshot: Prisma.JsonValue | null;
  processingGeneration: number;
  profileExecutionAuthority: "installation" | "legacy_user";
  profileRevisionId: string;
  sourceId: string;
  sourceVersionId: string;
  state: "chunking" | "embedding" | "parsing" | "queued";
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type LockedArtifactRow = Readonly<{
  artifactId: string;
  chunkCount: number | null;
  currentVersionId: string | null;
  ownerUserId: string;
  pendingVersionId: string | null;
  profileRevisionId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

type GenerationMembershipRow = Readonly<{
  generationStatus: "active" | "building";
  knowledgeBaseId: string;
  profileRevisionId: string | null;
}>;

function sourceIdentity(input: KnowledgeWorkIdentity): Readonly<{
  artifactId: string;
  claimToken: string;
  sourceVersionId: string;
}> {
  return {
    artifactId: input.artifactId,
    claimToken: input.claimToken,
    sourceVersionId: input.sourceVersionId
  };
}

function artifactPin(row: SourceClaimRow): KnowledgeSourceArtifactPinRecord {
  return {
    chunkingProfileVersion: row.chunkingProfileVersion,
    embeddingConfiguration:
      row.embeddingConfiguration as unknown as KnowledgeSourceArtifactPinRecord["embeddingConfiguration"],
    embeddingProviderModelId: row.embeddingProviderModelId,
    id: row.artifactId,
    pdfParserProfileVersion: row.pdfParserProfileVersion,
    pdfProcessingMode: row.pdfProcessingMode,
    pdfSystemModelPolicyVersion: row.pdfSystemModelPolicyVersion,
    pdfSystemModelSnapshot: row.pdfSystemModelSnapshot,
    processingGeneration: row.processingGeneration,
    profileExecutionAuthority: row.profileExecutionAuthority,
    profileRevisionId: row.profileRevisionId,
    targetDimension: row.targetDimension,
    vectorSpaceFingerprint: row.vectorSpaceFingerprint.trim()
  };
}

function sourceClaim(row: SourceClaimRow, claimToken: string): KnowledgeSourceWorkClaim {
  return {
    attemptCount: row.attemptCount,
    byteSize: row.byteSize,
    checksum: row.checksum.trim(),
    claimToken,
    sourceId: row.sourceId,
    sourceVersionId: row.sourceVersionId,
    fileName: row.fileName,
    artifact: artifactPin(row),
    ingestChunkCount: row.chunkCount,
    knowledgeBaseId: row.knowledgeBaseId,
    mimeType: row.mimeType,
    normalizedTextByteSize: row.normalizedTextByteSize,
    normalizedTextChecksum: row.normalizedTextChecksum?.trim() ?? null,
    normalizedTextStorageKey: row.normalizedTextStorageKey,
    originalStorageKey: row.originalStorageKey,
    ownerUserId: row.ownerUserId,
    state: row.state
  };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function validChunk(chunk: KnowledgeEmbeddingBatchWrite["chunks"][number], dimension: number): boolean {
  return chunk.vector.length === dimension &&
    chunk.vector.every(Number.isFinite) &&
    /^[0-9a-f]{64}$/u.test(chunk.contentHash) &&
    /^[0-9a-f]{64}$/u.test(chunk.embeddingTextHash) &&
    chunk.contextPrefix.length <= 1_024 &&
    Number.isSafeInteger(chunk.index) && chunk.index >= 0 &&
    Number.isSafeInteger(chunk.page) && chunk.page >= 1 &&
    Number.isSafeInteger(chunk.pageEnd) && chunk.pageEnd >= chunk.page &&
    Number.isSafeInteger(chunk.sourceBlockStart) && chunk.sourceBlockStart >= 0 &&
    Number.isSafeInteger(chunk.sourceBlockEnd) && chunk.sourceBlockEnd >= chunk.sourceBlockStart &&
    Number.isSafeInteger(chunk.tokenCount) && chunk.tokenCount >= 1;
}

async function lockFairnessCursor(tx: Prisma.TransactionClient): Promise<string | null> {
  await tx.$executeRaw`
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES ('knowledge', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT ("pipeline") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ lastGrantedOwnerUserId: string | null }>>`
    SELECT "lastGrantedOwnerUserId"
    FROM "DocumentProcessingFairnessCursor"
    WHERE "pipeline" = 'knowledge'
    FOR UPDATE
  `;
  if (!rows[0]) throw new Error("knowledge_fairness_cursor_unavailable");
  return rows[0].lastGrantedOwnerUserId;
}

async function eligibleOwner(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; staleBefore: Date }>,
  lastGrantedOwnerUserId: string | null
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ ownerUserId: string }>>(Prisma.sql`
    SELECT version."ownerUserId"
    FROM "KnowledgeSourceIndexArtifact" AS artifact
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = artifact."sourceVersionId"
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = version."sourceId"
     AND source."ownerUserId" = version."ownerUserId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
    WHERE artifact."state" IN (
        'pending'::"KnowledgeSourceArtifactState",
        'processing'::"KnowledgeSourceArtifactState"
      )
      AND artifact."processingStage" IS NOT NULL
      AND artifact."nextAttemptAt" <= ${input.now}
      AND (artifact."claimedAt" IS NULL OR artifact."claimedAt" < ${input.staleBefore})
      AND source."trashedAt" IS NULL
      AND source."deletionRequestedAt" IS NULL
      AND (
        source."currentVersionId" = version."id"
        OR source."pendingVersionId" = version."id"
      )
      AND owner_user."status" = 'active'::"UserStatus"
      AND EXISTS (
        SELECT 1
        FROM "KnowledgeBaseSource" AS membership
        INNER JOIN "KnowledgeBase" AS base
          ON base."id" = membership."knowledgeBaseId"
         AND base."ownerUserId" = membership."ownerUserId"
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = base."id"
         AND generation."profileRevisionId" = artifact."profileRevisionId"
         AND (
           generation."id" = base."activeIndexGenerationId"
             AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
           OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
             AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
             AND generation."sourceBaseVersion" = base."version"
             AND generation."targetContentRevision" = base."contentRevision"
             AND generation."targetSourceRevision" = base."sourceRevision"
             AND EXISTS (
               SELECT 1
               FROM "KnowledgeIndexProfile" AS active_profile
               WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
             )
         )
        WHERE membership."sourceId" = source."id"
          AND membership."ownerUserId" = source."ownerUserId"
          AND membership."removedAt" IS NULL
          AND base."archivedAt" IS NULL
          AND base."trashedAt" IS NULL
          AND base."deletionRequestedAt" IS NULL
      )
    GROUP BY version."ownerUserId"
    ORDER BY
      CASE
        WHEN ${lastGrantedOwnerUserId}::text IS NULL THEN 0
        WHEN version."ownerUserId" > ${lastGrantedOwnerUserId}::text THEN 0
        ELSE 1
      END,
      version."ownerUserId"
    LIMIT 1
  `);
  return rows[0]?.ownerUserId ?? null;
}

async function claimForOwner(
  tx: Prisma.TransactionClient,
  input: Readonly<{ claimToken: string; now: Date; staleBefore: Date }>,
  ownerUserId: string
): Promise<KnowledgeSourceWorkClaim | null> {
  const rows = await tx.$queryRaw<SourceClaimRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT artifact."id"
      FROM "KnowledgeSourceIndexArtifact" AS artifact
      INNER JOIN "KnowledgeSourceVersion" AS version
        ON version."id" = artifact."sourceVersionId"
      INNER JOIN "KnowledgeSource" AS source
        ON source."id" = version."sourceId"
       AND source."ownerUserId" = version."ownerUserId"
      INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
      WHERE artifact."state" IN (
          'pending'::"KnowledgeSourceArtifactState",
          'processing'::"KnowledgeSourceArtifactState"
        )
        AND artifact."processingStage" IS NOT NULL
        AND artifact."nextAttemptAt" <= ${input.now}
        AND (artifact."claimedAt" IS NULL OR artifact."claimedAt" < ${input.staleBefore})
        AND source."ownerUserId" = ${ownerUserId}
        AND source."trashedAt" IS NULL
        AND source."deletionRequestedAt" IS NULL
        AND (
          source."currentVersionId" = version."id"
          OR source."pendingVersionId" = version."id"
        )
        AND owner_user."status" = 'active'::"UserStatus"
        AND EXISTS (
          SELECT 1
          FROM "KnowledgeBaseSource" AS membership
          INNER JOIN "KnowledgeBase" AS base
            ON base."id" = membership."knowledgeBaseId"
           AND base."ownerUserId" = membership."ownerUserId"
          INNER JOIN "KnowledgeIndexGeneration" AS generation
            ON generation."knowledgeBaseId" = base."id"
           AND generation."profileRevisionId" = artifact."profileRevisionId"
           AND (
             generation."id" = base."activeIndexGenerationId"
               AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
             OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
               AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
               AND generation."sourceBaseVersion" = base."version"
               AND generation."targetContentRevision" = base."contentRevision"
               AND generation."targetSourceRevision" = base."sourceRevision"
               AND EXISTS (
                 SELECT 1
                 FROM "KnowledgeIndexProfile" AS active_profile
                 WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
               )
           )
          WHERE membership."sourceId" = source."id"
            AND membership."ownerUserId" = source."ownerUserId"
            AND membership."removedAt" IS NULL
            AND base."archivedAt" IS NULL
            AND base."trashedAt" IS NULL
            AND base."deletionRequestedAt" IS NULL
        )
      ORDER BY artifact."nextAttemptAt", artifact."createdAt", artifact."id"
      LIMIT 1
      FOR UPDATE OF artifact SKIP LOCKED
    ), claimed AS (
      UPDATE "KnowledgeSourceIndexArtifact" AS artifact
      SET "state" = 'processing'::"KnowledgeSourceArtifactState",
          "claimToken" = ${input.claimToken},
          "claimedAt" = ${input.now},
          "attemptCount" = artifact."attemptCount" + 1,
          "processingStartedAt" = COALESCE(artifact."processingStartedAt", ${input.now}),
          "updatedAt" = ${input.now}
      FROM candidate
      WHERE artifact."id" = candidate."id"
      RETURNING artifact.*
    )
    SELECT
      claimed."id" AS "artifactId",
      claimed."attemptCount",
      claimed."processingStage"::text AS "state",
      claimed."normalizedTextStorageKey",
      claimed."normalizedTextByteSize",
      claimed."normalizedTextChecksum",
      claimed."chunkCount",
      claimed."processingGeneration",
      version."id" AS "sourceVersionId",
      version."sourceId",
      version."ownerUserId",
      version."fileName",
      version."mimeType",
      version."byteSize",
      version."checksum",
      version."originalStorageKey",
      profile."id" AS "profileRevisionId",
      profile."embeddingProviderModelId",
      profile."embeddingConfiguration",
      profile."vectorSpaceFingerprint",
      profile."targetDimension",
      profile."chunkingProfileVersion",
      profile."pdfProcessingMode"::text AS "pdfProcessingMode",
      profile."pdfParserProfileVersion",
      profile."pdfSystemModelPolicyVersion",
      profile."pdfSystemModelSnapshot",
      profile."executionAuthority"::text AS "profileExecutionAuthority",
      origin."knowledgeBaseId"
    FROM claimed
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = claimed."sourceVersionId"
    INNER JOIN "KnowledgeIndexProfileRevision" AS profile
      ON profile."id" = claimed."profileRevisionId"
    INNER JOIN LATERAL (
      SELECT base."id" AS "knowledgeBaseId"
      FROM "KnowledgeBaseSource" AS membership
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = membership."knowledgeBaseId"
       AND base."ownerUserId" = membership."ownerUserId"
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."knowledgeBaseId" = base."id"
       AND generation."profileRevisionId" = claimed."profileRevisionId"
       AND (
         generation."id" = base."activeIndexGenerationId"
           AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
         OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
           AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
           AND generation."sourceBaseVersion" = base."version"
           AND generation."targetContentRevision" = base."contentRevision"
           AND generation."targetSourceRevision" = base."sourceRevision"
           AND EXISTS (
             SELECT 1
             FROM "KnowledgeIndexProfile" AS active_profile
             WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
           )
       )
      WHERE membership."sourceId" = version."sourceId"
        AND membership."ownerUserId" = version."ownerUserId"
        AND membership."removedAt" IS NULL
        AND base."archivedAt" IS NULL
        AND base."trashedAt" IS NULL
        AND base."deletionRequestedAt" IS NULL
      ORDER BY base."id"
      LIMIT 1
    ) AS origin ON true
  `);
  return rows[0] ? sourceClaim(rows[0], input.claimToken) : null;
}

async function lockedArtifact(
  tx: Prisma.TransactionClient,
  identity: Readonly<{ artifactId: string; claimToken: string; sourceVersionId: string }>,
  stage: "chunking" | "embedding" | "parsing" | "queued"
): Promise<LockedArtifactRow | null> {
  const rows = await tx.$queryRaw<LockedArtifactRow[]>(Prisma.sql`
    SELECT
      artifact."id" AS "artifactId",
      artifact."sourceVersionId",
      artifact."profileRevisionId",
      artifact."chunkCount",
      version."sourceId",
      version."ownerUserId",
      source."currentVersionId",
      source."pendingVersionId"
    FROM "KnowledgeSourceIndexArtifact" AS artifact
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."id" = artifact."sourceVersionId"
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = version."sourceId"
     AND source."ownerUserId" = version."ownerUserId"
    WHERE artifact."id" = ${identity.artifactId}
      AND artifact."sourceVersionId" = ${identity.sourceVersionId}
      AND artifact."claimToken" = ${identity.claimToken}
      AND artifact."state" = 'processing'::"KnowledgeSourceArtifactState"
      AND artifact."processingStage" = ${stage}::"KnowledgeSourceArtifactProcessingStage"
      AND source."trashedAt" IS NULL
      AND source."deletionRequestedAt" IS NULL
    FOR UPDATE OF artifact, source
  `);
  return rows[0] ?? null;
}

async function generationMemberships(
  tx: Prisma.TransactionClient,
  sourceId: string,
  ownerUserId: string
): Promise<GenerationMembershipRow[]> {
  return tx.$queryRaw<GenerationMembershipRow[]>(Prisma.sql`
    SELECT
      base."id" AS "knowledgeBaseId",
      generation."profileRevisionId",
      generation."status"::text AS "generationStatus"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = membership."knowledgeBaseId"
     AND base."ownerUserId" = membership."ownerUserId"
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND (
       generation."id" = base."activeIndexGenerationId"
         AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
       OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
         AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
         AND generation."sourceBaseVersion" = base."version"
         AND generation."targetContentRevision" = base."contentRevision"
         AND generation."targetSourceRevision" = base."sourceRevision"
         AND EXISTS (
           SELECT 1
           FROM "KnowledgeIndexProfile" AS active_profile
           WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
         )
     )
    WHERE membership."sourceId" = ${sourceId}
      AND membership."ownerUserId" = ${ownerUserId}
      AND membership."removedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
      AND generation."profileRevisionId" IS NOT NULL
    ORDER BY base."id", generation."status", generation."id"
    FOR UPDATE OF base
  `);
}

export function createPrismaKnowledgeSourceIngestionRepository(
  client: PrismaClient = prisma
) {
  return {
    async activateSourceVersion(input: KnowledgeWorkIdentity & {
      expectedChunkCount: number;
      now: Date;
    }): Promise<"activated" | "deferred" | "lease_lost" | "retargeted"> {
      const identity = sourceIdentity(input);
      if (input.expectedChunkCount < 1) return "lease_lost";
      return client.$transaction(async (tx) => {
        const artifact = await lockedArtifact(tx, identity, "embedding");
        if (!artifact || artifact.chunkCount !== input.expectedChunkCount) return "lease_lost";
        const counts = await tx.$queryRaw<Array<{
          embeddingCount: number;
          passageCount: number;
        }>>`
          SELECT
            count(passage."id")::integer AS "passageCount",
            count(embedding."passageId")::integer AS "embeddingCount"
          FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
            ON passage."indexArtifactId" = hierarchy."id"
          LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
            ON embedding."indexArtifactId" = passage."indexArtifactId"
           AND embedding."passageId" = passage."id"
          WHERE hierarchy."sourceArtifactId" = ${artifact.artifactId}
            AND hierarchy."sourceVersionId" = ${artifact.sourceVersionId}
            AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
        `;
        if (
          counts[0]?.passageCount !== input.expectedChunkCount ||
          counts[0]?.embeddingCount !== input.expectedChunkCount
        ) return "deferred";

        const memberships = await generationMemberships(
          tx,
          artifact.sourceId,
          artifact.ownerUserId
        );
        if (memberships.some(({ profileRevisionId }) => !profileRevisionId)) return "deferred";

        const settled = await tx.knowledgeSourceIndexArtifact.updateMany({
          data: {
            attemptCount: 0,
            claimToken: null,
            claimedAt: null,
            embeddedPassageCount: input.expectedChunkCount,
            errorCode: null,
            nextAttemptAt: input.now,
            processingStage: null,
            readyAt: input.now,
            state: "ready",
            updatedAt: input.now
          },
          where: {
            claimToken: identity.claimToken,
            id: identity.artifactId,
            processingStage: "embedding",
            sourceVersionId: identity.sourceVersionId,
            state: "processing"
          }
        });
        if (settled.count !== 1) return "lease_lost";

        if (artifact.pendingVersionId === artifact.sourceVersionId) {
          const requiredProfiles = [...new Set(memberships.map(({ profileRevisionId }) =>
            profileRevisionId!))];
          const readyProfiles = requiredProfiles.length === 0 ? [] : await tx.knowledgeSourceIndexArtifact.findMany({
            distinct: ["profileRevisionId"],
            select: { profileRevisionId: true },
            where: {
              profileRevisionId: { in: requiredProfiles },
              sourceVersionId: artifact.sourceVersionId,
              state: "ready"
            }
          });
          if (readyProfiles.length !== requiredProfiles.length) return "deferred";
          const activated = await tx.knowledgeSource.updateMany({
            data: {
              currentVersionId: artifact.sourceVersionId,
              pendingVersionId: null,
              version: { increment: 1 }
            },
            where: {
              id: artifact.sourceId,
              pendingVersionId: artifact.sourceVersionId,
              trashedAt: null
            }
          });
          if (activated.count !== 1) return "retargeted";
          if (memberships.length > 0) {
            await tx.knowledgeBase.updateMany({
              data: { version: { increment: 1 } },
              where: {
                id: { in: [...new Set(memberships.map(({ knowledgeBaseId }) => knowledgeBaseId))] }
              }
            });
          }
          await settleKnowledgeProfileMigrationsForSource(tx, {
            now: input.now,
            sourceId: artifact.sourceId
          });
          return "activated";
        }

        if (artifact.currentVersionId === artifact.sourceVersionId) {
          const matchingBaseIds = memberships
            .filter(({ generationStatus, profileRevisionId }) =>
              generationStatus === "active" && profileRevisionId === artifact.profileRevisionId)
            .map(({ knowledgeBaseId }) => knowledgeBaseId);
          if (matchingBaseIds.length > 0) {
            await tx.knowledgeBase.updateMany({
              data: { sourceRevision: { increment: 1 }, version: { increment: 1 } },
              where: { id: { in: [...new Set(matchingBaseIds)] } }
            });
          }
          await settleKnowledgeProfileMigrationsForSource(tx, {
            now: input.now,
            sourceId: artifact.sourceId
          });
          return "activated";
        }
        return "retargeted";
      });
    },

    async advanceSourceToParsing(
      input: KnowledgeWorkIdentity & { now: Date }
    ): Promise<boolean> {
      const identity = sourceIdentity(input);
      const updated = await client.knowledgeSourceIndexArtifact.updateMany({
        data: {
          attemptCount: 0,
          claimedAt: null,
          claimToken: null,
          errorCode: null,
          nextAttemptAt: input.now,
          processingStage: "parsing",
          state: "processing",
          updatedAt: input.now
        },
        where: {
          claimToken: identity.claimToken,
          id: identity.artifactId,
          processingStage: "queued",
          sourceVersionId: identity.sourceVersionId,
          state: "processing"
        }
      });
      return updated.count === 1;
    },

    async claim(input: {
      claimToken: string;
      now: Date;
      staleBefore: Date;
    }): Promise<KnowledgeWorkClaim | null> {
      return client.$transaction(async (tx) => {
        const cursor = await lockFairnessCursor(tx);
        const ownerUserId = await eligibleOwner(tx, input, cursor);
        if (!ownerUserId) return null;
        const claim = await claimForOwner(tx, input, ownerUserId);
        if (!claim) return null;
        const advanced = await tx.$executeRaw`
          UPDATE "DocumentProcessingFairnessCursor"
          SET "lastGrantedOwnerUserId" = ${ownerUserId},
              "updatedAt" = ${input.now}
          WHERE "pipeline" = 'knowledge'
        `;
        if (advanced !== 1) throw new Error("knowledge_fairness_cursor_lost");
        return claim;
      });
    },

    async completedBatchIndexes(
      artifactId: string,
      sourceVersionId: string
    ): Promise<number[]> {
      const rows = await client.$queryRaw<Array<{ batchIndex: number }>>`
        WITH batches AS (
          SELECT
            (passage."ordinal" / ${KNOWLEDGE_EMBEDDING_BATCH_SIZE})::integer AS "batchIndex",
            passage."id" AS "passageId",
            embedding."passageId" AS "embeddedPassageId"
          FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
            ON passage."indexArtifactId" = hierarchy."id"
          LEFT JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
            ON embedding."indexArtifactId" = passage."indexArtifactId"
           AND embedding."passageId" = passage."id"
          WHERE hierarchy."sourceArtifactId" = ${artifactId}
            AND hierarchy."sourceVersionId" = ${sourceVersionId}
            AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
        )
        SELECT "batchIndex"
        FROM batches
        GROUP BY "batchIndex"
        HAVING count("passageId") = count("embeddedPassageId")
        ORDER BY "batchIndex"
      `;
      return rows.map(({ batchIndex }) => batchIndex);
    },

    async completeChunking(input: KnowledgeWorkIdentity & {
      chunkCount: number;
      now: Date;
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      if (input.chunkCount < 1) return false;
      const updated = await client.knowledgeSourceIndexArtifact.updateMany({
        data: {
          attemptCount: 0,
          claimedAt: null,
          claimToken: null,
          chunkCount: input.chunkCount,
          embeddedPassageCount: 0,
          errorCode: null,
          nextAttemptAt: input.now,
          processingStage: "embedding",
          updatedAt: input.now
        },
        where: {
          claimToken: identity.claimToken,
          id: identity.artifactId,
          processingStage: "chunking",
          sourceVersionId: identity.sourceVersionId,
          state: "processing"
        }
      });
      return updated.count === 1;
    },

    async completeParsing(input: KnowledgeWorkIdentity & {
      normalizedTextByteSize: number;
      normalizedTextChecksum: string;
      normalizedTextStorageKey: string;
      now: Date;
      pageCount: number;
      warningCodes: readonly KnowledgeIngestionWarningCode[];
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      return client.$transaction(async (tx) => {
        const updated = await tx.knowledgeSourceIndexArtifact.updateMany({
          data: {
            attemptCount: 0,
            claimedAt: null,
            claimToken: null,
            errorCode: null,
            nextAttemptAt: input.now,
            normalizedTextByteSize: input.normalizedTextByteSize,
            normalizedTextChecksum: input.normalizedTextChecksum,
            normalizedTextStorageKey: input.normalizedTextStorageKey,
            pageCount: input.pageCount,
            processingStage: "chunking",
            updatedAt: input.now,
            warningCodes: [...input.warningCodes]
          },
          where: {
            claimToken: identity.claimToken,
            id: identity.artifactId,
            processingStage: "parsing",
            sourceVersionId: identity.sourceVersionId,
            state: "processing"
          }
        });
        if (updated.count !== 1) return false;
        await tx.knowledgePdfProcessingAttempt.updateMany({
          data: { resultChecksum: null, resultText: null, updatedAt: input.now },
          where: {
            sourceArtifactId: identity.artifactId,
            sourceVersionId: identity.sourceVersionId,
            state: "settled"
          }
        });
        return true;
      });
    },

    async heartbeat(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean> {
      const identity = sourceIdentity(input);
      const updated = await client.knowledgeSourceIndexArtifact.updateMany({
        data: { claimedAt: input.now, updatedAt: input.now },
        where: {
          claimToken: identity.claimToken,
          id: identity.artifactId,
          sourceVersionId: identity.sourceVersionId,
          state: "processing"
        }
      });
      return updated.count === 1;
    },

    async persistEmbeddingBatch(input: KnowledgeWorkIdentity & {
      batch: KnowledgeEmbeddingBatchWrite;
      now: Date;
      ownerUserId: string;
      targetDimension: number;
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      if (
        input.batch.chunks.length < 1 ||
        ![1_024, 1_536].includes(input.targetDimension) ||
        input.batch.chunks.some((chunk) => !validChunk(chunk, input.targetDimension))
      ) return false;

      return client.$transaction(async (tx) => {
        const artifact = await lockedArtifact(tx, identity, "embedding");
        if (!artifact || artifact.ownerUserId !== input.ownerUserId) return false;
        let inserted = 0;
        for (const chunk of input.batch.chunks) {
          const vector = vectorLiteral(chunk.vector);
          inserted += await tx.$executeRaw(Prisma.sql`
            INSERT INTO "KnowledgeArtifactPassageEmbedding" (
              "passageId", "indexArtifactId", "embeddingTextHash",
              "embeddingDimension", "embedding", "createdAt"
            )
            SELECT
              passage."id",
              passage."indexArtifactId",
              passage."embeddingTextHash",
              ${input.targetDimension},
              ${vector}::vector,
              ${input.now}
            FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
            INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
              ON passage."indexArtifactId" = hierarchy."id"
            WHERE hierarchy."sourceArtifactId" = ${identity.artifactId}
              AND hierarchy."sourceVersionId" = ${identity.sourceVersionId}
              AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
              AND passage."ordinal" = ${chunk.index}
              AND btrim(passage."embeddingTextHash") = ${chunk.embeddingTextHash}
              AND btrim(passage."contentHash") = ${chunk.contentHash}
            ON CONFLICT ("passageId") DO NOTHING
          `);
        }
        const indexes = input.batch.chunks.map(({ index }) => index);
        const accepted = await tx.$queryRaw<Array<{ acceptedCount: number }>>(Prisma.sql`
          SELECT count(*)::integer AS "acceptedCount"
          FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
            ON passage."indexArtifactId" = hierarchy."id"
          INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
            ON embedding."indexArtifactId" = passage."indexArtifactId"
           AND embedding."passageId" = passage."id"
          WHERE hierarchy."sourceArtifactId" = ${identity.artifactId}
            AND hierarchy."sourceVersionId" = ${identity.sourceVersionId}
            AND passage."ordinal" IN (${Prisma.join(indexes)})
            AND embedding."embeddingDimension" = ${input.targetDimension}
            AND btrim(embedding."embeddingTextHash") = btrim(passage."embeddingTextHash")
        `);
        if (accepted[0]?.acceptedCount !== input.batch.chunks.length) return false;

        if (inserted > 0) {
          await tx.usageEvent.create({
            data: {
              inputTokens: input.batch.usage.inputTokens ?? 0,
              modelId: input.batch.modelId,
              provider: input.batch.provider,
              totalTokens: input.batch.usage.totalTokens ?? input.batch.usage.inputTokens ?? 0,
              userId: input.ownerUserId
            }
          });
        }
        const totals = await tx.$queryRaw<Array<{ embeddedCount: number }>>`
          SELECT count(embedding."passageId")::integer AS "embeddedCount"
          FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
          INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
            ON passage."indexArtifactId" = hierarchy."id"
          INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
            ON embedding."indexArtifactId" = passage."indexArtifactId"
           AND embedding."passageId" = passage."id"
          WHERE hierarchy."sourceArtifactId" = ${identity.artifactId}
            AND hierarchy."sourceVersionId" = ${identity.sourceVersionId}
        `;
        await tx.knowledgeSourceIndexArtifact.update({
          data: { embeddedPassageCount: totals[0]?.embeddedCount ?? 0, updatedAt: input.now },
          where: { id: identity.artifactId }
        });
        return true;
      });
    },

    async persistHierarchicalIndex(input: KnowledgeWorkIdentity & {
      chunks: readonly KnowledgeChunkPlanEntry[];
      document: StoredKnowledgeNormalizedDocument | null;
      now: Date;
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      if (input.chunks.length < 1) return false;
      return client.$transaction(async (tx) => {
        const artifact = await lockedArtifact(tx, identity, "chunking");
        if (!artifact) return false;
        await buildAndPersistKnowledgeHierarchicalIndex(tx, {
          chunks: input.chunks,
          document: input.document,
          now: input.now,
          sourceArtifactId: artifact.artifactId,
          sourceVersionId: artifact.sourceVersionId
        });
        return true;
      }, {
        maxWait: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS
      });
    },

    async reconcile(input: { now: Date }): Promise<boolean> {
      const abandoned = await client.knowledgeSourceIndexArtifact.updateMany({
        data: {
          claimToken: null,
          claimedAt: null,
          errorCode: "knowledge_ingestion_failed",
          processingStage: null,
          state: "failed",
          updatedAt: input.now
        },
        where: {
          state: { in: ["pending", "processing"] },
          sourceVersion: {
            source: {
              OR: [
                { deletionRequestedAt: { not: null } },
                { trashedAt: { not: null } }
              ]
            }
          }
        }
      });

      const missing = await client.$queryRaw<Array<{
        ownerUserId: string;
        profileRevisionId: string;
        sourceId: string;
        sourceVersionId: string;
      }>>`
        SELECT DISTINCT
          source."ownerUserId",
          source."id" AS "sourceId",
          version."id" AS "sourceVersionId",
          generation."profileRevisionId"
        FROM "KnowledgeSource" AS source
        INNER JOIN "KnowledgeSourceVersion" AS version
          ON version."sourceId" = source."id"
         AND version."ownerUserId" = source."ownerUserId"
         AND (
           version."id" = source."currentVersionId"
           OR version."id" = source."pendingVersionId"
         )
        INNER JOIN "KnowledgeBaseSource" AS membership
          ON membership."sourceId" = source."id"
         AND membership."ownerUserId" = source."ownerUserId"
         AND membership."removedAt" IS NULL
        INNER JOIN "KnowledgeBase" AS base
          ON base."id" = membership."knowledgeBaseId"
         AND base."ownerUserId" = membership."ownerUserId"
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = base."id"
         AND (
           generation."id" = base."activeIndexGenerationId"
             AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
           OR generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
             AND generation."sourceIndexGenerationId" = base."activeIndexGenerationId"
             AND generation."sourceBaseVersion" = base."version"
             AND generation."targetContentRevision" = base."contentRevision"
             AND generation."targetSourceRevision" = base."sourceRevision"
             AND EXISTS (
               SELECT 1
               FROM "KnowledgeIndexProfile" AS active_profile
               WHERE active_profile."activeRevisionId" = generation."profileRevisionId"
             )
         )
        WHERE source."trashedAt" IS NULL
          AND source."deletionRequestedAt" IS NULL
          AND base."archivedAt" IS NULL
          AND base."trashedAt" IS NULL
          AND base."deletionRequestedAt" IS NULL
          AND generation."profileRevisionId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "KnowledgeSourceIndexArtifact" AS artifact
            WHERE artifact."sourceVersionId" = version."id"
              AND artifact."profileRevisionId" = generation."profileRevisionId"
          )
        ORDER BY version."id", generation."profileRevisionId"
        LIMIT 50
      `;
      if (missing.length > 0) {
        await client.knowledgeSourceIndexArtifact.createMany({
          data: missing.map((row) => {
            const artifactId = randomUUID();
            return {
              id: artifactId,
              nextAttemptAt: input.now,
              normalizedTextStorageKey: knowledgeSourceNormalizedTextStorageKey({
                artifactId,
                ownerUserId: row.ownerUserId,
                sourceId: row.sourceId,
                sourceVersionId: row.sourceVersionId
              }),
              processingStage: "queued" as const,
              profileRevisionId: row.profileRevisionId,
              sourceVersionId: row.sourceVersionId
            };
          }),
          skipDuplicates: true
        });
      }
      const migration = await reconcileActiveKnowledgeProfileMigrations(client, input.now);
      return abandoned.count > 0 || missing.length > 0 ||
        knowledgeProfileMigrationChanged(migration);
    },

    async retryLater(input: KnowledgeWorkIdentity & {
      errorCode: KnowledgeIngestionFailureCode;
      nextAttemptAt: Date;
      now: Date;
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      const updated = await client.knowledgeSourceIndexArtifact.updateMany({
        data: {
          claimToken: null,
          claimedAt: null,
          nextAttemptAt: input.nextAttemptAt,
          updatedAt: input.now
        },
        where: {
          claimToken: identity.claimToken,
          id: identity.artifactId,
          sourceVersionId: identity.sourceVersionId,
          state: "processing"
        }
      });
      return updated.count === 1;
    },

    async reuseEmbeddingChunks(input: KnowledgeWorkIdentity & {
      chunks: readonly KnowledgeChunkPlanEntry[];
      now: Date;
      targetDimension: number;
    }): Promise<number[]> {
      const identity = sourceIdentity(input);
      if (
        input.chunks.length === 0 ||
        ![1_024, 1_536].includes(input.targetDimension)
      ) return [];
      const reused: number[] = [];
      await client.$transaction(async (tx) => {
        if (!await lockedArtifact(tx, identity, "embedding")) return;
        for (const chunk of input.chunks) {
          if (!/^[0-9a-f]{64}$/u.test(chunk.embeddingTextHash)) continue;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "KnowledgeArtifactPassageEmbedding" (
              "passageId", "indexArtifactId", "embeddingTextHash",
              "embeddingDimension", "embedding", "createdAt"
            )
            SELECT
              target_passage."id",
              target_passage."indexArtifactId",
              target_passage."embeddingTextHash",
              source_embedding."embeddingDimension",
              source_embedding."embedding",
              ${input.now}
            FROM "KnowledgeSourceIndexArtifact" AS target_artifact
            INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS target_hierarchy
              ON target_hierarchy."sourceArtifactId" = target_artifact."id"
             AND target_hierarchy."sourceVersionId" = target_artifact."sourceVersionId"
             AND target_hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
            INNER JOIN "KnowledgeArtifactPassageIndex" AS target_passage
              ON target_passage."indexArtifactId" = target_hierarchy."id"
             AND target_passage."ordinal" = ${chunk.index}
            INNER JOIN LATERAL (
              SELECT embedding.*
              FROM "KnowledgeSourceIndexArtifact" AS source_artifact
              INNER JOIN "KnowledgeHierarchicalIndexArtifact" AS source_hierarchy
                ON source_hierarchy."sourceArtifactId" = source_artifact."id"
               AND source_hierarchy."sourceVersionId" = source_artifact."sourceVersionId"
               AND source_hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
              INNER JOIN "KnowledgeArtifactPassageIndex" AS source_passage
                ON source_passage."indexArtifactId" = source_hierarchy."id"
              INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
                ON embedding."indexArtifactId" = source_passage."indexArtifactId"
               AND embedding."passageId" = source_passage."id"
              WHERE source_artifact."profileRevisionId" = target_artifact."profileRevisionId"
                AND source_artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
                AND btrim(source_passage."embeddingTextHash") = ${chunk.embeddingTextHash}
                AND embedding."embeddingDimension" = ${input.targetDimension}
              ORDER BY embedding."createdAt" DESC, embedding."passageId"
              LIMIT 1
            ) AS source_embedding ON true
            WHERE target_artifact."id" = ${identity.artifactId}
              AND target_artifact."sourceVersionId" = ${identity.sourceVersionId}
              AND target_artifact."claimToken" = ${identity.claimToken}
              AND btrim(target_passage."embeddingTextHash") = ${chunk.embeddingTextHash}
            ON CONFLICT ("passageId") DO NOTHING
          `);
          const accepted = await tx.$queryRaw<Array<{ accepted: boolean }>>`
            SELECT EXISTS (
              SELECT 1
              FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
              INNER JOIN "KnowledgeArtifactPassageIndex" AS passage
                ON passage."indexArtifactId" = hierarchy."id"
              INNER JOIN "KnowledgeArtifactPassageEmbedding" AS embedding
                ON embedding."indexArtifactId" = passage."indexArtifactId"
               AND embedding."passageId" = passage."id"
              WHERE hierarchy."sourceArtifactId" = ${identity.artifactId}
                AND hierarchy."sourceVersionId" = ${identity.sourceVersionId}
                AND passage."ordinal" = ${chunk.index}
                AND btrim(embedding."embeddingTextHash") = ${chunk.embeddingTextHash}
                AND embedding."embeddingDimension" = ${input.targetDimension}
            ) AS "accepted"
          `;
          if (accepted[0]?.accepted) reused.push(chunk.index);
        }
      });
      return reused;
    },

    async settleFailed(input: KnowledgeWorkIdentity & {
      errorCode: KnowledgeIngestionFailureCode;
      now: Date;
    }): Promise<boolean> {
      const identity = sourceIdentity(input);
      const updated = await client.knowledgeSourceIndexArtifact.updateMany({
        data: {
          claimToken: null,
          claimedAt: null,
          errorCode: input.errorCode,
          processingStage: null,
          readyAt: null,
          state: "failed",
          updatedAt: input.now
        },
        where: {
          claimToken: identity.claimToken,
          id: identity.artifactId,
          sourceVersionId: identity.sourceVersionId,
          state: "processing"
        }
      });
      return updated.count === 1;
    }
  };
}

export type PrismaKnowledgeSourceIngestionRepository = ReturnType<
  typeof createPrismaKnowledgeSourceIngestionRepository
>;
