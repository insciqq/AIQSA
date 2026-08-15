import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  KNOWLEDGE_DOCUMENT_PAGE_SIZE,
  KNOWLEDGE_DOCUMENT_PAGE_SIZE_MAX,
  type KnowledgeDocumentStatus,
  type KnowledgeDocumentVersionStatus,
  type KnowledgeIngestionStatusResponse,
  type KnowledgeReindexProgress
} from "../../contracts/knowledge";
import { prisma } from "../prisma";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import type { KnowledgeChunkPlanEntry } from "./chunking";
import {
  resolveKnowledgeEmbeddingDeployments,
  type KnowledgeEmbeddingDeploymentResolution
} from "./prismaRepository";
import type {
  KnowledgeDocumentWorkClaim,
  KnowledgeEmbeddingBatchWrite,
  KnowledgeGenerationPinRecord,
  KnowledgeIngestionFailureCode,
  KnowledgeReindexWorkClaim,
  KnowledgeWorkClaim,
  KnowledgeWorkIdentity
} from "./ingestionTypes";

type DocumentClaimRow = Readonly<{
  attemptCount: number;
  byteSize: number;
  checksum: string;
  chunkingProfileVersion: number;
  documentId: string;
  documentVersionId: string;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  fileName: string;
  generationId: string;
  ingestChunkCount: number | null;
  knowledgeBaseId: string;
  mimeType: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  originalStorageKey: string | null;
  ownerUserId: string;
  state: "chunking" | "embedding" | "parsing" | "queued";
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type ReindexClaimRow = Readonly<{
  attemptCount: number;
  chunkCount: number | null;
  chunkingProfileVersion: number;
  documentId: string;
  documentVersionId: string;
  embeddingConfiguration: Prisma.JsonValue;
  embeddingProviderModelId: string;
  generationId: string;
  knowledgeBaseId: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  ownerUserId: string;
  state: "embedding" | "queued";
  targetDimension: number;
  vectorSpaceFingerprint: string;
}>;

type FairnessCursorRow = Readonly<{
  lastGrantedOwnerUserId: string | null;
}>;

type EligibleKnowledgeOwnerRow = Readonly<{
  ownerUserId: string;
}>;

type LockedBase = Readonly<{
  activeIndexGenerationId: string | null;
  archivedAt: Date | null;
  contentRevision: number;
  ownerUserId: string;
  version: number;
}>;

export type KnowledgeVersionCreateInput = Readonly<{
  byteSize: number;
  checksum: string;
  documentId: string;
  documentVersionId: string;
  fileName: string;
  knowledgeBaseId: string;
  mimeType: string;
  normalizedTextStorageKey: string;
  originalStorageKey: string;
  replaceDocumentId: string | null;
  userId: string;
}>;

export type KnowledgeVersionCreateResult =
  | Readonly<{ documentId: string; kind: "ok"; versionId: string }>
  | Readonly<{ kind: "active_ingest" }>
  | Readonly<{ kind: "not_found" }>;

export type KnowledgeDocumentMutationResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_retryable" }>
  | Readonly<{ kind: "ok" }>;

export type KnowledgeReindexStartResult =
  | Readonly<{ generationId: string; kind: "ok" }>
  | Readonly<{ kind: "embedding_dimension_not_supported" }>
  | Readonly<{ kind: "embedding_not_available" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "normalized_text_unavailable" }>
  | Readonly<{ kind: "reindex_in_progress" }>;

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function uniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function serializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && serializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_serializable_retry_exhausted");
}

function generationPin(row: DocumentClaimRow | ReindexClaimRow): KnowledgeGenerationPinRecord {
  return {
    chunkingProfileVersion: row.chunkingProfileVersion,
    embeddingConfiguration: row.embeddingConfiguration as unknown as KnowledgeGenerationPinRecord["embeddingConfiguration"],
    embeddingProviderModelId: row.embeddingProviderModelId,
    id: row.generationId,
    targetDimension: row.targetDimension,
    vectorSpaceFingerprint: row.vectorSpaceFingerprint.trim()
  };
}

function documentClaim(row: DocumentClaimRow, claimToken: string): KnowledgeDocumentWorkClaim {
  return {
    attemptCount: row.attemptCount,
    byteSize: row.byteSize,
    checksum: row.checksum.trim(),
    claimToken,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    fileName: row.fileName,
    generation: generationPin(row),
    ingestChunkCount: row.ingestChunkCount,
    kind: "document",
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

function reindexClaim(row: ReindexClaimRow, claimToken: string): KnowledgeReindexWorkClaim {
  return {
    attemptCount: row.attemptCount,
    chunkCount: row.chunkCount,
    claimToken,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    generation: generationPin(row),
    kind: "reindex",
    knowledgeBaseId: row.knowledgeBaseId,
    normalizedTextByteSize: row.normalizedTextByteSize,
    normalizedTextChecksum: row.normalizedTextChecksum?.trim() ?? null,
    normalizedTextStorageKey: row.normalizedTextStorageKey,
    ownerUserId: row.ownerUserId,
    state: row.state
  };
}

async function claimDocument(
  client: Prisma.TransactionClient,
  input: { claimToken: string; now: Date; staleBefore: Date },
  ownerUserId: string
): Promise<KnowledgeDocumentWorkClaim | null> {
  const rows = await client.$queryRaw<DocumentClaimRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT version."id"
      FROM "KnowledgeDocumentVersion" AS version
      INNER JOIN "KnowledgeDocument" AS document
        ON document."id" = version."documentId"
        AND document."knowledgeBaseId" = version."knowledgeBaseId"
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = version."knowledgeBaseId"
        AND base."ownerUserId" = version."ownerUserId"
      INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
      WHERE version."ingestState" IN (
          'queued'::"KnowledgeDocumentIngestState",
          'parsing'::"KnowledgeDocumentIngestState",
          'chunking'::"KnowledgeDocumentIngestState",
          'embedding'::"KnowledgeDocumentIngestState"
        )
        AND version."ingestGenerationId" IS NOT NULL
        AND version."ingestNextAttemptAt" <= ${input.now}
        AND (version."ingestClaimedAt" IS NULL OR version."ingestClaimedAt" < ${input.staleBefore})
        AND document."archivedAt" IS NULL
        AND base."archivedAt" IS NULL
        AND version."ownerUserId" = ${ownerUserId}
        AND owner_user."status" = 'active'::"UserStatus"
      ORDER BY version."ingestNextAttemptAt", version."createdAt", version."id"
      LIMIT 1
      FOR UPDATE OF version SKIP LOCKED
    ), claimed AS (
      UPDATE "KnowledgeDocumentVersion" AS version
      SET "ingestClaimToken" = ${input.claimToken},
          "ingestClaimedAt" = ${input.now},
          "ingestAttemptCount" = version."ingestAttemptCount" + 1,
          "updatedAt" = ${input.now}
      FROM candidate
      WHERE version."id" = candidate."id"
      RETURNING version.*
    )
    SELECT
      claimed."id" AS "documentVersionId",
      claimed."documentId",
      claimed."knowledgeBaseId",
      claimed."ingestState"::text AS "state",
      claimed."ingestAttemptCount" AS "attemptCount",
      claimed."byteSize",
      claimed."checksum",
      claimed."fileName",
      claimed."mimeType",
      claimed."originalStorageKey",
      claimed."normalizedTextStorageKey",
      claimed."normalizedTextByteSize",
      claimed."normalizedTextChecksum",
      claimed."ingestChunkCount",
      claimed."ownerUserId",
      generation."id" AS "generationId",
      generation."embeddingProviderModelId",
      generation."embeddingConfiguration",
      generation."vectorSpaceFingerprint",
      generation."targetDimension",
      generation."chunkingProfileVersion"
    FROM claimed
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = claimed."knowledgeBaseId"
      AND generation."id" = claimed."ingestGenerationId"
  `);
  return rows[0] ? documentClaim(rows[0], input.claimToken) : null;
}

async function claimReindex(
  client: Prisma.TransactionClient,
  input: { claimToken: string; now: Date; staleBefore: Date },
  ownerUserId: string
): Promise<KnowledgeReindexWorkClaim | null> {
  const rows = await client.$queryRaw<ReindexClaimRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT work."indexGenerationId", work."documentVersionId"
      FROM "KnowledgeGenerationDocument" AS work
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."id" = work."indexGenerationId"
        AND generation."knowledgeBaseId" = work."knowledgeBaseId"
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = work."knowledgeBaseId"
        AND base."ownerUserId" = work."ownerUserId"
      INNER JOIN "KnowledgeDocumentVersion" AS version
        ON version."id" = work."documentVersionId"
        AND version."knowledgeBaseId" = work."knowledgeBaseId"
      INNER JOIN "KnowledgeDocument" AS document
        ON document."id" = version."documentId"
        AND document."knowledgeBaseId" = version."knowledgeBaseId"
      INNER JOIN "User" AS owner_user ON owner_user."id" = work."ownerUserId"
      WHERE generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
        AND work."state" IN ('queued'::"KnowledgeDocumentIngestState", 'embedding'::"KnowledgeDocumentIngestState")
        AND work."nextAttemptAt" <= ${input.now}
        AND (work."claimedAt" IS NULL OR work."claimedAt" < ${input.staleBefore})
        AND document."archivedAt" IS NULL
        AND base."archivedAt" IS NULL
        AND work."ownerUserId" = ${ownerUserId}
        AND owner_user."status" = 'active'::"UserStatus"
      ORDER BY work."nextAttemptAt", work."createdAt", work."indexGenerationId", work."documentVersionId"
      LIMIT 1
      FOR UPDATE OF work SKIP LOCKED
    ), claimed AS (
      UPDATE "KnowledgeGenerationDocument" AS work
      SET "claimToken" = ${input.claimToken},
          "claimedAt" = ${input.now},
          "lastAttemptAt" = ${input.now},
          "attemptCount" = work."attemptCount" + 1,
          "updatedAt" = ${input.now}
      FROM candidate
      WHERE work."indexGenerationId" = candidate."indexGenerationId"
        AND work."documentVersionId" = candidate."documentVersionId"
      RETURNING work.*
    )
    SELECT
      claimed."documentVersionId",
      claimed."knowledgeBaseId",
      claimed."state"::text AS "state",
      claimed."attemptCount",
      claimed."chunkCount",
      version."documentId",
      version."normalizedTextStorageKey",
      version."normalizedTextByteSize",
      version."normalizedTextChecksum",
      claimed."ownerUserId",
      generation."id" AS "generationId",
      generation."embeddingProviderModelId",
      generation."embeddingConfiguration",
      generation."vectorSpaceFingerprint",
      generation."targetDimension",
      generation."chunkingProfileVersion"
    FROM claimed
    INNER JOIN "KnowledgeDocumentVersion" AS version
      ON version."knowledgeBaseId" = claimed."knowledgeBaseId"
      AND version."id" = claimed."documentVersionId"
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = claimed."knowledgeBaseId"
      AND generation."id" = claimed."indexGenerationId"
  `);
  return rows[0] ? reindexClaim(rows[0], input.claimToken) : null;
}

