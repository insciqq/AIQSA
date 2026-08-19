import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_INDEX_PROFILE_ID } from "./knowledgeProfile";
import { knowledgeSourceNormalizedTextStorageKey } from "./sourceArtifactKeys";
import { materializeKnowledgeBaseSnapshot } from "./sourcePersistence";

const SUPERSEDED_ERROR_CODE = "knowledge_profile_superseded";
const MIGRATION_BATCH_SIZE = 50;

type BaseCandidate = Readonly<{
  activeGenerationId: string;
  activeProfileRevisionId: string | null;
  contentRevision: number;
  knowledgeBaseId: string;
  ownerUserId: string;
  sourceRevision: number;
  version: number;
}>;

type SourceVersionTarget = Readonly<{
  ownerUserId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

type ReadinessCount = Readonly<{
  readySourceCount: number;
  requiredSourceCount: number;
}>;

export type KnowledgeProfileMigrationResult = Readonly<{
  activatedBases: number;
  alreadyActiveBases: number;
  buildingBases: number;
  createdGenerations: number;
  queuedArtifacts: number;
  supersededGenerations: number;
}>;

function emptyResult(): KnowledgeProfileMigrationResult {
  return {
    activatedBases: 0,
    alreadyActiveBases: 0,
    buildingBases: 0,
    createdGenerations: 0,
    queuedArtifacts: 0,
    supersededGenerations: 0
  };
}

function addResult(
  left: KnowledgeProfileMigrationResult,
  right: KnowledgeProfileMigrationResult
): KnowledgeProfileMigrationResult {
  return {
    activatedBases: left.activatedBases + right.activatedBases,
    alreadyActiveBases: left.alreadyActiveBases + right.alreadyActiveBases,
    buildingBases: left.buildingBases + right.buildingBases,
    createdGenerations: left.createdGenerations + right.createdGenerations,
    queuedArtifacts: left.queuedArtifacts + right.queuedArtifacts,
    supersededGenerations: left.supersededGenerations + right.supersededGenerations
  };
}

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      error.code === "P2010" && typeof error.meta === "object" && error.meta !== null &&
      "code" in error.meta && error.meta.code === "40001");
}

async function liveBaseCandidates(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    knowledgeBaseIds?: readonly string[];
    limit: number;
    profileRevisionId: string;
  }>
): Promise<BaseCandidate[]> {
  if (input.knowledgeBaseIds?.length === 0) return [];
  const scope = input.knowledgeBaseIds
    ? Prisma.sql`AND base."id" IN (${Prisma.join([...input.knowledgeBaseIds])})`
    : Prisma.empty;
  return tx.$queryRaw<BaseCandidate[]>(Prisma.sql`
    SELECT
      base."id" AS "knowledgeBaseId",
      base."ownerUserId",
      base."version",
      base."contentRevision",
      base."sourceRevision",
      active_generation."id" AS "activeGenerationId",
      active_generation."profileRevisionId" AS "activeProfileRevisionId"
    FROM "KnowledgeBase" AS base
    INNER JOIN "KnowledgeIndexGeneration" AS active_generation
      ON active_generation."knowledgeBaseId" = base."id"
     AND active_generation."id" = base."activeIndexGenerationId"
     AND active_generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
    WHERE base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
      AND active_generation."profileRevisionId" IS DISTINCT FROM ${input.profileRevisionId}
      ${scope}
    ORDER BY
      CASE WHEN EXISTS (
        SELECT 1
        FROM "KnowledgeIndexGeneration" AS current_shadow
        WHERE current_shadow."knowledgeBaseId" = base."id"
          AND current_shadow."profileRevisionId" = ${input.profileRevisionId}
          AND current_shadow."status" = 'building'::"KnowledgeIndexGenerationStatus"
          AND current_shadow."sourceIndexGenerationId" = base."activeIndexGenerationId"
          AND current_shadow."sourceBaseVersion" = base."version"
          AND current_shadow."targetContentRevision" = base."contentRevision"
          AND current_shadow."targetSourceRevision" = base."sourceRevision"
      ) THEN 1 ELSE 0 END,
      base."id"
    LIMIT ${input.limit}
    FOR UPDATE OF base, active_generation
  `);
}

