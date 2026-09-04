import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";

type RawKnowledgeClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

type V1DocumentRow = Readonly<{
  archivedAt: Date | null;
  currentVersionId: string | null;
  documentId: string;
  knowledgeBaseId: string;
  ownerUserId: string;
  updatedAt: Date;
}>;

type V1VersionRow = Readonly<{
  byteSize: number;
  checksum: string;
  createdAt: Date;
  documentVersionId: string;
  fileName: string;
  ingestState: "chunking" | "embedding" | "failed" | "parsing" | "queued" | "ready";
  ingestWarningCodes: string[];
  mimeType: string;
  normalizedTextByteSize: number | null;
  normalizedTextChecksum: string | null;
  normalizedTextStorageKey: string | null;
  originalStorageKey: string | null;
  pageCount: number | null;
  updatedAt: Date;
  versionNumber: number;
}>;

type V1GenerationCandidateRow = V1VersionRow & Readonly<{
  candidateChunkCount: number | null;
  candidateErrorCode: string | null;
  candidateState: V1VersionRow["ingestState"];
  candidateUpdatedAt: Date;
  indexGenerationId: string;
  knowledgeBaseId: string;
  profileRevisionId: string | null;
}>;

type SnapshotBaseRow = Readonly<{
  ownerUserId: string;
  profileRevisionId: string;
  sourceRevision: number;
}>;

type SnapshotMembershipRow = Readonly<{
  artifactId: string | null;
  currentVersionId: string | null;
  ownerUserId: string;
  sourceId: string;
}>;

type ExistingSnapshotRow = Readonly<{
  evidenceFingerprint: string;
  readySourceCount: number;
  sourceCount: number;
  sourceRevision: number;
}>;

type AggregateCountRow = Readonly<{
  invalidArtifactMappings: bigint;
  invalidDocumentMappings: bigint;
  invalidVersionMappings: bigint;
  mappedDocuments: bigint;
  mappedGenerationCandidates: bigint;
  mappedVersions: bigint;
  memberships: bigint;
  snapshots: bigint;
  sources: bigint;
  v1Documents: bigint;
  v1GenerationCandidates: bigint;
  v1Versions: bigint;
}>;

export type KnowledgeV1ReconciliationReport = Readonly<{
  discrepancies: number;
  invalidArtifactMappings: number;
  invalidDocumentMappings: number;
  invalidVersionMappings: number;
  mappedDocuments: number;
  mappedGenerationCandidates: number;
  mappedVersions: number;
  memberships: number;
  snapshots: number;
  sources: number;
  v1Documents: number;
  v1GenerationCandidates: number;
  v1Versions: number;
}>;

export type KnowledgeV1BackfillResult = Readonly<{
  processedDocuments: number;
  remainingDocuments: number;
  skippedProfilelessCandidates: number;
}>;

export type KnowledgeBackfillSnapshotResult = Readonly<{
  materializedBases: number;
  readySources: number;
  sources: number;
}>;

export type KnowledgeBaseSnapshotEvidence = Readonly<{
  evidenceFingerprint: string;
  readySourceCount: number;
  snapshotId: string;
  sourceCount: number;
  sourceRevision: number;
}>;

export class KnowledgeSourceSnapshotConflictError extends Error {
  constructor() {
    super("knowledge_source_snapshot_conflict");
    this.name = "KnowledgeSourceSnapshotConflictError";
  }
}

function sha256(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256(...parts).slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function integer(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error("knowledge_reconciliation_count_overflow");
  return converted;
}

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" ||
      (error.code === "P2010" &&
        typeof error.meta === "object" &&
        error.meta !== null &&
        "code" in error.meta &&
        error.meta.code === "40001"));
}

async function reconcileDocumentWithRetry(
  client: PrismaClient,
  document: Readonly<{ documentId: string; knowledgeBaseId: string }>
): Promise<Readonly<{ skippedProfilelessCandidates: number }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(
        (tx) => reconcileV1KnowledgeDocument(tx, document),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (attempt < 2 && serializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("knowledge_source_backfill_retry_exhausted");
}

export function knowledgeV1SourceId(documentId: string): string {
  return deterministicId("ks_v1", documentId);
}

export function knowledgeV1SourceVersionId(documentVersionId: string): string {
  return deterministicId("ksv_v1", documentVersionId);
}

function artifactId(documentVersionId: string, profileRevisionId: string): string {
  return deterministicId("ksa_v1", documentVersionId, profileRevisionId);
}

function snapshotId(knowledgeBaseId: string, evidenceFingerprint: string): string {
  return deterministicId("kbs", knowledgeBaseId, evidenceFingerprint);
}

function stableErrorCode(value: string | null, fallback: string): string {
  const normalized = value?.trim();
  return (normalized || fallback).slice(0, 64);
}

function textArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`ARRAY[]::text[]`
    : Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;
}

function pendingVersion(
  versions: readonly V1VersionRow[],
  currentVersionId: string | null
): V1VersionRow | undefined {
  const currentVersionNumber = versions.find(
    (version) => version.documentVersionId === currentVersionId
  )?.versionNumber;
  return [...versions]
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .find((version) =>
      currentVersionNumber === undefined
        ? version.documentVersionId !== currentVersionId
        : version.versionNumber > currentVersionNumber
    );
}