async function lockKnowledgeFairnessCursor(
  tx: Prisma.TransactionClient
): Promise<string | null> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES ('knowledge', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT ("pipeline") DO NOTHING
  `);
  const rows = await tx.$queryRaw<FairnessCursorRow[]>(Prisma.sql`
    SELECT "lastGrantedOwnerUserId"
    FROM "DocumentProcessingFairnessCursor"
    WHERE "pipeline" = 'knowledge'
    FOR UPDATE
  `);
  if (!rows[0]) throw new Error("knowledge_fairness_cursor_unavailable");
  return rows[0].lastGrantedOwnerUserId;
}

function documentOwnerHeadSql(
  input: { now: Date; staleBefore: Date },
  guard: Prisma.Sql,
  ownerRange: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    SELECT version."ownerUserId"
    FROM "KnowledgeDocumentVersion" AS version
    INNER JOIN "KnowledgeDocument" AS document
      ON document."id" = version."documentId"
      AND document."knowledgeBaseId" = version."knowledgeBaseId"
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = version."knowledgeBaseId"
      AND base."ownerUserId" = version."ownerUserId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
    WHERE ${guard}
      AND ${ownerRange}
      AND version."ingestState" IN (
        'queued'::"KnowledgeDocumentIngestState",
        'parsing'::"KnowledgeDocumentIngestState",
        'chunking'::"KnowledgeDocumentIngestState",
        'embedding'::"KnowledgeDocumentIngestState"
      )
      AND version."ingestGenerationId" IS NOT NULL
      AND version."ingestNextAttemptAt" <= ${input.now}
      AND (version."ingestClaimedAt" IS NULL OR version."ingestClaimedAt" < ${input.staleBefore})
      AND document."archivedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND owner_user."status" = 'active'::"UserStatus"
    ORDER BY
      version."ownerUserId",
      version."ingestNextAttemptAt",
      version."createdAt",
      version."id"
    LIMIT 1
  `;
}