async function queueArtifacts(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    knowledgeBaseId: string;
    now: Date;
    profileRevisionId: string;
  }>
): Promise<number> {
  const targets = await tx.$queryRaw<SourceVersionTarget[]>(Prisma.sql`
    SELECT
      source."ownerUserId",
      source."id" AS "sourceId",
      version."id" AS "sourceVersionId"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = membership."sourceId"
     AND source."ownerUserId" = membership."ownerUserId"
    INNER JOIN "KnowledgeSourceVersion" AS version
      ON version."sourceId" = source."id"
     AND version."ownerUserId" = source."ownerUserId"
     AND (
       version."id" = source."currentVersionId"
       OR version."id" = source."pendingVersionId"
     )
    WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND membership."removedAt" IS NULL
      AND source."trashedAt" IS NULL
      AND source."deletionRequestedAt" IS NULL
    ORDER BY version."id"
    FOR SHARE OF membership, source, version
  `);
  if (targets.length === 0) return 0;
  const created = await tx.knowledgeSourceIndexArtifact.createMany({
    data: targets.map((target) => {
      const artifactId = randomUUID();
      return {
        id: artifactId,
        nextAttemptAt: input.now,
        normalizedTextStorageKey: knowledgeSourceNormalizedTextStorageKey({
          artifactId,
          ownerUserId: target.ownerUserId,
          sourceId: target.sourceId,
          sourceVersionId: target.sourceVersionId
        }),
        processingStage: "queued" as const,
        profileRevisionId: input.profileRevisionId,
        sourceVersionId: target.sourceVersionId,
        state: "pending" as const
      };
    }),
    skipDuplicates: true
  });
  return created.count;
}