function preferredCandidate(
  candidates: readonly V1GenerationCandidateRow[]
): V1GenerationCandidateRow {
  const score = (candidate: V1GenerationCandidateRow): number => {
    if (
      candidate.candidateState === "ready" &&
      candidate.normalizedTextStorageKey !== null &&
      candidate.normalizedTextByteSize !== null &&
      candidate.normalizedTextChecksum !== null &&
      candidate.candidateChunkCount !== null
    ) return 4;
    if (["parsing", "chunking", "embedding"].includes(candidate.candidateState)) return 3;
    if (candidate.candidateState === "queued") return 2;
    return 1;
  };
  return [...candidates].sort((left, right) => {
    const scoreDifference = score(right) - score(left);
    if (scoreDifference !== 0) return scoreDifference;
    const timeDifference = right.candidateUpdatedAt.getTime() - left.candidateUpdatedAt.getTime();
    return timeDifference || left.indexGenerationId.localeCompare(right.indexGenerationId);
  })[0]!;
}

function artifactState(candidate: V1GenerationCandidateRow): Readonly<{
  errorCode: string | null;
  processingStage: "chunking" | "queued" | null;
  readyAt: Date | null;
  state: "failed" | "pending" | "processing" | "ready";
}> {
  if (candidate.candidateState === "ready") {
    const complete = candidate.normalizedTextStorageKey !== null &&
      candidate.normalizedTextByteSize !== null &&
      candidate.normalizedTextChecksum !== null &&
      candidate.candidateChunkCount !== null;
    return complete
      ? {
          errorCode: null,
          processingStage: "chunking",
          readyAt: null,
          state: "processing"
        }
      : {
          errorCode: "legacy_ready_payload_unavailable",
          processingStage: null,
          readyAt: null,
          state: "failed"
        };
  }
  if (["parsing", "chunking", "embedding"].includes(candidate.candidateState)) {
    const normalizedAvailable = candidate.normalizedTextStorageKey !== null &&
      candidate.normalizedTextByteSize !== null && candidate.normalizedTextChecksum !== null;
    return {
      errorCode: null,
      processingStage: normalizedAvailable ? "chunking" : "queued",
      readyAt: null,
      state: "processing"
    };
  }
  if (candidate.candidateState === "queued") {
    return { errorCode: null, processingStage: "queued", readyAt: null, state: "pending" };
  }
  return {
    errorCode: stableErrorCode(candidate.candidateErrorCode, "legacy_processing_failed"),
    processingStage: null,
    readyAt: null,
    state: "failed"
  };
}

async function loadV1Document(
  tx: RawKnowledgeClient,
  input: Readonly<{ documentId: string; knowledgeBaseId: string }>
): Promise<{ document: V1DocumentRow; versions: V1VersionRow[] }> {
  const documents = await tx.$queryRaw<V1DocumentRow[]>(Prisma.sql`
    SELECT
      document."id" AS "documentId",
      document."knowledgeBaseId",
      document."currentVersionId",
      document."archivedAt",
      document."updatedAt",
      base."ownerUserId"
    FROM "KnowledgeDocument" AS document
    INNER JOIN "KnowledgeBase" AS base
      ON base."id" = document."knowledgeBaseId"
    WHERE document."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND document."id" = ${input.documentId}
    FOR UPDATE OF document, base
  `);
  const document = documents[0];
  if (!document) throw new KnowledgeSourceSnapshotConflictError();
  const versions = await tx.$queryRaw<V1VersionRow[]>(Prisma.sql`
    SELECT
      version."id" AS "documentVersionId",
      version."versionNumber",
      version."fileName",
      version."mimeType",
      version."byteSize",
      btrim(version."checksum") AS "checksum",
      version."originalStorageKey",
      version."normalizedTextStorageKey",
      version."normalizedTextByteSize",
      CASE
        WHEN version."normalizedTextChecksum" IS NULL THEN NULL
        ELSE btrim(version."normalizedTextChecksum")
      END AS "normalizedTextChecksum",
      version."pageCount",
      version."ingestState"::text AS "ingestState",
      version."ingestWarningCodes",
      version."createdAt",
      version."updatedAt"
    FROM "KnowledgeDocumentVersion" AS version
    WHERE version."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND version."documentId" = ${input.documentId}
    ORDER BY version."versionNumber", version."id"
    FOR SHARE OF version
  `);
  return { document, versions };
}

