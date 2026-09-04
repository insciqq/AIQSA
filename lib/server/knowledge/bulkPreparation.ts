import { Prisma, type PrismaClient } from "@prisma/client";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import {
  buildAndPersistKnowledgeHierarchicalIndexBatch,
  KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
  KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS
} from "./hierarchicalIndexRepository";
import type { StoredKnowledgeNormalizedDocument } from "./normalizedDocument";
import { knowledgeSourceNormalizedTextStorageKey } from "./sourceArtifactKeys";

export const KNOWLEDGE_BULK_PREPARATION_MAX_SOURCES = 500;

export type KnowledgeBulkPreparedSource = Readonly<{
  artifactId: string;
  byteSize: number;
  checksum: string;
  fileName: string;
  mimeType: string;
  normalizedTextByteSize: number;
  normalizedTextChecksum: string;
  normalizedTextStorageKey: string;
  sourceId: string;
  sourceName: string;
  sourceVersionId: string;
}>;

export type KnowledgeBulkPreparationResult = Readonly<{
  createdArtifacts: number;
  createdMemberships: number;
  createdSources: number;
  createdVersions: number;
  verifiedSources: number;
}>;

export type KnowledgeBulkHierarchicalSource = Readonly<{
  chunks: readonly KnowledgeChunkPlanEntry[];
  document: StoredKnowledgeNormalizedDocument;
  prepared: KnowledgeBulkPreparedSource;
}>;

export type KnowledgeBulkHierarchicalResult = Readonly<{
  createdHierarchies: number;
  reusedHierarchies: number;
  stagedArtifacts: number;
  truncatedHierarchies: number;
}>;