async function readiness(
  tx: Prisma.TransactionClient,
  input: Readonly<{ knowledgeBaseId: string; profileRevisionId: string }>
): Promise<ReadinessCount> {
  const rows = await tx.$queryRaw<ReadinessCount[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE source."currentVersionId" IS NOT NULL)::integer
        AS "requiredSourceCount",
      count(*) FILTER (
        WHERE source."currentVersionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "KnowledgeSourceIndexArtifact" AS artifact
            WHERE artifact."sourceVersionId" = source."currentVersionId"
              AND artifact."profileRevisionId" = ${input.profileRevisionId}
              AND artifact."state" = 'ready'::"KnowledgeSourceArtifactState"
              AND EXISTS (
                SELECT 1
                FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
                WHERE hierarchy."sourceArtifactId" = artifact."id"
                  AND hierarchy."sourceVersionId" = artifact."sourceVersionId"
                  AND hierarchy."state" = 'ready'::"KnowledgeHierarchicalIndexState"
              )
          )
      )::integer AS "readySourceCount"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = membership."sourceId"
     AND source."ownerUserId" = membership."ownerUserId"
    WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND membership."removedAt" IS NULL
      AND source."trashedAt" IS NULL
      AND source."deletionRequestedAt" IS NULL
  `);
  return rows[0] ?? { readySourceCount: 0, requiredSourceCount: 0 };
}

async function failBuildingGeneration(
  tx: Prisma.TransactionClient,
  generationId: string,
  now: Date
): Promise<boolean> {
  const failed = await tx.knowledgeIndexGeneration.updateMany({
    data: {
      failedAt: now,
      lastErrorCode: SUPERSEDED_ERROR_CODE,
      status: "failed"
    },
    where: { id: generationId, status: "building" }
  });
  return failed.count === 1;
}

async function activateGeneration(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    base: BaseCandidate;
    generationId: string;
    now: Date;
  }>
): Promise<void> {
  const generation = await tx.knowledgeIndexGeneration.updateMany({
    data: {
      activatedAt: input.now,
      indexedContentRevision: input.base.contentRevision,
      readyAt: input.now,
      status: "active"
    },
    where: {
      id: input.generationId,
      knowledgeBaseId: input.base.knowledgeBaseId,
      sourceBaseVersion: input.base.version,
      sourceIndexGenerationId: input.base.activeGenerationId,
      status: "building",
      targetContentRevision: input.base.contentRevision,
      targetSourceRevision: input.base.sourceRevision
    }
  });
  if (generation.count !== 1) throw new Error("knowledge_profile_shadow_stale");
  const base = await tx.knowledgeBase.updateMany({
    data: {
      activeIndexGenerationId: input.generationId,
      version: { increment: 1 }
    },
    where: {
      activeIndexGenerationId: input.base.activeGenerationId,
      contentRevision: input.base.contentRevision,
      id: input.base.knowledgeBaseId,
      sourceRevision: input.base.sourceRevision,
      version: input.base.version
    }
  });
  if (base.count !== 1) throw new Error("knowledge_profile_shadow_stale");
  const retired = await tx.knowledgeIndexGeneration.updateMany({
    data: { retiredAt: input.now, status: "retired" },
    where: {
      id: input.base.activeGenerationId,
      knowledgeBaseId: input.base.knowledgeBaseId,
      status: "active"
    }
  });
  if (retired.count !== 1) throw new Error("knowledge_profile_shadow_stale");
  await materializeKnowledgeBaseSnapshot(tx, {
    indexGenerationId: input.generationId,
    knowledgeBaseId: input.base.knowledgeBaseId
  });
}

async function migrateBase(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    base: BaseCandidate;
    now: Date;
    profileRevision: Readonly<{
      chunkingProfileVersion: number;
      embeddingConfiguration: Prisma.JsonValue;
      embeddingProviderModelId: string;
      id: string;
      targetDimension: number;
      vectorSpaceFingerprint: string;
    }>;
  }>
): Promise<KnowledgeProfileMigrationResult> {
  const result = emptyResult();
  const building = await tx.knowledgeIndexGeneration.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      profileRevisionId: true,
      sourceBaseVersion: true,
      sourceIndexGenerationId: true,
      targetContentRevision: true,
      targetSourceRevision: true
    },
    where: {
      knowledgeBaseId: input.base.knowledgeBaseId,
      sourceIndexGenerationId: { not: null },
      status: "building"
    }
  });

  if (input.base.activeProfileRevisionId === input.profileRevision.id) {
    const superseded = building
      ? Number(await failBuildingGeneration(tx, building.id, input.now))
      : 0;
    return { ...result, alreadyActiveBases: 1, supersededGenerations: superseded };
  }

  const currentBuilding = building &&
    building.profileRevisionId === input.profileRevision.id &&
    building.sourceIndexGenerationId === input.base.activeGenerationId &&
    building.sourceBaseVersion === input.base.version &&
    building.targetContentRevision === input.base.contentRevision &&
    building.targetSourceRevision === input.base.sourceRevision
    ? building
    : null;
  let supersededGenerations = 0;
  if (building && !currentBuilding) {
    supersededGenerations = Number(await failBuildingGeneration(tx, building.id, input.now));
  }
  const generation = currentBuilding ?? await tx.knowledgeIndexGeneration.create({
    data: {
      chunkingProfileVersion: input.profileRevision.chunkingProfileVersion,
      embeddingConfiguration: input.profileRevision.embeddingConfiguration as Prisma.InputJsonValue,
      embeddingProviderModelId: input.profileRevision.embeddingProviderModelId,
      indexedContentRevision: 0,
      knowledgeBaseId: input.base.knowledgeBaseId,
      profileRevisionId: input.profileRevision.id,
      sourceBaseVersion: input.base.version,
      sourceIndexGenerationId: input.base.activeGenerationId,
      status: "building",
      targetContentRevision: input.base.contentRevision,
      targetDimension: input.profileRevision.targetDimension,
      targetSourceRevision: input.base.sourceRevision,
      vectorSpaceFingerprint: input.profileRevision.vectorSpaceFingerprint.trim()
    },
    select: { id: true }
  });
  const queuedArtifacts = await queueArtifacts(tx, {
    knowledgeBaseId: input.base.knowledgeBaseId,
    now: input.now,
    profileRevisionId: input.profileRevision.id
  });
  const counts = await readiness(tx, {
    knowledgeBaseId: input.base.knowledgeBaseId,
    profileRevisionId: input.profileRevision.id
  });
  if (counts.readySourceCount === counts.requiredSourceCount) {
    await activateGeneration(tx, {
      base: input.base,
      generationId: generation.id,
      now: input.now
    });
    return {
      ...result,
      activatedBases: 1,
      createdGenerations: currentBuilding ? 0 : 1,
      queuedArtifacts,
      supersededGenerations
    };
  }
  return {
    ...result,
    buildingBases: 1,
    createdGenerations: currentBuilding ? 0 : 1,
    queuedArtifacts,
    supersededGenerations
  };
}

export async function scheduleKnowledgeProfileMigration(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    knowledgeBaseIds?: readonly string[];
    limit?: number;
    now: Date;
    profileRevisionId: string;
  }>
): Promise<KnowledgeProfileMigrationResult> {
  const limit = input.limit ?? MIGRATION_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MIGRATION_BATCH_SIZE) {
    throw new Error("knowledge_profile_migration_limit_invalid");
  }
  const profileRevision = await tx.knowledgeIndexProfileRevision.findUnique({
    select: {
      chunkingProfileVersion: true,
      embeddingConfiguration: true,
      embeddingProviderModelId: true,
      id: true,
      targetDimension: true,
      vectorSpaceFingerprint: true
    },
    where: { id: input.profileRevisionId }
  });
  if (!profileRevision) throw new Error("knowledge_profile_revision_missing");
  const bases = await liveBaseCandidates(tx, {
    knowledgeBaseIds: input.knowledgeBaseIds,
    limit,
    profileRevisionId: input.profileRevisionId
  });
  let result = emptyResult();
  for (const base of bases) {
    result = addResult(result, await migrateBase(tx, {
      base,
      now: input.now,
      profileRevision
    }));
  }
  return result;
}

export async function settleKnowledgeProfileMigrationsForSource(
  tx: Prisma.TransactionClient,
  input: Readonly<{ now: Date; sourceId: string }>
): Promise<KnowledgeProfileMigrationResult> {
  const profile = await tx.knowledgeIndexProfile.findUnique({
    select: { activeRevisionId: true },
    where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
  });
  if (!profile?.activeRevisionId) return emptyResult();
  const memberships = await tx.knowledgeBaseSource.findMany({
    distinct: ["knowledgeBaseId"],
    select: { knowledgeBaseId: true },
    where: { removedAt: null, sourceId: input.sourceId }
  });
  return scheduleKnowledgeProfileMigration(tx, {
    knowledgeBaseIds: memberships.map(({ knowledgeBaseId }) => knowledgeBaseId),
    now: input.now,
    profileRevisionId: profile.activeRevisionId
  });
}

export async function reconcileActiveKnowledgeProfileMigrations(
  client: PrismaClient,
  now: Date
): Promise<KnowledgeProfileMigrationResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        const profile = await tx.knowledgeIndexProfile.findUnique({
          select: { activeRevisionId: true },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
        });
        return profile?.activeRevisionId
          ? scheduleKnowledgeProfileMigration(tx, {
              now,
              profileRevisionId: profile.activeRevisionId
            })
          : emptyResult();
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (attempt < 2 && serializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_profile_migration_retry_exhausted");
}

export function knowledgeProfileMigrationChanged(
  result: KnowledgeProfileMigrationResult
): boolean {
  return result.activatedBases > 0 || result.createdGenerations > 0 ||
    result.queuedArtifacts > 0 || result.supersededGenerations > 0;
}