async function loadV1GenerationCandidates(
  tx: RawKnowledgeClient,
  input: Readonly<{ documentId: string; knowledgeBaseId: string }>
): Promise<V1GenerationCandidateRow[]> {
  return tx.$queryRaw<V1GenerationCandidateRow[]>(Prisma.sql`
    WITH candidates AS (
      SELECT
        version."id" AS "documentVersionId",
        version."ingestGenerationId" AS "indexGenerationId",
        version."ingestState" AS "candidateState",
        version."ingestErrorCode" AS "candidateErrorCode",
        version."ingestChunkCount" AS "candidateChunkCount",
        version."updatedAt" AS "candidateUpdatedAt",
        0 AS precedence
      FROM "KnowledgeDocumentVersion" AS version
      WHERE version."knowledgeBaseId" = ${input.knowledgeBaseId}
        AND version."documentId" = ${input.documentId}
        AND version."ingestGenerationId" IS NOT NULL
      UNION ALL
      SELECT
        version."id",
        work."indexGenerationId",
        work."state",
        work."errorCode",
        work."chunkCount",
        work."updatedAt",
        1
      FROM "KnowledgeDocumentVersion" AS version
      INNER JOIN "KnowledgeGenerationDocument" AS work
        ON work."knowledgeBaseId" = version."knowledgeBaseId"
       AND work."documentVersionId" = version."id"
      WHERE version."knowledgeBaseId" = ${input.knowledgeBaseId}
        AND version."documentId" = ${input.documentId}
    ), distinct_candidates AS (
      SELECT DISTINCT ON (candidate."documentVersionId", candidate."indexGenerationId")
        candidate.*
      FROM candidates AS candidate
      ORDER BY
        candidate."documentVersionId",
        candidate."indexGenerationId",
        candidate.precedence DESC,
        candidate."candidateUpdatedAt" DESC
    )
    SELECT
      candidate."documentVersionId",
      candidate."indexGenerationId",
      generation."knowledgeBaseId",
      generation."profileRevisionId",
      candidate."candidateState"::text AS "candidateState",
      candidate."candidateErrorCode",
      candidate."candidateChunkCount",
      candidate."candidateUpdatedAt",
      version."versionNumber",
      version."fileName",
      version."mimeType",
      version."byteSize",
      btrim(version."checksum") AS "checksum",
      version."originalStorageKey",
      version."normalizedTextStorageKey",
      version."normalizedTextByteSize",
      CASE
        WHEN version."normalizedTextChecksum" IS NULL THEN NULL
        ELSE btrim(version."normalizedTextChecksum")
      END AS "normalizedTextChecksum",
      version."pageCount",
      version."ingestState"::text AS "ingestState",
      version."ingestWarningCodes",
      version."createdAt",
      version."updatedAt"
    FROM distinct_candidates AS candidate
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = ${input.knowledgeBaseId}
     AND generation."id" = candidate."indexGenerationId"
    INNER JOIN "KnowledgeDocumentVersion" AS version
      ON version."knowledgeBaseId" = ${input.knowledgeBaseId}
     AND version."id" = candidate."documentVersionId"
    ORDER BY
      candidate."documentVersionId",
      generation."profileRevisionId" NULLS LAST,
      candidate."indexGenerationId"
    FOR SHARE OF generation, version
  `);
}

async function persistV1SourceIdentity(
  tx: RawKnowledgeClient,
  document: V1DocumentRow,
  versions: readonly V1VersionRow[]
): Promise<void> {
  const canonicalSourceId = knowledgeV1SourceId(document.documentId);
  const current = versions.find(
    (version) => version.documentVersionId === document.currentVersionId
  );
  const fallback = [...versions].sort((left, right) =>
    right.versionNumber - left.versionNumber)[0];
  const name = current?.fileName ?? fallback?.fileName ?? "Imported source";
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeSource" (
      "id", "ownerUserId", "name", "description", "tags",
      "currentVersionId", "pendingVersionId", "version", "createdAt", "updatedAt"
    ) VALUES (
      ${canonicalSourceId}, ${document.ownerUserId}, ${name}, '', ARRAY[]::TEXT[],
      NULL, NULL, 1, ${document.updatedAt}, ${document.updatedAt}
    )
    ON CONFLICT ("id") DO NOTHING
  `);

  for (const version of versions) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeSourceVersion" (
        "id", "sourceId", "ownerUserId", "versionNumber", "fileName", "mimeType",
        "byteSize", "checksum", "originalStorageKey", "createdAt"
      ) VALUES (
        ${knowledgeV1SourceVersionId(version.documentVersionId)},
        ${canonicalSourceId},
        ${document.ownerUserId},
        ${version.versionNumber},
        ${version.fileName},
        ${version.mimeType},
        ${version.byteSize},
        ${version.checksum},
        ${version.originalStorageKey},
        ${version.createdAt}
      )
      ON CONFLICT ("id") DO NOTHING
    `);
  }

  const pending = pendingVersion(versions, document.currentVersionId);
  const canonicalCurrentVersionId = current
    ? knowledgeV1SourceVersionId(current.documentVersionId)
    : null;
  const canonicalPendingVersionId = pending
    ? knowledgeV1SourceVersionId(pending.documentVersionId)
    : null;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "KnowledgeSource"
    SET
      "currentVersionId" = ${canonicalCurrentVersionId},
      "pendingVersionId" = ${canonicalPendingVersionId},
      "version" = "version" + 1,
      "updatedAt" = GREATEST("updatedAt", ${document.updatedAt})
    WHERE "id" = ${canonicalSourceId}
      AND "ownerUserId" = ${document.ownerUserId}
      AND (
        "currentVersionId" IS DISTINCT FROM ${canonicalCurrentVersionId} OR
        "pendingVersionId" IS DISTINCT FROM ${canonicalPendingVersionId}
      )
  `);

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeBaseSource" (
      "knowledgeBaseId", "sourceId", "ownerUserId", "removedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${document.knowledgeBaseId}, ${canonicalSourceId}, ${document.ownerUserId},
      ${document.archivedAt}, ${document.updatedAt}, ${document.updatedAt}
    )
    ON CONFLICT ("knowledgeBaseId", "sourceId") DO NOTHING
  `);

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeV1DocumentSourceMap" (
      "knowledgeBaseId", "documentId", "sourceId", "ownerUserId", "createdAt"
    ) VALUES (
      ${document.knowledgeBaseId}, ${document.documentId}, ${canonicalSourceId},
      ${document.ownerUserId}, ${document.updatedAt}
    )
    ON CONFLICT ("knowledgeBaseId", "documentId") DO NOTHING
  `);
  for (const version of versions) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeV1DocumentVersionSourceMap" (
        "knowledgeBaseId", "documentId", "documentVersionId", "sourceId",
        "sourceVersionId", "ownerUserId", "createdAt"
      ) VALUES (
        ${document.knowledgeBaseId}, ${document.documentId}, ${version.documentVersionId},
        ${canonicalSourceId}, ${knowledgeV1SourceVersionId(version.documentVersionId)},
        ${document.ownerUserId}, ${version.createdAt}
      )
      ON CONFLICT ("knowledgeBaseId", "documentVersionId") DO NOTHING
    `);
  }
}