export class KnowledgeBulkPreparationError extends Error {
  constructor(readonly code:
    | "knowledge_bulk_preparation_conflict"
    | "knowledge_bulk_preparation_input_invalid"
    | "knowledge_bulk_preparation_target_invalid") {
    super(code);
    this.name = "KnowledgeBulkPreparationError";
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactString(value: string, maximum: number): boolean {
  return Boolean(value) && value === value.trim() && value.length <= maximum &&
    !/[\u0000\r\n]/u.test(value);
}

export function assertKnowledgeBulkPreparedSources(
  ownerUserId: string,
  sources: readonly KnowledgeBulkPreparedSource[]
): void {
  if (!exactString(ownerUserId, 128) || sources.length < 1 ||
    sources.length > KNOWLEDGE_BULK_PREPARATION_MAX_SOURCES) {
    throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_input_invalid");
  }
  const sourceIds = new Set<string>();
  const sourceVersionIds = new Set<string>();
  const artifactIds = new Set<string>();
  for (const source of sources) {
    if (!identifierPattern.test(source.sourceId) ||
      !identifierPattern.test(source.sourceVersionId) ||
      !identifierPattern.test(source.artifactId) ||
      sourceIds.has(source.sourceId) || sourceVersionIds.has(source.sourceVersionId) ||
      artifactIds.has(source.artifactId) || !exactString(source.sourceName, 255) ||
      !exactString(source.fileName, 255) || !exactString(source.mimeType, 255) ||
      !Number.isSafeInteger(source.byteSize) || source.byteSize < 1 ||
      !Number.isSafeInteger(source.normalizedTextByteSize) ||
      source.normalizedTextByteSize < 1 || !sha256Pattern.test(source.checksum) ||
      !sha256Pattern.test(source.normalizedTextChecksum) ||
      source.normalizedTextStorageKey !== knowledgeSourceNormalizedTextStorageKey({
        artifactId: source.artifactId,
        ownerUserId,
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId
      })) {
      throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_input_invalid");
    }
    sourceIds.add(source.sourceId);
    sourceVersionIds.add(source.sourceVersionId);
    artifactIds.add(source.artifactId);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedSourcePointer(
  currentVersionId: string | null,
  pendingVersionId: string | null,
  sourceVersionId: string
): boolean {
  return (currentVersionId === null && pendingVersionId === sourceVersionId) ||
    (currentVersionId === sourceVersionId && pendingVersionId === null);
}

async function assertKnowledgeBulkTarget(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    knowledgeBaseId: string;
    ownerUserId: string;
    profileRevisionId: string;
  }>,
  lockTarget: "share" | "update" = "update"
): Promise<void> {
  const lockClause = lockTarget === "update"
    ? Prisma.sql`FOR UPDATE OF base`
    : Prisma.sql`FOR SHARE OF base`;
  const targets = await tx.$queryRaw<Array<{
    activeProfileRevisionId: string | null;
    ownerUserId: string;
  }>>(Prisma.sql`
    SELECT
      base."ownerUserId",
      generation."profileRevisionId" AS "activeProfileRevisionId"
    FROM "KnowledgeBase" AS base
    LEFT JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND generation."id" = base."activeIndexGenerationId"
     AND generation."status" = 'active'::"KnowledgeIndexGenerationStatus"
    WHERE base."id" = ${input.knowledgeBaseId}
      AND base."trashedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
    ${lockClause}
  `);
  const target = targets[0];
  if (target?.ownerUserId !== input.ownerUserId ||
    target.activeProfileRevisionId !== input.profileRevisionId) {
    throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_target_invalid");
  }
}

/**
 * Stages validated normalized-text Sources without marking any artifact ready.
 * `heldUntil` is an explicit scheduling fence: a separate, acknowledged
 * execution step must move selected artifacts into runnable time. Existing
 * rows are treated as durable checkpoints and must match exactly.
 */
export function createPrismaKnowledgeBulkPreparationRepository(
  client: PrismaClient
) {
  return Object.freeze({
    async stageSources(input: Readonly<{
      heldUntil: Date;
      knowledgeBaseId: string;
      now: Date;
      ownerUserId: string;
      profileRevisionId: string;
      sources: readonly KnowledgeBulkPreparedSource[];
    }>): Promise<KnowledgeBulkPreparationResult> {
      assertKnowledgeBulkPreparedSources(input.ownerUserId, input.sources);
      if (!identifierPattern.test(input.knowledgeBaseId) ||
        !identifierPattern.test(input.profileRevisionId) ||
        !Number.isFinite(input.now.getTime()) || !Number.isFinite(input.heldUntil.getTime()) ||
        input.heldUntil <= input.now) {
        throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_input_invalid");
      }

      return client.$transaction(async (tx) => {
        await assertKnowledgeBulkTarget(tx, input);

        const sourceIds = input.sources.map(({ sourceId }) => sourceId);
        const sourceVersionIds = input.sources.map(({ sourceVersionId }) => sourceVersionId);
        const artifactIds = input.sources.map(({ artifactId }) => artifactId);
        const [existingSources, existingVersions, existingArtifacts, existingMemberships] =
          await Promise.all([
            tx.knowledgeSource.findMany({
              select: {
                currentVersionId: true,
                deletionRequestedAt: true,
                description: true,
                id: true,
                name: true,
                ownerUserId: true,
                pendingVersionId: true,
                tags: true,
                trashedAt: true
              },
              where: { id: { in: sourceIds } }
            }),
            tx.knowledgeSourceVersion.findMany({
              select: {
                byteSize: true,
                checksum: true,
                fileName: true,
                id: true,
                mimeType: true,
                originalStorageKey: true,
                ownerUserId: true,
                sourceId: true,
                versionNumber: true
              },
              where: { id: { in: sourceVersionIds } }
            }),
            tx.knowledgeSourceIndexArtifact.findMany({
              select: {
                errorCode: true,
                id: true,
                normalizedTextByteSize: true,
                normalizedTextChecksum: true,
                normalizedTextStorageKey: true,
                profileRevisionId: true,
                sourceVersionId: true,
                state: true
              },
              where: { id: { in: artifactIds } }
            }),
            tx.knowledgeBaseSource.findMany({
              select: {
                knowledgeBaseId: true,
                ownerUserId: true,
                removedAt: true,
                sourceId: true
              },
              where: {
                knowledgeBaseId: input.knowledgeBaseId,
                sourceId: { in: sourceIds }
              }
            })
          ]);
        const bySource = new Map(existingSources.map((row) => [row.id, row]));
        const byVersion = new Map(existingVersions.map((row) => [row.id, row]));
        const byArtifact = new Map(existingArtifacts.map((row) => [row.id, row]));
        const byMembership = new Map(existingMemberships.map((row) => [row.sourceId, row]));

        for (const source of input.sources) {
          const sourceRow = bySource.get(source.sourceId);
          if (sourceRow && (
            sourceRow.ownerUserId !== input.ownerUserId ||
            sourceRow.name !== source.sourceName || sourceRow.description !== "" ||
            !sameStrings(sourceRow.tags, []) || sourceRow.trashedAt !== null ||
            sourceRow.deletionRequestedAt !== null ||
            !expectedSourcePointer(
              sourceRow.currentVersionId,
              sourceRow.pendingVersionId,
              source.sourceVersionId
            )
          )) throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");

          const version = byVersion.get(source.sourceVersionId);
          if (version && (
            version.sourceId !== source.sourceId ||
            version.ownerUserId !== input.ownerUserId || version.versionNumber !== 1 ||
            version.fileName !== source.fileName || version.mimeType !== source.mimeType ||
            version.byteSize !== source.byteSize || version.checksum.trim() !== source.checksum ||
            version.originalStorageKey !== null
          )) throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");

          const artifact = byArtifact.get(source.artifactId);
          if (artifact && (
            artifact.sourceVersionId !== source.sourceVersionId ||
            artifact.profileRevisionId !== input.profileRevisionId ||
            artifact.normalizedTextStorageKey !== source.normalizedTextStorageKey ||
            artifact.normalizedTextByteSize !== source.normalizedTextByteSize ||
            artifact.normalizedTextChecksum?.trim() !== source.normalizedTextChecksum ||
            artifact.state === "failed" || artifact.errorCode !== null
          )) throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");

          const membership = byMembership.get(source.sourceId);
          if (membership && (membership.ownerUserId !== input.ownerUserId ||
            membership.knowledgeBaseId !== input.knowledgeBaseId ||
            membership.removedAt !== null)) {
            throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");
          }
        }

        const missingSources = input.sources.filter(({ sourceId }) => !bySource.has(sourceId));
        const missingVersions = input.sources.filter(
          ({ sourceVersionId }) => !byVersion.has(sourceVersionId)
        );
        const missingArtifacts = input.sources.filter(({ artifactId }) =>
          !byArtifact.has(artifactId));
        const missingMemberships = input.sources.filter(({ sourceId }) =>
          !byMembership.has(sourceId));

        const createdSources = await tx.knowledgeSource.createMany({
          data: missingSources.map((source) => ({
            description: "",
            id: source.sourceId,
            name: source.sourceName,
            ownerUserId: input.ownerUserId,
            tags: []
          }))
        });
        const createdVersions = await tx.knowledgeSourceVersion.createMany({
          data: missingVersions.map((source) => ({
            byteSize: source.byteSize,
            checksum: source.checksum,
            fileName: source.fileName,
            id: source.sourceVersionId,
            mimeType: source.mimeType,
            originalStorageKey: null,
            ownerUserId: input.ownerUserId,
            sourceId: source.sourceId,
            versionNumber: 1
          }))
        });

        const pointerRows = input.sources.map((source) => Prisma.sql`
          (${source.sourceId}, ${source.sourceVersionId})
        `);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "KnowledgeSource" AS source
          SET "pendingVersionId" = expected."sourceVersionId",
              "updatedAt" = ${input.now}
          FROM (VALUES ${Prisma.join(pointerRows)})
            AS expected("sourceId", "sourceVersionId")
          WHERE source."id" = expected."sourceId"
            AND source."currentVersionId" IS NULL
            AND source."pendingVersionId" IS NULL
        `);

        const createdArtifacts = await tx.knowledgeSourceIndexArtifact.createMany({
          data: missingArtifacts.map((source) => ({
            id: source.artifactId,
            nextAttemptAt: input.heldUntil,
            normalizedTextByteSize: source.normalizedTextByteSize,
            normalizedTextChecksum: source.normalizedTextChecksum,
            normalizedTextStorageKey: source.normalizedTextStorageKey,
            pageCount: 1,
            processingStage: "chunking" as const,
            profileRevisionId: input.profileRevisionId,
            sourceVersionId: source.sourceVersionId,
            state: "pending" as const
          }))
        });
        const createdMemberships = await tx.knowledgeBaseSource.createMany({
          data: missingMemberships.map((source) => ({
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.ownerUserId,
            sourceId: source.sourceId
          }))
        });
        if (createdMemberships.count > 0) {
          await tx.knowledgeBase.update({
            data: { version: { increment: 1 } },
            where: { id: input.knowledgeBaseId }
          });
        }

        const verified = await tx.knowledgeSourceIndexArtifact.count({
          where: {
            id: { in: artifactIds },
            normalizedTextByteSize: { not: null },
            normalizedTextChecksum: { not: null },
            normalizedTextStorageKey: { not: null },
            profileRevisionId: input.profileRevisionId,
            sourceVersionId: { in: sourceVersionIds },
            state: { in: ["pending", "processing", "ready"] }
          }
        });
        if (verified !== input.sources.length) {
          throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");
        }
        return Object.freeze({
          createdArtifacts: createdArtifacts.count,
          createdMemberships: createdMemberships.count,
          createdSources: createdSources.count,
          createdVersions: createdVersions.count,
          verifiedSources: verified
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async stageHierarchicalIndexes(input: Readonly<{
      heldUntil: Date;
      knowledgeBaseId: string;
      now: Date;
      ownerUserId: string;
      profileRevisionId: string;
      sources: readonly KnowledgeBulkHierarchicalSource[];
    }>): Promise<KnowledgeBulkHierarchicalResult> {
      if (!identifierPattern.test(input.knowledgeBaseId) ||
        !identifierPattern.test(input.profileRevisionId) ||
        !Number.isFinite(input.now.getTime()) || !Number.isFinite(input.heldUntil.getTime()) ||
        input.heldUntil <= input.now || input.sources.length < 1 ||
        input.sources.length > KNOWLEDGE_HIERARCHICAL_INDEX_SOURCE_BATCH_SIZE) {
        throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_input_invalid");
      }
      assertKnowledgeBulkPreparedSources(
        input.ownerUserId,
        input.sources.map(({ prepared }) => prepared)
      );
      if (input.sources.some(({ chunks, document }) =>
        chunks.length < 1 || !document.blocks.length)) {
        throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_input_invalid");
      }

      return client.$transaction(async (tx) => {
        await assertKnowledgeBulkTarget(tx, input, "share");
        const artifactIds = input.sources.map(({ prepared }) => prepared.artifactId);
        const rows = await tx.$queryRaw<Array<{
          artifactId: string;
          chunkCount: number | null;
          claimToken: string | null;
          currentVersionId: string | null;
          embeddedPassageCount: number;
          errorCode: string | null;
          nextAttemptAt: Date;
          normalizedTextByteSize: number | null;
          normalizedTextChecksum: string | null;
          normalizedTextStorageKey: string | null;
          ownerUserId: string;
          pendingVersionId: string | null;
          processingStage: "chunking" | "embedding" | null;
          profileRevisionId: string;
          sourceId: string;
          sourceVersionId: string;
          state: "failed" | "pending" | "processing" | "ready";
        }>>(Prisma.sql`
          SELECT
            artifact."id" AS "artifactId",
            artifact."sourceVersionId",
            artifact."profileRevisionId",
            artifact."state"::text AS "state",
            artifact."processingStage"::text AS "processingStage",
            artifact."chunkCount",
            artifact."embeddedPassageCount",
            artifact."normalizedTextStorageKey",
            artifact."normalizedTextByteSize",
            artifact."normalizedTextChecksum",
            artifact."claimToken",
            artifact."nextAttemptAt",
            artifact."errorCode",
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
          WHERE artifact."id" IN (${Prisma.join(artifactIds)})
          FOR UPDATE OF artifact, source
        `);
        const byArtifact = new Map(rows.map((row) => [row.artifactId, row]));
        for (const source of input.sources) {
          const prepared = source.prepared;
          const row = byArtifact.get(prepared.artifactId);
          if (!row || row.sourceId !== prepared.sourceId ||
            row.sourceVersionId !== prepared.sourceVersionId ||
            row.ownerUserId !== input.ownerUserId ||
            row.profileRevisionId !== input.profileRevisionId ||
            row.normalizedTextStorageKey !== prepared.normalizedTextStorageKey ||
            row.normalizedTextByteSize !== prepared.normalizedTextByteSize ||
            row.normalizedTextChecksum?.trim() !== prepared.normalizedTextChecksum ||
            !expectedSourcePointer(
              row.currentVersionId,
              row.pendingVersionId,
              prepared.sourceVersionId
            ) || row.state !== "pending" || row.claimToken !== null ||
            row.errorCode !== null || row.embeddedPassageCount !== 0 ||
            row.nextAttemptAt <= input.now || !(
              (row.processingStage === "chunking" && row.chunkCount === null) ||
              (row.processingStage === "embedding" &&
                row.chunkCount === source.chunks.length)
            )) {
            throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");
          }
        }
        const membershipCount = await tx.knowledgeBaseSource.count({
          where: {
            knowledgeBaseId: input.knowledgeBaseId,
            ownerUserId: input.ownerUserId,
            removedAt: null,
            sourceId: { in: input.sources.map(({ prepared }) => prepared.sourceId) }
          }
        });
        if (membershipCount !== input.sources.length) {
          throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_target_invalid");
        }

        let truncatedHierarchies = 0;
        const persisted = await buildAndPersistKnowledgeHierarchicalIndexBatch(
          tx,
          input.sources.map((source) => ({
            chunks: source.chunks,
            document: source.document,
            now: input.now,
            onExactIndexTruncated: () => {
              truncatedHierarchies += 1;
            },
            sourceArtifactId: source.prepared.artifactId,
            sourceVersionId: source.prepared.sourceVersionId
          }))
        );
        const stageRows = input.sources.map((source) => Prisma.sql`
          (${source.prepared.artifactId}, ${source.prepared.sourceVersionId},
            ${source.chunks.length})
        `);
        const stagedArtifacts = await tx.$executeRaw(Prisma.sql`
          UPDATE "KnowledgeSourceIndexArtifact" AS artifact
          SET "chunkCount" = expected."chunkCount",
              "embeddedPassageCount" = 0,
              "processingStage" = 'embedding'::"KnowledgeSourceArtifactProcessingStage",
              "nextAttemptAt" = ${input.heldUntil},
              "updatedAt" = ${input.now}
          FROM (VALUES ${Prisma.join(stageRows)})
            AS expected("artifactId", "sourceVersionId", "chunkCount")
          WHERE artifact."id" = expected."artifactId"
            AND artifact."sourceVersionId" = expected."sourceVersionId"
            AND artifact."profileRevisionId" = ${input.profileRevisionId}
            AND artifact."state" = 'pending'::"KnowledgeSourceArtifactState"
            AND artifact."claimToken" IS NULL
            AND artifact."processingStage" IN (
              'chunking'::"KnowledgeSourceArtifactProcessingStage",
              'embedding'::"KnowledgeSourceArtifactProcessingStage"
            )
        `);
        if (stagedArtifacts !== input.sources.length) {
          throw new KnowledgeBulkPreparationError("knowledge_bulk_preparation_conflict");
        }
        return Object.freeze({
          createdHierarchies: persisted.created,
          reusedHierarchies: persisted.reused,
          stagedArtifacts,
          truncatedHierarchies
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_MAX_WAIT_MS,
        timeout: KNOWLEDGE_HIERARCHICAL_INDEX_TRANSACTION_TIMEOUT_MS
      });
    }
  });
}

export type PrismaKnowledgeBulkPreparationRepository = ReturnType<
  typeof createPrismaKnowledgeBulkPreparationRepository
>;