function reindexOwnerHeadSql(
  input: { now: Date; staleBefore: Date },
  guard: Prisma.Sql,
  ownerRange: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    SELECT work."ownerUserId"
    FROM "KnowledgeGenerationDocument" AS work
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."id" = work."indexGenerationId"
      AND generation."knowledgeBaseId" = work."knowledgeBaseId"
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = work."knowledgeBaseId"
      AND base."ownerUserId" = work."ownerUserId"
    INNER JOIN "KnowledgeDocumentVersion" AS version
      ON version."id" = work."documentVersionId"
      AND version."knowledgeBaseId" = work."knowledgeBaseId"
      AND version."ownerUserId" = work."ownerUserId"
    INNER JOIN "KnowledgeDocument" AS document
      ON document."id" = version."documentId"
      AND document."knowledgeBaseId" = version."knowledgeBaseId"
    INNER JOIN "User" AS owner_user ON owner_user."id" = work."ownerUserId"
    WHERE ${guard}
      AND ${ownerRange}
      AND generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
      AND work."state" IN (
        'queued'::"KnowledgeDocumentIngestState",
        'embedding'::"KnowledgeDocumentIngestState"
      )
      AND work."nextAttemptAt" <= ${input.now}
      AND (work."claimedAt" IS NULL OR work."claimedAt" < ${input.staleBefore})
      AND document."archivedAt" IS NULL
      AND base."archivedAt" IS NULL
      AND owner_user."status" = 'active'::"UserStatus"
    ORDER BY
      work."ownerUserId",
      work."nextAttemptAt",
      work."createdAt",
      work."indexGenerationId",
      work."documentVersionId"
    LIMIT 1
  `;
}

async function selectInitialEligibleKnowledgeOwner(
  tx: Prisma.TransactionClient,
  input: { now: Date; staleBefore: Date }
): Promise<string | null> {
  const rows = await tx.$queryRaw<EligibleKnowledgeOwnerRow[]>(Prisma.sql`
    WITH document_heads AS (
      SELECT DISTINCT ON (version."ownerUserId")
        version."ownerUserId",
        version."ingestNextAttemptAt" AS "nextAttemptAt",
        version."createdAt",
        version."id" AS "workKey",
        0 AS "kindPriority"
      FROM "KnowledgeDocumentVersion" AS version
      INNER JOIN "KnowledgeDocument" AS document
        ON document."id" = version."documentId"
        AND document."knowledgeBaseId" = version."knowledgeBaseId"
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = version."knowledgeBaseId"
        AND base."ownerUserId" = version."ownerUserId"
      INNER JOIN "User" AS owner_user ON owner_user."id" = version."ownerUserId"
      WHERE version."ingestState" IN (
          'queued'::"KnowledgeDocumentIngestState",
          'parsing'::"KnowledgeDocumentIngestState",
          'chunking'::"KnowledgeDocumentIngestState",
          'embedding'::"KnowledgeDocumentIngestState"
        )
        AND version."ingestGenerationId" IS NOT NULL
        AND version."ingestNextAttemptAt" <= ${input.now}
        AND (version."ingestClaimedAt" IS NULL OR version."ingestClaimedAt" < ${input.staleBefore})
        AND document."archivedAt" IS NULL
        AND base."archivedAt" IS NULL
        AND owner_user."status" = 'active'::"UserStatus"
      ORDER BY
        version."ownerUserId",
        version."ingestNextAttemptAt",
        version."createdAt",
        version."id"
    ), reindex_heads AS (
      SELECT DISTINCT ON (work."ownerUserId")
        work."ownerUserId",
        work."nextAttemptAt",
        work."createdAt",
        concat(work."indexGenerationId", ':', work."documentVersionId") AS "workKey",
        1 AS "kindPriority"
      FROM "KnowledgeGenerationDocument" AS work
      INNER JOIN "KnowledgeIndexGeneration" AS generation
        ON generation."id" = work."indexGenerationId"
        AND generation."knowledgeBaseId" = work."knowledgeBaseId"
      INNER JOIN "KnowledgeBase" AS base
        ON base."id" = work."knowledgeBaseId"
        AND base."ownerUserId" = work."ownerUserId"
      INNER JOIN "KnowledgeDocumentVersion" AS version
        ON version."id" = work."documentVersionId"
        AND version."knowledgeBaseId" = work."knowledgeBaseId"
        AND version."ownerUserId" = work."ownerUserId"
      INNER JOIN "KnowledgeDocument" AS document
        ON document."id" = version."documentId"
        AND document."knowledgeBaseId" = version."knowledgeBaseId"
      INNER JOIN "User" AS owner_user ON owner_user."id" = work."ownerUserId"
      WHERE generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
        AND work."state" IN (
          'queued'::"KnowledgeDocumentIngestState",
          'embedding'::"KnowledgeDocumentIngestState"
        )
        AND work."nextAttemptAt" <= ${input.now}
        AND (work."claimedAt" IS NULL OR work."claimedAt" < ${input.staleBefore})
        AND document."archivedAt" IS NULL
        AND base."archivedAt" IS NULL
        AND owner_user."status" = 'active'::"UserStatus"
      ORDER BY
        work."ownerUserId",
        work."nextAttemptAt",
        work."createdAt",
        work."indexGenerationId",
        work."documentVersionId"
    ), owner_heads AS (
      SELECT DISTINCT ON (heads."ownerUserId")
        heads."ownerUserId",
        heads."nextAttemptAt",
        heads."createdAt",
        heads."workKey"
      FROM (
        SELECT * FROM document_heads
        UNION ALL
        SELECT * FROM reindex_heads
      ) AS heads
      ORDER BY
        heads."ownerUserId",
        heads."kindPriority",
        heads."nextAttemptAt",
        heads."createdAt",
        heads."workKey"
    )
    SELECT "ownerUserId"
    FROM owner_heads
    ORDER BY "nextAttemptAt", "createdAt", "ownerUserId", "workKey"
    LIMIT 1
  `);
  return rows[0]?.ownerUserId ?? null;
}

async function selectEligibleKnowledgeOwner(
  tx: Prisma.TransactionClient,
  input: { now: Date; staleBefore: Date },
  lastGrantedOwnerUserId: string | null
): Promise<string | null> {
  if (lastGrantedOwnerUserId === null) {
    return selectInitialEligibleKnowledgeOwner(tx, input);
  }
  const afterGuard = Prisma.sql`TRUE`;
  const wrapGuard = Prisma.sql`NOT EXISTS (SELECT 1 FROM after_owner)`;
  const rows = await tx.$queryRaw<EligibleKnowledgeOwnerRow[]>(Prisma.sql`
    WITH after_document AS MATERIALIZED (
      ${documentOwnerHeadSql(
        input,
        afterGuard,
        Prisma.sql`version."ownerUserId" > ${lastGrantedOwnerUserId}`
      )}
    ), after_reindex AS MATERIALIZED (
      ${reindexOwnerHeadSql(
        input,
        afterGuard,
        Prisma.sql`work."ownerUserId" > ${lastGrantedOwnerUserId}`
      )}
    ), after_owner AS MATERIALIZED (
      SELECT min(candidate."ownerUserId") AS "ownerUserId"
      FROM (
        SELECT "ownerUserId" FROM after_document
        UNION ALL
        SELECT "ownerUserId" FROM after_reindex
      ) AS candidate
      HAVING count(*) > 0
    ), wrapped_document AS MATERIALIZED (
      ${documentOwnerHeadSql(
        input,
        wrapGuard,
        Prisma.sql`version."ownerUserId" <= ${lastGrantedOwnerUserId}`
      )}
    ), wrapped_reindex AS MATERIALIZED (
      ${reindexOwnerHeadSql(
        input,
        wrapGuard,
        Prisma.sql`work."ownerUserId" <= ${lastGrantedOwnerUserId}`
      )}
    ), wrapped_owner AS MATERIALIZED (
      SELECT min(candidate."ownerUserId") AS "ownerUserId"
      FROM (
        SELECT "ownerUserId" FROM wrapped_document
        UNION ALL
        SELECT "ownerUserId" FROM wrapped_reindex
      ) AS candidate
      HAVING count(*) > 0
    )
    SELECT "ownerUserId" FROM after_owner
    UNION ALL
    SELECT "ownerUserId" FROM wrapped_owner
    LIMIT 1
  `);
  return rows[0]?.ownerUserId ?? null;
}

function identityWhere(identity: KnowledgeWorkIdentity) {
  return identity.kind === "document"
    ? {
        document: {
          id: identity.documentVersionId,
          ingestClaimToken: identity.claimToken,
          ingestGenerationId: identity.generationId
        }
      } as const
    : {
        reindex: {
          claimToken: identity.claimToken,
          documentVersionId: identity.documentVersionId,
          indexGenerationId: identity.generationId
        }
      } as const;
}

function headingArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`ARRAY[]::text[]`
    : Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;
}

function versionStatus(
  version: Readonly<{
    byteSize: number;
    createdAt: Date;
    fileName: string;
    id: string;
    ingestChunkCount: number | null;
    ingestCompletedAt: Date | null;
    ingestEmbeddedChunkCount: number;
    ingestErrorCode: string | null;
    ingestState: KnowledgeDocumentVersionStatus["state"];
    mimeType: string;
    originalStorageKey: string | null;
    pageCount: number | null;
    updatedAt: Date;
    versionNumber: number;
    visibleFromRevision: number | null;
    visibleUntilRevision: number | null;
  }>,
  currentVersionId: string | null
): KnowledgeDocumentVersionStatus {
  return {
    byteSize: version.byteSize,
    completedAt: version.ingestCompletedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    current: version.id === currentVersionId,
    embeddedChunks: version.ingestEmbeddedChunkCount,
    errorCode: version.ingestErrorCode,
    fileName: version.fileName,
    id: version.id,
    mimeType: version.mimeType,
    pageCount: version.pageCount,
    payloadAvailable: version.originalStorageKey !== null,
    state: version.ingestState,
    totalChunks: version.ingestChunkCount,
    updatedAt: version.updatedAt.toISOString(),
    versionNumber: version.versionNumber,
    visibleFromRevision: version.visibleFromRevision,
    visibleUntilRevision: version.visibleUntilRevision
  };
}

export function createPrismaKnowledgeIngestionRepository(client: PrismaClient = prisma) {
  async function lockOwnedBase(
    tx: Prisma.TransactionClient,
    userId: string,
    knowledgeBaseId: string
  ): Promise<LockedBase | null> {
    const rows = await tx.$queryRaw<LockedBase[]>`
      SELECT "activeIndexGenerationId", "archivedAt", "contentRevision", "ownerUserId", "version"
      FROM "KnowledgeBase"
      WHERE "id" = ${knowledgeBaseId}
        AND "ownerUserId" = ${userId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async function completedBatchIndexes(
    generationId: string,
    documentVersionId: string
  ): Promise<number[]> {
    const rows = await client.usageEvent.findMany({
      orderBy: { knowledgeBatchIndex: "asc" },
      select: { knowledgeBatchIndex: true },
      where: {
        knowledgeBatchIndex: { not: null },
        knowledgeDocumentVersionId: documentVersionId,
        knowledgeIndexGenerationId: generationId
      }
    });
    return rows.flatMap((row) => row.knowledgeBatchIndex === null ? [] : [row.knowledgeBatchIndex]);
  }

  async function reconcileGeneration(generationId: string, now: Date): Promise<boolean> {
    return client.$transaction(async (tx) => {
      const generationLookup = await tx.knowledgeIndexGeneration.findUnique({
        select: { knowledgeBaseId: true },
        where: { id: generationId }
      });
      if (!generationLookup) return false;
      const locked = await tx.$queryRaw<Array<{
        activeIndexGenerationId: string | null;
        archivedAt: Date | null;
        contentRevision: number;
        generationStatus: string;
        ownerUserId: string;
        sourceBaseVersion: number | null;
        sourceIndexGenerationId: string | null;
        targetContentRevision: number | null;
        version: number;
      }>>`
        SELECT
          base."activeIndexGenerationId",
          base."archivedAt",
          base."contentRevision",
          base."ownerUserId",
          base."version",
          generation."status"::text AS "generationStatus",
          generation."sourceBaseVersion",
          generation."sourceIndexGenerationId",
          generation."targetContentRevision"
        FROM "KnowledgeBase" AS base
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = base."id"
        WHERE base."id" = ${generationLookup.knowledgeBaseId}
          AND generation."id" = ${generationId}
        FOR UPDATE OF base, generation
      `;
      const state = locked[0];
      if (
        !state ||
        state.generationStatus !== "building" ||
        !state.sourceIndexGenerationId ||
        state.sourceBaseVersion === null ||
        state.targetContentRevision === null
      ) {
        return false;
      }
      if (state.archivedAt) {
        await tx.knowledgeIndexGeneration.update({
          data: {
            failedAt: now,
            lastErrorCode: "generation_superseded",
            status: "failed"
          },
          where: { id: generationId }
        });
        return false;
      }
      if (state.activeIndexGenerationId !== state.sourceIndexGenerationId) {
        await tx.knowledgeIndexGeneration.update({
          data: {
            failedAt: now,
            lastErrorCode: "generation_superseded",
            status: "failed"
          },
          where: { id: generationId }
        });
        return false;
      }

      const visibleVersions = await tx.knowledgeDocumentVersion.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          normalizedTextByteSize: true,
          normalizedTextChecksum: true,
          normalizedTextStorageKey: true,
          payloadPurgedAt: true
        },
        where: {
          ingestState: "ready",
          knowledgeBaseId: generationLookup.knowledgeBaseId,
          visibleFromRevision: { lte: state.contentRevision },
          OR: [
            { visibleUntilRevision: null },
            { visibleUntilRevision: { gt: state.contentRevision } }
          ]
        }
      });
      if (visibleVersions.some((version) =>
        version.payloadPurgedAt ||
        !version.normalizedTextStorageKey ||
        version.normalizedTextByteSize === null ||
        !version.normalizedTextChecksum)) {
        await tx.knowledgeIndexGeneration.update({
          data: {
            failedAt: now,
            lastErrorCode: "normalized_text_unavailable",
            status: "failed"
          },
          where: { id: generationId }
        });
        return false;
      }
      const expectedIds = new Set(visibleVersions.map(({ id }) => id));
      const existing = await tx.knowledgeGenerationDocument.findMany({
        orderBy: { documentVersionId: "asc" },
        where: { indexGenerationId: generationId }
      });
      const obsoleteIds = existing
        .filter((row) => !expectedIds.has(row.documentVersionId))
        .map((row) => row.documentVersionId);
      const existingIds = new Set(existing.map((row) => row.documentVersionId));
      const missingIds = visibleVersions
        .map(({ id }) => id)
        .filter((id) => !existingIds.has(id));

      if (obsoleteIds.length > 0) {
        await tx.usageEvent.deleteMany({
          where: {
            knowledgeDocumentVersionId: { in: obsoleteIds },
            knowledgeIndexGenerationId: generationId
          }
        });
        await tx.knowledgeChunk.deleteMany({
          where: {
            documentVersionId: { in: obsoleteIds },
            indexGenerationId: generationId
          }
        });
        await tx.knowledgeGenerationDocument.deleteMany({
          where: {
            documentVersionId: { in: obsoleteIds },
            indexGenerationId: generationId
          }
        });
      }
      if (missingIds.length > 0) {
        await tx.knowledgeGenerationDocument.createMany({
          data: missingIds.map((documentVersionId) => ({
            documentVersionId,
            indexGenerationId: generationId,
            knowledgeBaseId: generationLookup.knowledgeBaseId,
            nextAttemptAt: now,
            ownerUserId: state.ownerUserId
          }))
        });
      }
      if (
        state.contentRevision !== state.targetContentRevision ||
        state.version !== state.sourceBaseVersion ||
        obsoleteIds.length > 0 ||
        missingIds.length > 0
      ) {
        await tx.knowledgeIndexGeneration.update({
          data: {
            sourceBaseVersion: state.version,
            targetContentRevision: state.contentRevision
          },
          where: { id: generationId }
        });
        return true;
      }

      const current = await tx.knowledgeGenerationDocument.findMany({
        select: { chunkCount: true, embeddedChunkCount: true, state: true },
        where: { indexGenerationId: generationId }
      });
      if (
        current.length !== expectedIds.size ||
        current.some((row) => row.state !== "ready" || row.chunkCount === null ||
          row.chunkCount !== row.embeddedChunkCount)
      ) {
        return false;
      }

      const retired = await tx.knowledgeIndexGeneration.updateMany({
        data: { retiredAt: now, status: "retired" },
        where: { id: state.sourceIndexGenerationId, status: "active" }
      });
      const activated = await tx.knowledgeIndexGeneration.updateMany({
        data: {
          activatedAt: now,
          indexedContentRevision: state.contentRevision,
          readyAt: now,
          status: "active"
        },
        where: { id: generationId, status: "building" }
      });
      const base = await tx.knowledgeBase.updateMany({
        data: {
          activeIndexGenerationId: generationId,
          version: { increment: 1 }
        },
        where: {
          activeIndexGenerationId: state.sourceIndexGenerationId,
          contentRevision: state.contentRevision,
          id: generationLookup.knowledgeBaseId,
          version: state.version
        }
      });
      if (retired.count !== 1 || activated.count !== 1 || base.count !== 1) {
        throw new Error("knowledge_reindex_activation_fence_failed");
      }
      return false;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  const repository = {
    async canManage(userId: string, knowledgeBaseId: string): Promise<boolean> {
      return (await client.knowledgeBase.count({
        where: {
          activeIndexGenerationId: { not: null },
          archivedAt: null,
          id: knowledgeBaseId,
          ownerUserId: userId
        }
      })) === 1;
    },

    async claim(input: {
      claimToken: string;
      now: Date;
      staleBefore: Date;
    }): Promise<KnowledgeWorkClaim | null> {
      return client.$transaction(async (tx) => {
        const lastGrantedOwnerUserId = await lockKnowledgeFairnessCursor(tx);
        const ownerUserId = await selectEligibleKnowledgeOwner(
          tx,
          input,
          lastGrantedOwnerUserId
        );
        if (!ownerUserId) return null;
        const claim = await claimDocument(tx, input, ownerUserId) ??
          await claimReindex(tx, input, ownerUserId);
        if (!claim) return null;
        const advanced = await tx.$executeRaw(Prisma.sql`
          UPDATE "DocumentProcessingFairnessCursor"
          SET "lastGrantedOwnerUserId" = ${ownerUserId},
              "updatedAt" = ${input.now}
          WHERE "pipeline" = 'knowledge'
        `);
        if (advanced !== 1) throw new Error("knowledge_fairness_cursor_lost");
        return claim;
      });
    },

    completedBatchIndexes,

    async recoverReindexChunkPlan(input: KnowledgeWorkIdentity & {
      chunkingProfileVersion: number;
      maxChunks: number;
    }): Promise<readonly KnowledgeChunkPlanEntry[] | null> {
      if (
        input.kind !== "reindex" ||
        !Number.isSafeInteger(input.maxChunks) ||
        input.maxChunks < 1
      ) {
        return null;
      }
      const target = await client.knowledgeIndexGeneration.findFirst({
        select: { sourceIndexGenerationId: true },
        where: {
          chunkingProfileVersion: input.chunkingProfileVersion,
          generationDocuments: {
            some: {
              claimToken: input.claimToken,
              documentVersionId: input.documentVersionId
            }
          },
          id: input.generationId,
          sourceIndexGeneration: {
            is: {
              chunkingProfileVersion: input.chunkingProfileVersion,
              status: "active"
            }
          },
          status: "building"
        }
      });
      if (!target?.sourceIndexGenerationId) return null;

      const rows = await client.knowledgeChunk.findMany({
        orderBy: { chunkIndex: "asc" },
        select: {
          chunkIndex: true,
          headingPath: true,
          page: true,
          text: true
        },
        take: input.maxChunks + 1,
        where: {
          documentVersionId: input.documentVersionId,
          indexGenerationId: target.sourceIndexGenerationId
        }
      });
      if (
        rows.length === 0 ||
        rows.length > input.maxChunks ||
        rows.some((row, index) => row.chunkIndex !== index)
      ) {
        return null;
      }
      return rows.map((row) => ({
        headingPath: row.headingPath,
        index: row.chunkIndex,
        page: row.page,
        text: row.text
      }));
    },

    async completeChunking(input: KnowledgeWorkIdentity & {
      chunkCount: number;
      now: Date;
    }): Promise<boolean> {
      if (input.kind !== "document") return false;
      const updated = await client.knowledgeDocumentVersion.updateMany({
        data: {
          ingestAttemptCount: 0,
          ingestChunkCount: input.chunkCount,
          ingestClaimedAt: null,
          ingestClaimToken: null,
          ingestEmbeddedChunkCount: 0,
          ingestNextAttemptAt: input.now,
          ingestState: "embedding",
          updatedAt: input.now
        },
        where: {
          id: input.documentVersionId,
          ingestClaimToken: input.claimToken,
          ingestGenerationId: input.generationId,
          ingestState: "chunking"
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
    }): Promise<boolean> {
      if (input.kind !== "document") return false;
      const updated = await client.knowledgeDocumentVersion.updateMany({
        data: {
          ingestAttemptCount: 0,
          ingestClaimedAt: null,
          ingestClaimToken: null,
          ingestNextAttemptAt: input.now,
          ingestState: "chunking",
          normalizedTextByteSize: input.normalizedTextByteSize,
          normalizedTextChecksum: input.normalizedTextChecksum,
          normalizedTextStorageKey: input.normalizedTextStorageKey,
          pageCount: input.pageCount,
          updatedAt: input.now
        },
        where: {
          id: input.documentVersionId,
          ingestClaimToken: input.claimToken,
          ingestGenerationId: input.generationId,
          ingestState: "parsing"
        }
      });
      return updated.count === 1;
    },

    async createVersion(input: KnowledgeVersionCreateInput): Promise<KnowledgeVersionCreateResult> {
      try {
        return await serializable(() => client.$transaction(async (tx) => {
          const base = await lockOwnedBase(tx, input.userId, input.knowledgeBaseId);
          if (!base || base.archivedAt || !base.activeIndexGenerationId) {
            return { kind: "not_found" } as const;
          }

          if (input.replaceDocumentId) {
            const documents = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "KnowledgeDocument"
              WHERE "id" = ${input.replaceDocumentId}
                AND "knowledgeBaseId" = ${input.knowledgeBaseId}
                AND "archivedAt" IS NULL
              FOR UPDATE
            `;
            if (!documents[0] || documents[0].id !== input.documentId) {
              return { kind: "not_found" } as const;
            }
          } else {
            await tx.knowledgeDocument.create({
              data: { id: input.documentId, knowledgeBaseId: input.knowledgeBaseId }
            });
          }

          const activeIngest = await tx.knowledgeDocumentVersion.count({
            where: {
              documentId: input.documentId,
              ingestState: { in: ["queued", "parsing", "chunking", "embedding"] }
            }
          });
          if (activeIngest > 0) return { kind: "active_ingest" } as const;
          const latest = await tx.knowledgeDocumentVersion.aggregate({
            _max: { versionNumber: true },
            where: { documentId: input.documentId }
          });
          await tx.knowledgeDocumentVersion.create({
            data: {
              byteSize: input.byteSize,
              checksum: input.checksum,
              documentId: input.documentId,
              fileName: input.fileName,
              id: input.documentVersionId,
              ingestGenerationId: base.activeIndexGenerationId,
              ingestNextAttemptAt: new Date(),
              knowledgeBaseId: input.knowledgeBaseId,
              mimeType: input.mimeType,
              normalizedTextStorageKey: input.normalizedTextStorageKey,
              ownerUserId: base.ownerUserId,
              originalStorageKey: input.originalStorageKey,
              versionNumber: (latest._max.versionNumber ?? 0) + 1
            }
          });
          return {
            documentId: input.documentId,
            kind: "ok",
            versionId: input.documentVersionId
          } as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (uniqueConflict(error)) return { kind: "active_ingest" };
        throw error;
      }
    },

    async advanceDocumentToParsing(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean> {
      if (input.kind !== "document") return false;
      const updated = await client.knowledgeDocumentVersion.updateMany({
        data: {
          ingestAttemptCount: 0,
          ingestClaimedAt: null,
          ingestClaimToken: null,
          ingestNextAttemptAt: input.now,
          ingestStartedAt: input.now,
          ingestState: "parsing",
          updatedAt: input.now
        },
        where: {
          id: input.documentVersionId,
          ingestClaimToken: input.claimToken,
          ingestGenerationId: input.generationId,
          ingestState: "queued"
        }
      });
      return updated.count === 1;
    },

    async advanceReindexToEmbedding(input: KnowledgeWorkIdentity & {
      chunkCount: number;
      now: Date;
    }): Promise<boolean> {
      if (input.kind !== "reindex") return false;
      const updated = await client.knowledgeGenerationDocument.updateMany({
        data: {
          attemptCount: 0,
          chunkCount: input.chunkCount,
          claimToken: null,
          claimedAt: null,
          embeddedChunkCount: 0,
          nextAttemptAt: input.now,
          state: "embedding",
          updatedAt: input.now
        },
        where: {
          claimToken: input.claimToken,
          documentVersionId: input.documentVersionId,
          indexGenerationId: input.generationId,
          state: "queued"
        }
      });
      return updated.count === 1;
    },

    async activateDocumentVersion(input: KnowledgeWorkIdentity & {
      expectedChunkCount: number;
      now: Date;
    }): Promise<"activated" | "deferred" | "lease_lost" | "retargeted"> {
      if (input.kind !== "document") return "lease_lost";
      return client.$transaction(async (tx) => {
        const versionLookup = await tx.knowledgeDocumentVersion.findUnique({
          select: { knowledgeBaseId: true },
          where: { id: input.documentVersionId }
        });
        if (!versionLookup) return "lease_lost";
        const baseRows = await tx.$queryRaw<LockedBase[]>`
          SELECT "activeIndexGenerationId", "archivedAt", "contentRevision", "ownerUserId", "version"
          FROM "KnowledgeBase"
          WHERE "id" = ${versionLookup.knowledgeBaseId}
          FOR UPDATE
        `;
        const base = baseRows[0];
        if (!base || base.archivedAt || !base.activeIndexGenerationId) return "deferred";
        const versions = await tx.$queryRaw<Array<{
          documentId: string;
          ingestChunkCount: number | null;
          ingestGenerationId: string | null;
        }>>`
          SELECT "documentId", "ingestChunkCount", "ingestGenerationId"
          FROM "KnowledgeDocumentVersion"
          WHERE "id" = ${input.documentVersionId}
            AND "ingestState" = 'embedding'::"KnowledgeDocumentIngestState"
            AND "ingestClaimToken" = ${input.claimToken}
            AND "ingestGenerationId" = ${input.generationId}
          FOR UPDATE
        `;
        const version = versions[0];
        if (!version || version.ingestChunkCount !== input.expectedChunkCount) return "lease_lost";
        const documents = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          currentVersionId: string | null;
        }>>`
          SELECT "archivedAt", "currentVersionId"
          FROM "KnowledgeDocument"
          WHERE "id" = ${version.documentId}
            AND "knowledgeBaseId" = ${versionLookup.knowledgeBaseId}
          FOR UPDATE
        `;
        const document = documents[0];
        if (!document || document.archivedAt) return "deferred";

        if (base.activeIndexGenerationId !== input.generationId) {
          await tx.knowledgeDocumentVersion.update({
            data: {
              ingestAttemptCount: 0,
              ingestChunkCount: null,
              ingestClaimedAt: null,
              ingestClaimToken: null,
              ingestEmbeddedChunkCount: 0,
              ingestGenerationId: base.activeIndexGenerationId,
              ingestNextAttemptAt: input.now,
              ingestState: "chunking"
            },
            where: { id: input.documentVersionId }
          });
          return "retargeted";
        }
        const chunkCount = await tx.knowledgeChunk.count({
          where: {
            documentVersionId: input.documentVersionId,
            indexGenerationId: input.generationId
          }
        });
        if (chunkCount !== input.expectedChunkCount) return "lease_lost";

        const nextRevision = base.contentRevision + 1;
        if (document.currentVersionId && document.currentVersionId !== input.documentVersionId) {
          await tx.knowledgeDocumentVersion.updateMany({
            data: { visibleUntilRevision: nextRevision },
            where: {
              id: document.currentVersionId,
              visibleFromRevision: { not: null },
              visibleUntilRevision: null
            }
          });
        }
        await tx.knowledgeDocumentVersion.update({
          data: {
            ingestAttemptCount: 0,
            ingestClaimedAt: null,
            ingestClaimToken: null,
            ingestCompletedAt: input.now,
            ingestEmbeddedChunkCount: input.expectedChunkCount,
            ingestErrorCode: null,
            ingestState: "ready",
            visibleFromRevision: nextRevision,
            visibleUntilRevision: null
          },
          where: { id: input.documentVersionId }
        });
        await tx.knowledgeDocument.update({
          data: { currentVersionId: input.documentVersionId },
          where: { id: version.documentId }
        });
        await tx.knowledgeBase.update({
          data: { contentRevision: nextRevision, version: { increment: 1 } },
          where: { id: versionLookup.knowledgeBaseId }
        });
        await tx.knowledgeIndexGeneration.update({
          data: { indexedContentRevision: nextRevision },
          where: { id: input.generationId }
        });
        return "activated";
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    async archiveDocument(input: Readonly<{
      documentId: string;
      knowledgeBaseId: string;
      now: Date;
      userId: string;
    }>): Promise<KnowledgeDocumentMutationResult> {
      return serializable(() => client.$transaction(async (tx) => {
        const base = await lockOwnedBase(tx, input.userId, input.knowledgeBaseId);
        if (!base || base.archivedAt || !base.activeIndexGenerationId) {
          return { kind: "not_found" } as const;
        }
        const rows = await tx.$queryRaw<Array<{
          archivedAt: Date | null;
          currentVersionId: string | null;
        }>>`
          SELECT "archivedAt", "currentVersionId"
          FROM "KnowledgeDocument"
          WHERE "id" = ${input.documentId}
            AND "knowledgeBaseId" = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const document = rows[0];
        if (!document) return { kind: "not_found" } as const;
        if (document.archivedAt) return { kind: "ok" } as const;

        let nextRevision: number | null = null;
        if (document.currentVersionId) {
          nextRevision = base.contentRevision + 1;
          await tx.knowledgeDocumentVersion.updateMany({
            data: { visibleUntilRevision: nextRevision },
            where: {
              id: document.currentVersionId,
              visibleFromRevision: { not: null },
              visibleUntilRevision: null
            }
          });
        }
        await tx.knowledgeDocumentVersion.updateMany({
          data: {
            ingestClaimedAt: null,
            ingestClaimToken: null,
            ingestCompletedAt: input.now,
            ingestErrorCode: "knowledge_ingestion_failed",
            ingestState: "failed"
          },
          where: {
            documentId: input.documentId,
            ingestState: { in: ["queued", "parsing", "chunking", "embedding"] }
          }
        });
        await tx.knowledgeDocument.update({
          data: { archivedAt: input.now, currentVersionId: null },
          where: { id: input.documentId }
        });
        await tx.knowledgeBase.update({
          data: {
            ...(nextRevision === null ? {} : { contentRevision: nextRevision }),
            version: { increment: 1 }
          },
          where: { id: input.knowledgeBaseId }
        });
        if (nextRevision !== null) {
          await tx.knowledgeIndexGeneration.update({
            data: { indexedContentRevision: nextRevision },
            where: { id: base.activeIndexGenerationId }
          });
        }
        return { kind: "ok" } as const;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    },

    async heartbeat(input: KnowledgeWorkIdentity & { now: Date }): Promise<boolean> {
      const where = identityWhere(input);
      if ("document" in where) {
        const updated = await client.knowledgeDocumentVersion.updateMany({
          data: { ingestClaimedAt: input.now },
          where: where.document
        });
        return updated.count === 1;
      }
      const updated = await client.knowledgeGenerationDocument.updateMany({
        data: { claimedAt: input.now },
        where: where.reindex
      });
      return updated.count === 1;
    },

    async listStatus(
      userId: string,
      knowledgeBaseId: string,
      input: Readonly<{
        documentId?: string;
        page?: number;
        pageSize?: number;
        query?: string;
      }> = {}
    ): Promise<KnowledgeIngestionStatusResponse | null> {
      const requestedPage = Number.isSafeInteger(input.page) && Number(input.page) > 0
        ? Number(input.page)
        : 1;
      const pageSize = Number.isSafeInteger(input.pageSize) && Number(input.pageSize) > 0 &&
        Number(input.pageSize) <= KNOWLEDGE_DOCUMENT_PAGE_SIZE_MAX
        ? Number(input.pageSize)
        : KNOWLEDGE_DOCUMENT_PAGE_SIZE;
      const query = input.query?.trim() ?? "";

      return client.$transaction(async (tx) => {
        const memberships = await tx.userGroup.findMany({
          select: { groupId: true },
          where: { group: { archivedAt: null }, userId }
        });
        const groupIds = memberships.map(({ groupId }) => groupId);
        const base = await tx.knowledgeBase.findFirst({
          select: { ownerUserId: true },
          where: {
            id: knowledgeBaseId,
            OR: [
              { ownerUserId: userId },
              {
                archivedAt: null,
                publications: {
                  some: {
                    OR: [
                      { scope: "installation" },
                      ...(groupIds.length > 0
                        ? [{ groupId: { in: groupIds }, group: { archivedAt: null }, scope: "group" as const }]
                        : [])
                    ]
                  }
                }
              }
            ]
          }
        });
        if (!base) return null;
        const owned = base.ownerUserId === userId;
        const fileNameFilter = query
          ? { contains: query, mode: Prisma.QueryMode.insensitive }
          : undefined;
        const documentWhere: Prisma.KnowledgeDocumentWhereInput = {
          knowledgeBaseId,
          ...(input.documentId ? { id: input.documentId } : {}),
          ...(owned
            ? fileNameFilter
              ? { versions: { some: { fileName: fileNameFilter } } }
              : {}
            : {
                archivedAt: null,
                currentVersion: {
                  is: {
                    ...(fileNameFilter ? { fileName: fileNameFilter } : {}),
                    ingestState: "ready"
                  }
                }
              })
        };
        const totalItems = await tx.knowledgeDocument.count({ where: documentWhere });
        const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
        const page = Math.min(requestedPage, Math.max(1, totalPages));
        const rows = await tx.knowledgeDocument.findMany({
          include: { versions: { orderBy: { versionNumber: "desc" } } },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          where: documentWhere
        });
        const documents: KnowledgeDocumentStatus[] = rows.flatMap((document) => {
          const versions = document.versions
            .filter((version) => owned || version.id === document.currentVersionId && version.ingestState === "ready")
            .map((version) => versionStatus(version, document.currentVersionId));
          if (!owned && versions.length === 0) return [];
          return [{
            archived: document.archivedAt !== null,
            currentVersionId: document.currentVersionId,
            id: document.id,
            versions
          }];
        });

        const latest = owned ? await tx.knowledgeIndexGeneration.findFirst({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            createdAt: true,
            id: true,
            lastErrorCode: true,
            status: true,
            targetContentRevision: true
          },
          where: { knowledgeBaseId, sourceIndexGenerationId: { not: null } }
        }) : null;
        const stateCounts = latest ? await tx.knowledgeGenerationDocument.groupBy({
          _count: { _all: true },
          by: ["state"],
          where: { indexGenerationId: latest.id }
        }) : [];
        const countFor = (state: "failed" | "ready") =>
          stateCounts.find((row) => row.state === state)?._count._all ?? 0;
        const reindex: KnowledgeReindexProgress | null = latest
          ? {
              completedDocuments: countFor("ready"),
              createdAt: latest.createdAt.toISOString(),
              errorCode: latest.lastErrorCode,
              failedDocuments: countFor("failed"),
              generationId: latest.id,
              status: latest.status,
              targetContentRevision: latest.targetContentRevision ?? 0,
              totalDocuments: stateCounts.reduce((total, row) => total + row._count._all, 0)
            }
          : null;
        return {
          documents,
          owned,
          pagination: { page, pageSize, query, totalItems, totalPages },
          reindex
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    async persistEmbeddingBatch(input: KnowledgeWorkIdentity & {
      batch: KnowledgeEmbeddingBatchWrite;
      now: Date;
      ownerUserId: string;
      targetDimension: number;
    }): Promise<boolean> {
      if (
        input.batch.chunks.length < 1 ||
        input.batch.chunks.some((chunk) =>
          chunk.vector.length !== input.targetDimension ||
          chunk.vector.some((value) => !Number.isFinite(value)))
      ) {
        return false;
      }
      return client.$transaction(async (tx) => {
        let knowledgeBaseId: string | null = null;
        if (input.kind === "document") {
          const rows = await tx.$queryRaw<Array<{ knowledgeBaseId: string }>>`
            SELECT "knowledgeBaseId"
            FROM "KnowledgeDocumentVersion"
            WHERE "id" = ${input.documentVersionId}
              AND "ingestGenerationId" = ${input.generationId}
              AND "ingestClaimToken" = ${input.claimToken}
              AND "ingestState" = 'embedding'::"KnowledgeDocumentIngestState"
            FOR UPDATE
          `;
          knowledgeBaseId = rows[0]?.knowledgeBaseId ?? null;
        } else {
          const rows = await tx.$queryRaw<Array<{ knowledgeBaseId: string }>>`
            SELECT work."knowledgeBaseId"
            FROM "KnowledgeGenerationDocument" AS work
            INNER JOIN "KnowledgeIndexGeneration" AS generation
              ON generation."id" = work."indexGenerationId"
            WHERE work."indexGenerationId" = ${input.generationId}
              AND work."documentVersionId" = ${input.documentVersionId}
              AND work."claimToken" = ${input.claimToken}
              AND work."state" = 'embedding'::"KnowledgeDocumentIngestState"
              AND generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
            FOR UPDATE OF work
          `;
          knowledgeBaseId = rows[0]?.knowledgeBaseId ?? null;
        }
        if (!knowledgeBaseId) return false;
        const existing = await tx.usageEvent.findFirst({
          select: { id: true },
          where: {
            knowledgeBatchIndex: input.batch.batchIndex,
            knowledgeDocumentVersionId: input.documentVersionId,
            knowledgeIndexGenerationId: input.generationId
          }
        });
        if (existing) return true;

        for (const chunk of input.batch.chunks) {
          const vector = `[${chunk.vector.join(",")}]`;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "KnowledgeChunk" (
              "id", "knowledgeBaseId", "documentVersionId", "indexGenerationId",
              "chunkIndex", "page", "headingPath", "text",
              "embeddingDimension", "embedding", "createdAt"
            ) VALUES (
              ${randomUUID()}, ${knowledgeBaseId}, ${input.documentVersionId}, ${input.generationId},
              ${chunk.index}, ${chunk.page}, ${headingArray(chunk.headingPath)}, ${chunk.text},
              ${input.targetDimension}, ${vector}::vector, ${input.now}
            )
            ON CONFLICT ("indexGenerationId", "documentVersionId", "chunkIndex")
            DO UPDATE SET
              "page" = EXCLUDED."page",
              "headingPath" = EXCLUDED."headingPath",
              "text" = EXCLUDED."text",
              "embeddingDimension" = EXCLUDED."embeddingDimension",
              "embedding" = EXCLUDED."embedding"
          `);
        }
        await tx.usageEvent.create({
          data: {
            inputTokens: input.batch.usage.inputTokens ?? 0,
            knowledgeBaseId,
            knowledgeBatchIndex: input.batch.batchIndex,
            knowledgeDocumentVersionId: input.documentVersionId,
            knowledgeIndexGenerationId: input.generationId,
            modelId: input.batch.modelId,
            provider: input.batch.provider,
            providerModelId: input.batch.providerModelId,
            totalTokens: input.batch.usage.totalTokens ?? input.batch.usage.inputTokens ?? 0,
            userId: input.ownerUserId
          }
        });
        const embeddedChunkCount = await tx.knowledgeChunk.count({
          where: {
            documentVersionId: input.documentVersionId,
            indexGenerationId: input.generationId
          }
        });
        if (input.kind === "document") {
          await tx.knowledgeDocumentVersion.update({
            data: { ingestEmbeddedChunkCount: embeddedChunkCount },
            where: { id: input.documentVersionId }
          });
        } else {
          await tx.knowledgeGenerationDocument.update({
            data: { embeddedChunkCount },
            where: {
              indexGenerationId_documentVersionId: {
                documentVersionId: input.documentVersionId,
                indexGenerationId: input.generationId
              }
            }
          });
        }
        return true;
      });
    },

    async reconcile(input: { now: Date }): Promise<boolean> {
      const abandoned = await client.knowledgeDocumentVersion.updateMany({
        data: {
          ingestClaimedAt: null,
          ingestClaimToken: null,
          ingestCompletedAt: input.now,
          ingestErrorCode: "knowledge_ingestion_failed",
          ingestState: "failed",
          updatedAt: input.now
        },
        where: {
          document: {
            OR: [
              { archivedAt: { not: null } },
              { knowledgeBase: { archivedAt: { not: null } } }
            ]
          },
          ingestState: { in: ["queued", "parsing", "chunking", "embedding"] }
        }
      });
      const generations = await client.knowledgeIndexGeneration.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 10,
        where: { sourceIndexGenerationId: { not: null }, status: "building" }
      });
      let workAdded = abandoned.count > 0;
      for (const generation of generations) {
        if (await reconcileGeneration(generation.id, input.now)) workAdded = true;
      }
      return workAdded;
    },

    async retryLater(input: KnowledgeWorkIdentity & {
      errorCode: KnowledgeIngestionFailureCode;
      nextAttemptAt: Date;
      now: Date;
    }): Promise<boolean> {
      const where = identityWhere(input);
      if ("document" in where) {
        const updated = await client.knowledgeDocumentVersion.updateMany({
          data: {
            ingestClaimedAt: null,
            ingestClaimToken: null,
            ingestNextAttemptAt: input.nextAttemptAt,
            updatedAt: input.now
          },
          where: where.document
        });
        return updated.count === 1;
      }
      const updated = await client.knowledgeGenerationDocument.updateMany({
        data: {
          claimToken: null,
          claimedAt: null,
          nextAttemptAt: input.nextAttemptAt,
          updatedAt: input.now
        },
        where: where.reindex
      });
      return updated.count === 1;
    },

    async retryVersion(input: Readonly<{
      documentId: string;
      knowledgeBaseId: string;
      now: Date;
      userId: string;
      versionId: string;
    }>): Promise<KnowledgeDocumentMutationResult> {
      try {
        return await serializable(() => client.$transaction(async (tx) => {
          const base = await lockOwnedBase(tx, input.userId, input.knowledgeBaseId);
          if (!base || base.archivedAt || !base.activeIndexGenerationId) {
            return { kind: "not_found" } as const;
          }
          const rows = await tx.$queryRaw<Array<{
            ingestChunkCount: number | null;
            ingestErrorCode: string | null;
            ingestGenerationId: string | null;
            normalizedTextByteSize: number | null;
            normalizedTextChecksum: string | null;
            normalizedTextStorageKey: string | null;
            originalStorageKey: string | null;
          }>>`
            SELECT
              version."ingestChunkCount", version."ingestErrorCode", version."ingestGenerationId",
              version."normalizedTextByteSize", version."normalizedTextChecksum",
              version."normalizedTextStorageKey", version."originalStorageKey"
            FROM "KnowledgeDocumentVersion" AS version
            INNER JOIN "KnowledgeDocument" AS document ON document."id" = version."documentId"
            WHERE version."id" = ${input.versionId}
              AND version."documentId" = ${input.documentId}
              AND version."knowledgeBaseId" = ${input.knowledgeBaseId}
              AND version."ingestState" = 'failed'::"KnowledgeDocumentIngestState"
              AND document."archivedAt" IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "KnowledgeDocumentVersion" AS newer
                WHERE newer."documentId" = version."documentId"
                  AND newer."versionNumber" > version."versionNumber"
              )
            FOR UPDATE OF version, document
          `;
          const version = rows[0];
          if (!version) return { kind: "not_found" } as const;
          if (!version.originalStorageKey) return { kind: "not_retryable" } as const;
          const resumeEmbedding =
            version.ingestGenerationId === base.activeIndexGenerationId &&
            version.ingestErrorCode?.startsWith("embedding_") &&
            version.normalizedTextStorageKey !== null &&
            version.normalizedTextByteSize !== null &&
            version.normalizedTextChecksum !== null &&
            version.ingestChunkCount !== null;
          if (!resumeEmbedding && version.ingestGenerationId) {
            await tx.usageEvent.deleteMany({
              where: {
                knowledgeDocumentVersionId: input.versionId,
                knowledgeIndexGenerationId: version.ingestGenerationId
              }
            });
            await tx.knowledgeChunk.deleteMany({
              where: {
                documentVersionId: input.versionId,
                indexGenerationId: version.ingestGenerationId
              }
            });
          }
          await tx.knowledgeDocumentVersion.update({
            data: {
              ingestAttemptCount: 0,
              ingestClaimedAt: null,
              ingestClaimToken: null,
              ingestCompletedAt: null,
              ingestEmbeddedChunkCount: resumeEmbedding ? undefined : 0,
              ingestErrorCode: null,
              ingestGenerationId: base.activeIndexGenerationId,
              ingestNextAttemptAt: input.now,
              ingestStartedAt: resumeEmbedding ? undefined : null,
              ingestState: resumeEmbedding ? "embedding" : "queued",
              ...(resumeEmbedding ? {} : { ingestChunkCount: null })
            },
            where: { id: input.versionId }
          });
          return { kind: "ok" } as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (uniqueConflict(error)) return { kind: "not_retryable" };
        throw error;
      }
    },

    async settleFailed(input: KnowledgeWorkIdentity & {
      errorCode: KnowledgeIngestionFailureCode;
      now: Date;
    }): Promise<boolean> {
      const where = identityWhere(input);
      if ("document" in where) {
        const updated = await client.knowledgeDocumentVersion.updateMany({
          data: {
            ingestClaimedAt: null,
            ingestClaimToken: null,
            ingestCompletedAt: input.now,
            ingestErrorCode: input.errorCode,
            ingestState: "failed",
            updatedAt: input.now
          },
          where: where.document
        });
        return updated.count === 1;
      }
      return client.$transaction(async (tx) => {
        const work = await tx.$queryRaw<Array<{ knowledgeBaseId: string }>>`
          SELECT "knowledgeBaseId"
          FROM "KnowledgeGenerationDocument"
          WHERE "indexGenerationId" = ${input.generationId}
            AND "documentVersionId" = ${input.documentVersionId}
            AND "claimToken" = ${input.claimToken}
          FOR UPDATE
        `;
        if (!work[0]) return false;
        await tx.knowledgeGenerationDocument.update({
          data: {
            claimToken: null,
            claimedAt: null,
            errorCode: input.errorCode,
            state: "failed",
            updatedAt: input.now
          },
          where: {
            indexGenerationId_documentVersionId: {
              documentVersionId: input.documentVersionId,
              indexGenerationId: input.generationId
            }
          }
        });
        const generation = await tx.knowledgeIndexGeneration.updateMany({
          data: {
            failedAt: input.now,
            lastErrorCode: input.errorCode,
            status: "failed"
          },
          where: { id: input.generationId, status: "building" }
        });
        return generation.count === 1;
      });
    },

    async settleReindexReady(input: KnowledgeWorkIdentity & {
      expectedChunkCount: number;
      now: Date;
    }): Promise<boolean> {
      if (input.kind !== "reindex") return false;
      return client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ chunkCount: number | null }>>`
          SELECT work."chunkCount"
          FROM "KnowledgeGenerationDocument" AS work
          INNER JOIN "KnowledgeIndexGeneration" AS generation
            ON generation."id" = work."indexGenerationId"
          WHERE work."indexGenerationId" = ${input.generationId}
            AND work."documentVersionId" = ${input.documentVersionId}
            AND work."claimToken" = ${input.claimToken}
            AND work."state" = 'embedding'::"KnowledgeDocumentIngestState"
            AND generation."status" = 'building'::"KnowledgeIndexGenerationStatus"
          FOR UPDATE OF work
        `;
        if (!rows[0] || rows[0].chunkCount !== input.expectedChunkCount) return false;
        const chunkCount = await tx.knowledgeChunk.count({
          where: {
            documentVersionId: input.documentVersionId,
            indexGenerationId: input.generationId
          }
        });
        if (chunkCount !== input.expectedChunkCount) return false;
        await tx.knowledgeGenerationDocument.update({
          data: {
            attemptCount: 0,
            claimToken: null,
            claimedAt: null,
            embeddedChunkCount: chunkCount,
            state: "ready",
            updatedAt: input.now
          },
          where: {
            indexGenerationId_documentVersionId: {
              documentVersionId: input.documentVersionId,
              indexGenerationId: input.generationId
            }
          }
        });
        return true;
      });
    },

    async startReindex(input: Readonly<{
      embeddingDeploymentId: string;
      knowledgeBaseId: string;
      now: Date;
      userId: string;
    }>): Promise<KnowledgeReindexStartResult> {
      try {
        return await serializable(() => client.$transaction(async (tx) => {
          const base = await lockOwnedBase(tx, input.userId, input.knowledgeBaseId);
          if (!base || base.archivedAt || !base.activeIndexGenerationId) {
            return { kind: "not_found" } as const;
          }
          const existing = await tx.knowledgeIndexGeneration.count({
            where: {
              knowledgeBaseId: input.knowledgeBaseId,
              sourceIndexGenerationId: { not: null },
              status: "building"
            }
          });
          if (existing > 0) return { kind: "reindex_in_progress" } as const;
          const deployment: KnowledgeEmbeddingDeploymentResolution | undefined =
            (await resolveKnowledgeEmbeddingDeployments(tx, input.userId)).find(
              (candidate) => candidate.public.id === input.embeddingDeploymentId
            );
          if (!deployment) return { kind: "embedding_not_available" } as const;
          if (!deployment.pin.indexSupported) {
            return { kind: "embedding_dimension_not_supported" } as const;
          }
          const visible = await tx.knowledgeDocumentVersion.findMany({
            orderBy: { id: "asc" },
            select: {
              id: true,
              normalizedTextByteSize: true,
              normalizedTextChecksum: true,
              normalizedTextStorageKey: true,
              payloadPurgedAt: true
            },
            where: {
              ingestState: "ready",
              knowledgeBaseId: input.knowledgeBaseId,
              visibleFromRevision: { lte: base.contentRevision },
              OR: [
                { visibleUntilRevision: null },
                { visibleUntilRevision: { gt: base.contentRevision } }
              ]
            }
          });
          if (visible.some((version) =>
            version.payloadPurgedAt ||
            !version.normalizedTextStorageKey ||
            version.normalizedTextByteSize === null ||
            !version.normalizedTextChecksum)) {
            return { kind: "normalized_text_unavailable" } as const;
          }
          const generation = await tx.knowledgeIndexGeneration.create({
            data: {
              chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
              embeddingConfiguration: deployment.pin.configuration as unknown as Prisma.InputJsonValue,
              embeddingProviderModelId: deployment.public.id,
              indexedContentRevision: 0,
              knowledgeBaseId: input.knowledgeBaseId,
              sourceBaseVersion: base.version,
              sourceIndexGenerationId: base.activeIndexGenerationId,
              status: "building",
              targetContentRevision: base.contentRevision,
              targetDimension: deployment.pin.targetDimension,
              vectorSpaceFingerprint: deployment.pin.fingerprint
            },
            select: { id: true }
          });
          if (visible.length > 0) {
            await tx.knowledgeGenerationDocument.createMany({
              data: visible.map((version) => ({
                documentVersionId: version.id,
                indexGenerationId: generation.id,
                knowledgeBaseId: input.knowledgeBaseId,
                nextAttemptAt: input.now,
                ownerUserId: base.ownerUserId
              }))
            });
          } else {
            await tx.knowledgeIndexGeneration.update({
              data: {
                activatedAt: input.now,
                indexedContentRevision: base.contentRevision,
                readyAt: input.now,
                status: "active"
              },
              where: { id: generation.id }
            });
            await tx.knowledgeIndexGeneration.update({
              data: { retiredAt: input.now, status: "retired" },
              where: { id: base.activeIndexGenerationId }
            });
            await tx.knowledgeBase.update({
              data: { activeIndexGenerationId: generation.id, version: { increment: 1 } },
              where: { id: input.knowledgeBaseId }
            });
          }
          return { generationId: generation.id, kind: "ok" } as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
      } catch (error) {
        if (uniqueConflict(error)) return { kind: "reindex_in_progress" };
        throw error;
      }
    }
  };

  return repository;
}

export type PrismaKnowledgeIngestionRepository = ReturnType<typeof createPrismaKnowledgeIngestionRepository>;