async function persistV1Artifacts(
  tx: RawKnowledgeClient,
  candidates: readonly V1GenerationCandidateRow[]
): Promise<number> {
  const profileless = candidates.filter((candidate) => candidate.profileRevisionId === null).length;
  const profiled = candidates.filter(
    (candidate): candidate is V1GenerationCandidateRow & { profileRevisionId: string } =>
      candidate.profileRevisionId !== null
  );
  const groups = new Map<string, Array<V1GenerationCandidateRow & { profileRevisionId: string }>>();
  for (const candidate of profiled) {
    const key = `${candidate.documentVersionId}\0${candidate.profileRevisionId}`;
    const existing = groups.get(key) ?? [];
    existing.push(candidate);
    groups.set(key, existing);
  }

  for (const grouped of groups.values()) {
    const candidate = preferredCandidate(grouped);
    const profileRevisionId = candidate.profileRevisionId!;
    const latestCandidateUpdatedAt = grouped.reduce(
      (latest, current) => current.candidateUpdatedAt > latest
        ? current.candidateUpdatedAt
        : latest,
      candidate.candidateUpdatedAt
    );
    const canonicalArtifactId = artifactId(candidate.documentVersionId, profileRevisionId);
    const state = artifactState(candidate);
    const canonicalSourceVersionId = knowledgeV1SourceVersionId(candidate.documentVersionId);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "KnowledgeSourceIndexArtifact" (
        "id", "sourceVersionId", "profileRevisionId", "state", "processingStage",
        "normalizedTextStorageKey", "normalizedTextByteSize", "normalizedTextChecksum",
        "pageCount", "chunkCount", "warningCodes", "errorCode", "readyAt", "createdAt", "updatedAt"
      ) VALUES (
        ${canonicalArtifactId}, ${canonicalSourceVersionId}, ${profileRevisionId},
        ${state.state}::"KnowledgeSourceArtifactState",
        ${state.processingStage}::"KnowledgeSourceArtifactProcessingStage",
        ${candidate.normalizedTextStorageKey}, ${candidate.normalizedTextByteSize},
        ${candidate.normalizedTextChecksum}, ${candidate.pageCount},
        ${candidate.candidateChunkCount}, ${textArray(candidate.ingestWarningCodes)},
        ${state.errorCode}, ${state.readyAt},
        ${candidate.createdAt}, ${latestCandidateUpdatedAt}
      )
      ON CONFLICT ("sourceVersionId", "profileRevisionId") DO NOTHING
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "KnowledgeSourceIndexArtifact"
      SET
        "state" = ${state.state}::"KnowledgeSourceArtifactState",
        "processingStage" = ${state.processingStage}::"KnowledgeSourceArtifactProcessingStage",
        "normalizedTextStorageKey" = ${candidate.normalizedTextStorageKey},
        "normalizedTextByteSize" = ${candidate.normalizedTextByteSize},
        "normalizedTextChecksum" = ${candidate.normalizedTextChecksum},
        "pageCount" = ${candidate.pageCount},
        "chunkCount" = ${candidate.candidateChunkCount},
        "warningCodes" = ${textArray(candidate.ingestWarningCodes)},
        "errorCode" = ${state.errorCode},
        "readyAt" = ${state.readyAt},
        "updatedAt" = ${latestCandidateUpdatedAt}
      WHERE "sourceVersionId" = ${canonicalSourceVersionId}
        AND "profileRevisionId" = ${profileRevisionId}
        AND "state" <> 'ready'
    `);
    for (const mapping of grouped) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "KnowledgeV1GenerationArtifactMap" (
          "knowledgeBaseId", "indexGenerationId", "documentVersionId",
          "sourceVersionId", "artifactId", "createdAt"
        ) VALUES (
          ${mapping.knowledgeBaseId}, ${mapping.indexGenerationId},
          ${mapping.documentVersionId}, ${canonicalSourceVersionId},
          ${canonicalArtifactId}, ${mapping.candidateUpdatedAt}
        )
        ON CONFLICT ("indexGenerationId", "documentVersionId") DO NOTHING
      `);
    }
  }
  return profileless;
}

export async function reconcileV1KnowledgeDocument(
  tx: RawKnowledgeClient,
  input: Readonly<{ documentId: string; knowledgeBaseId: string }>
): Promise<Readonly<{ skippedProfilelessCandidates: number }>> {
  const { document, versions } = await loadV1Document(tx, input);
  await persistV1SourceIdentity(tx, document, versions);
  const candidates = await loadV1GenerationCandidates(tx, input);
  return {
    skippedProfilelessCandidates: await persistV1Artifacts(tx, candidates)
  };
}

async function documentsNeedingBackfill(
  client: RawKnowledgeClient,
  knowledgeBaseId?: string,
  limit?: number
): Promise<Array<{ documentId: string; knowledgeBaseId: string }>> {
  const limitSql = limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`;
  const baseFilter = knowledgeBaseId === undefined
    ? Prisma.empty
    : Prisma.sql`AND document."knowledgeBaseId" = ${knowledgeBaseId}`;
  return client.$queryRaw<Array<{ documentId: string; knowledgeBaseId: string }>>(Prisma.sql`
    SELECT
      document."id" AS "documentId",
      document."knowledgeBaseId"
    FROM "KnowledgeDocument" AS document
    LEFT JOIN "KnowledgeV1DocumentSourceMap" AS document_map
      ON document_map."knowledgeBaseId" = document."knowledgeBaseId"
     AND document_map."documentId" = document."id"
    LEFT JOIN "KnowledgeSource" AS source
      ON source."id" = document_map."sourceId"
    LEFT JOIN "KnowledgeV1DocumentVersionSourceMap" AS current_version_map
      ON current_version_map."knowledgeBaseId" = document."knowledgeBaseId"
     AND current_version_map."documentVersionId" = document."currentVersionId"
    WHERE (
      document_map."documentId" IS NULL
      OR source."currentVersionId" IS DISTINCT FROM current_version_map."sourceVersionId"
      OR EXISTS (
        SELECT 1
        FROM "KnowledgeDocumentVersion" AS version
        LEFT JOIN "KnowledgeV1DocumentVersionSourceMap" AS version_map
          ON version_map."knowledgeBaseId" = version."knowledgeBaseId"
         AND version_map."documentVersionId" = version."id"
        WHERE version."knowledgeBaseId" = document."knowledgeBaseId"
          AND version."documentId" = document."id"
          AND version_map."documentVersionId" IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT version."id" AS "documentVersionId", version."ingestGenerationId" AS "indexGenerationId"
          FROM "KnowledgeDocumentVersion" AS version
          WHERE version."knowledgeBaseId" = document."knowledgeBaseId"
            AND version."documentId" = document."id"
            AND version."ingestGenerationId" IS NOT NULL
          UNION
          SELECT version."id", work."indexGenerationId"
          FROM "KnowledgeDocumentVersion" AS version
          INNER JOIN "KnowledgeGenerationDocument" AS work
            ON work."knowledgeBaseId" = version."knowledgeBaseId"
           AND work."documentVersionId" = version."id"
          WHERE version."knowledgeBaseId" = document."knowledgeBaseId"
            AND version."documentId" = document."id"
        ) AS candidate
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = document."knowledgeBaseId"
         AND generation."id" = candidate."indexGenerationId"
         AND generation."profileRevisionId" IS NOT NULL
        LEFT JOIN "KnowledgeV1GenerationArtifactMap" AS artifact_map
          ON artifact_map."indexGenerationId" = candidate."indexGenerationId"
         AND artifact_map."documentVersionId" = candidate."documentVersionId"
        WHERE artifact_map."indexGenerationId" IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT ON (raw_candidate."documentVersionId", raw_candidate."indexGenerationId")
            raw_candidate."documentVersionId",
            raw_candidate."indexGenerationId",
            raw_candidate."candidateUpdatedAt"
          FROM (
            SELECT
              version."id" AS "documentVersionId",
              version."ingestGenerationId" AS "indexGenerationId",
              version."updatedAt" AS "candidateUpdatedAt",
              0 AS precedence
            FROM "KnowledgeDocumentVersion" AS version
            WHERE version."knowledgeBaseId" = document."knowledgeBaseId"
              AND version."documentId" = document."id"
              AND version."ingestGenerationId" IS NOT NULL
            UNION ALL
            SELECT
              version."id",
              work."indexGenerationId",
              work."updatedAt",
              1
            FROM "KnowledgeDocumentVersion" AS version
            INNER JOIN "KnowledgeGenerationDocument" AS work
              ON work."knowledgeBaseId" = version."knowledgeBaseId"
             AND work."documentVersionId" = version."id"
            WHERE version."knowledgeBaseId" = document."knowledgeBaseId"
              AND version."documentId" = document."id"
          ) AS raw_candidate
          ORDER BY
            raw_candidate."documentVersionId",
            raw_candidate."indexGenerationId",
            raw_candidate.precedence DESC,
            raw_candidate."candidateUpdatedAt" DESC
        ) AS candidate
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = document."knowledgeBaseId"
         AND generation."id" = candidate."indexGenerationId"
         AND generation."profileRevisionId" IS NOT NULL
        INNER JOIN "KnowledgeV1GenerationArtifactMap" AS artifact_map
          ON artifact_map."indexGenerationId" = candidate."indexGenerationId"
         AND artifact_map."documentVersionId" = candidate."documentVersionId"
        INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
          ON artifact."id" = artifact_map."artifactId"
         AND artifact."state" <> 'ready'
        WHERE artifact."updatedAt" < candidate."candidateUpdatedAt"
      )
    )
    ${baseFilter}
    ORDER BY document."knowledgeBaseId", document."createdAt", document."id"
    ${limitSql}
  `);
}

export async function backfillV1KnowledgeSources(
  input: Readonly<{ knowledgeBaseId?: string; limit?: number }> = {},
  client: PrismaClient = prisma
): Promise<KnowledgeV1BackfillResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("knowledge_source_backfill_limit_invalid");
  }
  if (input.knowledgeBaseId !== undefined && input.knowledgeBaseId.trim() === "") {
    throw new TypeError("knowledge_source_backfill_base_invalid");
  }
  const documents = await documentsNeedingBackfill(
    client,
    input.knowledgeBaseId,
    limit
  );
  let skippedProfilelessCandidates = 0;
  for (const document of documents) {
    const result = await reconcileDocumentWithRetry(client, document);
    skippedProfilelessCandidates += result.skippedProfilelessCandidates;
  }
  const remaining = await documentsNeedingBackfill(client, input.knowledgeBaseId);
  return {
    processedDocuments: documents.length,
    remainingDocuments: remaining.length,
    skippedProfilelessCandidates
  };
}

export async function reconcileKnowledgeSourcePersistence(
  client: Pick<PrismaClient, "$queryRaw"> = prisma
): Promise<KnowledgeV1ReconciliationReport> {
  const rows = await client.$queryRaw<AggregateCountRow[]>(Prisma.sql`
    SELECT
      (SELECT count(*) FROM "KnowledgeDocument") AS "v1Documents",
      (SELECT count(*) FROM "KnowledgeV1DocumentSourceMap") AS "mappedDocuments",
      (SELECT count(*) FROM "KnowledgeDocumentVersion") AS "v1Versions",
      (SELECT count(*) FROM "KnowledgeV1DocumentVersionSourceMap") AS "mappedVersions",
      (
        SELECT count(*)
        FROM (
          SELECT version."knowledgeBaseId", version."id", version."ingestGenerationId"
          FROM "KnowledgeDocumentVersion" AS version
          WHERE version."ingestGenerationId" IS NOT NULL
          UNION
          SELECT work."knowledgeBaseId", work."documentVersionId", work."indexGenerationId"
          FROM "KnowledgeGenerationDocument" AS work
        ) AS candidate
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."knowledgeBaseId" = candidate."knowledgeBaseId"
         AND generation."id" = candidate."ingestGenerationId"
        WHERE generation."profileRevisionId" IS NOT NULL
      ) AS "v1GenerationCandidates",
      (SELECT count(*) FROM "KnowledgeV1GenerationArtifactMap") AS "mappedGenerationCandidates",
      (
        SELECT count(*)
        FROM "KnowledgeV1DocumentSourceMap" AS document_map
        INNER JOIN "KnowledgeBase" AS base
          ON base."id" = document_map."knowledgeBaseId"
        INNER JOIN "KnowledgeSource" AS source
          ON source."id" = document_map."sourceId"
        INNER JOIN "KnowledgeBaseSource" AS membership
          ON membership."knowledgeBaseId" = document_map."knowledgeBaseId"
         AND membership."sourceId" = document_map."sourceId"
        WHERE document_map."ownerUserId" <> base."ownerUserId"
          OR document_map."ownerUserId" <> source."ownerUserId"
          OR document_map."ownerUserId" <> membership."ownerUserId"
      ) AS "invalidDocumentMappings",
      (
        SELECT count(*)
        FROM "KnowledgeV1DocumentVersionSourceMap" AS version_map
        INNER JOIN "KnowledgeDocumentVersion" AS version
          ON version."knowledgeBaseId" = version_map."knowledgeBaseId"
         AND version."id" = version_map."documentVersionId"
        INNER JOIN "KnowledgeV1DocumentSourceMap" AS document_map
          ON document_map."knowledgeBaseId" = version_map."knowledgeBaseId"
         AND document_map."documentId" = version_map."documentId"
        INNER JOIN "KnowledgeSourceVersion" AS source_version
          ON source_version."id" = version_map."sourceVersionId"
        WHERE version."documentId" <> version_map."documentId"
          OR version_map."sourceId" <> document_map."sourceId"
          OR version_map."ownerUserId" <> document_map."ownerUserId"
          OR source_version."sourceId" <> version_map."sourceId"
          OR source_version."ownerUserId" <> version_map."ownerUserId"
      ) AS "invalidVersionMappings",
      (
        SELECT count(*)
        FROM "KnowledgeV1GenerationArtifactMap" AS artifact_map
        INNER JOIN "KnowledgeIndexGeneration" AS generation
          ON generation."id" = artifact_map."indexGenerationId"
        INNER JOIN "KnowledgeV1DocumentVersionSourceMap" AS version_map
          ON version_map."knowledgeBaseId" = artifact_map."knowledgeBaseId"
         AND version_map."documentVersionId" = artifact_map."documentVersionId"
        INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
          ON artifact."id" = artifact_map."artifactId"
        WHERE artifact_map."knowledgeBaseId" <> generation."knowledgeBaseId"
          OR artifact_map."sourceVersionId" <> version_map."sourceVersionId"
          OR artifact."sourceVersionId" <> artifact_map."sourceVersionId"
          OR artifact."profileRevisionId" IS DISTINCT FROM generation."profileRevisionId"
      ) AS "invalidArtifactMappings",
      (SELECT count(*) FROM "KnowledgeSource") AS "sources",
      (SELECT count(*) FROM "KnowledgeBaseSource") AS "memberships",
      (SELECT count(*) FROM "KnowledgeBaseSnapshot") AS "snapshots"
  `);
  const row = rows[0];
  if (!row) throw new Error("knowledge_source_reconciliation_unavailable");
  const report = {
    invalidArtifactMappings: integer(row.invalidArtifactMappings),
    invalidDocumentMappings: integer(row.invalidDocumentMappings),
    invalidVersionMappings: integer(row.invalidVersionMappings),
    mappedDocuments: integer(row.mappedDocuments),
    mappedGenerationCandidates: integer(row.mappedGenerationCandidates),
    mappedVersions: integer(row.mappedVersions),
    memberships: integer(row.memberships),
    snapshots: integer(row.snapshots),
    sources: integer(row.sources),
    v1Documents: integer(row.v1Documents),
    v1GenerationCandidates: integer(row.v1GenerationCandidates),
    v1Versions: integer(row.v1Versions)
  };
  return {
    ...report,
    discrepancies:
      Math.abs(report.v1Documents - report.mappedDocuments) +
      Math.abs(report.v1Versions - report.mappedVersions) +
      Math.abs(report.v1GenerationCandidates - report.mappedGenerationCandidates) +
      report.invalidDocumentMappings + report.invalidVersionMappings +
      report.invalidArtifactMappings
  };
}

export async function materializeKnowledgeBackfillSnapshots(
  client: PrismaClient = prisma
): Promise<KnowledgeBackfillSnapshotResult> {
  const candidates = await client.$queryRaw<Array<{
    indexGenerationId: string;
    knowledgeBaseId: string;
  }>>(Prisma.sql`
    SELECT
      base."activeIndexGenerationId" AS "indexGenerationId",
      base."id" AS "knowledgeBaseId"
    FROM "KnowledgeBase" AS base
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND generation."id" = base."activeIndexGenerationId"
     AND generation."status" = 'active'
     AND generation."profileRevisionId" IS NOT NULL
    WHERE base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
    ORDER BY base."id"
  `);
  let readySources = 0;
  let sources = 0;
  for (const candidate of candidates) {
    let evidence: KnowledgeBaseSnapshotEvidence | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        evidence = await client.$transaction(
          (tx) => materializeKnowledgeBaseSnapshot(tx, candidate),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        break;
      } catch (error) {
        if (attempt < 2 && serializationConflict(error)) continue;
        throw error;
      }
    }
    if (!evidence) throw new Error("knowledge_snapshot_backfill_retry_exhausted");
    readySources += evidence.readySourceCount;
    sources += evidence.sourceCount;
  }
  return { materializedBases: candidates.length, readySources, sources };
}

export async function materializeKnowledgeBaseSnapshot(
  tx: RawKnowledgeClient,
  input: Readonly<{ indexGenerationId: string; knowledgeBaseId: string }>
): Promise<KnowledgeBaseSnapshotEvidence> {
  const bases = await tx.$queryRaw<SnapshotBaseRow[]>(Prisma.sql`
    SELECT
      base."ownerUserId",
      base."sourceRevision",
      generation."profileRevisionId"
    FROM "KnowledgeBase" AS base
    INNER JOIN "KnowledgeIndexGeneration" AS generation
      ON generation."knowledgeBaseId" = base."id"
     AND generation."id" = ${input.indexGenerationId}
     AND generation."id" = base."activeIndexGenerationId"
     AND generation."status" = 'active'
    WHERE base."id" = ${input.knowledgeBaseId}
      AND base."archivedAt" IS NULL
      AND base."trashedAt" IS NULL
      AND base."deletionRequestedAt" IS NULL
      AND generation."profileRevisionId" IS NOT NULL
    FOR SHARE OF base, generation
  `);
  const base = bases[0];
  if (!base) throw new KnowledgeSourceSnapshotConflictError();
  const memberships = await tx.$queryRaw<SnapshotMembershipRow[]>(Prisma.sql`
    SELECT
      membership."sourceId",
      membership."ownerUserId",
      source."currentVersionId",
      artifact."id" AS "artifactId"
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = membership."sourceId"
     AND source."ownerUserId" = membership."ownerUserId"
     AND source."trashedAt" IS NULL
     AND source."deletionRequestedAt" IS NULL
    LEFT JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."sourceVersionId" = source."currentVersionId"
     AND artifact."profileRevisionId" = ${base.profileRevisionId}
     AND artifact."state" = 'ready'
    WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND membership."removedAt" IS NULL
    ORDER BY membership."sourceId"
    FOR SHARE OF membership, source
  `);
  const readySources = memberships.flatMap((membership) => {
    const versionId = membership.currentVersionId;
    const readyArtifactId = membership.artifactId;
    return versionId && readyArtifactId
      ? [{
          artifactId: readyArtifactId,
          ownerUserId: membership.ownerUserId,
          sourceId: membership.sourceId,
          sourceVersionId: versionId
        }]
      : [];
  });
  const evidence = {
    indexGenerationId: input.indexGenerationId,
    knowledgeBaseId: input.knowledgeBaseId,
    profileRevisionId: base.profileRevisionId,
    sourceRevision: base.sourceRevision,
    sources: memberships.map((membership) => ({
      artifactId: membership.currentVersionId
        ? membership.artifactId
        : null,
      sourceId: membership.sourceId,
      sourceVersionId: membership.currentVersionId
    })),
    version: 1
  };
  const evidenceFingerprint = sha256(canonicalJson(evidence));
  const canonicalSnapshotId = snapshotId(input.knowledgeBaseId, evidenceFingerprint);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeBaseSnapshot" (
      "id", "knowledgeBaseId", "ownerUserId", "profileRevisionId",
      "indexGenerationId", "sourceRevision", "sourceCount", "readySourceCount",
      "evidenceFingerprint", "createdAt"
    ) VALUES (
      ${canonicalSnapshotId}, ${input.knowledgeBaseId}, ${base.ownerUserId},
      ${base.profileRevisionId}, ${input.indexGenerationId}, ${base.sourceRevision},
      ${memberships.length}, ${readySources.length}, ${evidenceFingerprint}, CURRENT_TIMESTAMP
    )
    ON CONFLICT DO NOTHING
  `);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "KnowledgeBaseSnapshotSource" (
      "snapshotId", "knowledgeBaseId", "ownerUserId", "sourceId",
      "sourceVersionId", "artifactId", "ordinal", "createdAt"
    )
    SELECT
      ${canonicalSnapshotId}, ${input.knowledgeBaseId}, membership."ownerUserId",
      membership."sourceId", source."currentVersionId", artifact."id",
      (row_number() OVER (ORDER BY membership."sourceId") - 1)::integer,
      CURRENT_TIMESTAMP
    FROM "KnowledgeBaseSource" AS membership
    INNER JOIN "KnowledgeSource" AS source
      ON source."id" = membership."sourceId"
     AND source."ownerUserId" = membership."ownerUserId"
     AND source."trashedAt" IS NULL
     AND source."deletionRequestedAt" IS NULL
    INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
      ON artifact."sourceVersionId" = source."currentVersionId"
     AND artifact."profileRevisionId" = ${base.profileRevisionId}
     AND artifact."state" = 'ready'
    WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
      AND membership."removedAt" IS NULL
    ON CONFLICT ("snapshotId", "sourceId") DO NOTHING
  `);
  const snapshotSources = await tx.$queryRaw<Array<{
    exactCount: number;
    totalCount: number;
  }>>(Prisma.sql`
    WITH expected AS (
      SELECT
        membership."ownerUserId",
        membership."sourceId",
        source."currentVersionId" AS "sourceVersionId",
        artifact."id" AS "artifactId",
        (row_number() OVER (ORDER BY membership."sourceId") - 1)::integer AS ordinal
      FROM "KnowledgeBaseSource" AS membership
      INNER JOIN "KnowledgeSource" AS source
        ON source."id" = membership."sourceId"
       AND source."ownerUserId" = membership."ownerUserId"
       AND source."trashedAt" IS NULL
       AND source."deletionRequestedAt" IS NULL
      INNER JOIN "KnowledgeSourceIndexArtifact" AS artifact
        ON artifact."sourceVersionId" = source."currentVersionId"
       AND artifact."profileRevisionId" = ${base.profileRevisionId}
       AND artifact."state" = 'ready'
      WHERE membership."knowledgeBaseId" = ${input.knowledgeBaseId}
        AND membership."removedAt" IS NULL
    )
    SELECT
      (SELECT count(*)::integer
       FROM "KnowledgeBaseSnapshotSource"
       WHERE "snapshotId" = ${canonicalSnapshotId}) AS "totalCount",
      (SELECT count(*)::integer
       FROM expected
       INNER JOIN "KnowledgeBaseSnapshotSource" AS snapshot_source
         ON snapshot_source."snapshotId" = ${canonicalSnapshotId}
        AND snapshot_source."knowledgeBaseId" = ${input.knowledgeBaseId}
        AND snapshot_source."ownerUserId" = expected."ownerUserId"
        AND snapshot_source."sourceId" = expected."sourceId"
        AND snapshot_source."sourceVersionId" = expected."sourceVersionId"
        AND snapshot_source."artifactId" = expected."artifactId"
        AND snapshot_source."ordinal" = expected.ordinal) AS "exactCount"
  `);
  if (snapshotSources[0]?.totalCount !== readySources.length ||
    snapshotSources[0]?.exactCount !== readySources.length) {
    throw new KnowledgeSourceSnapshotConflictError();
  }
  const snapshots = await tx.$queryRaw<ExistingSnapshotRow[]>(Prisma.sql`
    SELECT
      btrim("evidenceFingerprint") AS "evidenceFingerprint",
      "sourceRevision",
      "sourceCount",
      "readySourceCount"
    FROM "KnowledgeBaseSnapshot"
    WHERE "id" = ${canonicalSnapshotId}
      AND "knowledgeBaseId" = ${input.knowledgeBaseId}
  `);
  const snapshot = snapshots[0];
  if (
    !snapshot ||
    snapshot.evidenceFingerprint !== evidenceFingerprint ||
    snapshot.sourceRevision !== base.sourceRevision ||
    snapshot.sourceCount !== memberships.length ||
    snapshot.readySourceCount !== readySources.length
  ) {
    throw new KnowledgeSourceSnapshotConflictError();
  }
  return {
    evidenceFingerprint,
    readySourceCount: readySources.length,
    snapshotId: canonicalSnapshotId,
    sourceCount: memberships.length,
    sourceRevision: base.sourceRevision
  };
}
