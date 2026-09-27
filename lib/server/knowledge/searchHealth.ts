import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS } from "./hierarchicalIndex";
import {
  KNOWLEDGE_SEARCH_BACKEND_KIND,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION
} from "../search/opensearch/contract";
import {
  createKnowledgeOpenSearchTransport,
  type AiqsaOpenSearchTransport
} from "../search/opensearch/transport";
import { KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS } from
  "./searchWorkerHeartbeat";

type SearchHealthClient = Pick<PrismaClient, "$queryRaw">;

type SearchHealthRow = Readonly<{
  expectedProjections: number;
  failedBases: number;
  failedProjections: number;
  failedSources: number;
  pendingProjections: number;
  readyProjections: number;
  workerLastSeenAt: Date | null;
}>;

/** Content-free installation aggregate. `failedSources`/`failedBases` count
 * the distinct Sources with a terminal search projection failure and the live
 * Bases containing them, without naming either. */
export type KnowledgeSearchHealth = Readonly<{
  backendState: "available" | "unavailable";
  expectedProjections: number;
  failedBases: number;
  failedProjections: number;
  failedSources: number;
  pendingProjections: number;
  readyProjections: number;
  workerLastSeenAt: string | null;
  workerState: "healthy" | "missing" | "stale";
}>;

function count(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error("knowledge_search_health_count_invalid");
  }
  return normalized;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export async function readKnowledgeSearchHealth(
  client: SearchHealthClient,
  input: Readonly<{
    now?: Date;
    search?: Pick<AiqsaOpenSearchTransport, "checkKnowledgeIndex">;
  }> = {}
): Promise<KnowledgeSearchHealth> {
  const now = input.now ?? new Date();
  if (!validDate(now)) throw new Error("knowledge_search_health_clock_invalid");
  const backendStatePromise = Promise.resolve().then(
    () => (input.search ?? createKnowledgeOpenSearchTransport()).checkKnowledgeIndex()
  ).then(
    () => "available" as const,
    () => "unavailable" as const
  );
  const compatibleVersions = Prisma.sql`ARRAY[${Prisma.join([
    ...KNOWLEDGE_HIERARCHICAL_COMPATIBLE_INDEX_VERSIONS
  ])}]::integer[]`;
  const [rows, backendState] = await Promise.all([
    client.$queryRaw<SearchHealthRow[]>(Prisma.sql`
      WITH expected_hierarchies AS (
        SELECT DISTINCT ON (hierarchy."sourceArtifactId")
          hierarchy.checksum,
          hierarchy.id,
          hierarchy."passageCount",
          source.id AS "sourceId"
        FROM "KnowledgeHierarchicalIndexArtifact" AS hierarchy
        INNER JOIN "KnowledgeSourceIndexArtifact" AS source_artifact
          ON source_artifact.id = hierarchy."sourceArtifactId"
         AND source_artifact."sourceVersionId" = hierarchy."sourceVersionId"
        INNER JOIN "KnowledgeSourceVersion" AS source_version
          ON source_version.id = source_artifact."sourceVersionId"
        INNER JOIN "KnowledgeSource" AS source
          ON source.id = source_version."sourceId"
         AND source."ownerUserId" = source_version."ownerUserId"
        WHERE hierarchy.state = 'ready'::"KnowledgeHierarchicalIndexState"
          AND hierarchy.checksum IS NOT NULL
          AND hierarchy."schemaVersion" = ANY(${compatibleVersions})
          AND source_artifact.state = 'ready'::"KnowledgeSourceArtifactState"
          AND source."deletionRequestedAt" IS NULL
          AND source."trashedAt" IS NULL
        ORDER BY hierarchy."sourceArtifactId", hierarchy."schemaVersion" DESC, hierarchy.id
      ), obligations AS (
        SELECT
          expected.id,
          expected."sourceId",
          projection.state,
          (
            projection."backendKind" = ${KNOWLEDGE_SEARCH_BACKEND_KIND}
            AND projection."mappingVersion" = ${KNOWLEDGE_SEARCH_MAPPING_VERSION}
            AND projection.state = 'READY'::"KnowledgeSearchProjectionState"
            AND projection."expectedPassageCount" = expected."passageCount"
            AND projection."indexedPassageCount" = expected."passageCount"
            AND projection."projectionFingerprint" = encode(sha256(convert_to(concat(
              '{"backend":"', ${KNOWLEDGE_SEARCH_BACKEND_KIND},
              '","hierarchicalChecksum":"', expected.checksum,
              '","indexArtifactId":"', expected.id,
              '","mappingVersion":', ${KNOWLEDGE_SEARCH_MAPPING_VERSION},
              ',"passageCount":', expected."passageCount",
              ',"physicalIndexVersion":', ${KNOWLEDGE_SEARCH_PHYSICAL_INDEX_VERSION},
              ',"version":1}'
            ), 'UTF8')), 'hex')
          ) AS ready
        FROM expected_hierarchies AS expected
        LEFT JOIN "KnowledgeSearchProjection" AS projection
          ON projection."indexArtifactId" = expected.id
      )
      SELECT
        count(*)::integer AS "expectedProjections",
        count(*) FILTER (WHERE state = 'FAILED')::integer AS "failedProjections",
        count(DISTINCT "sourceId") FILTER (WHERE state = 'FAILED')::integer AS "failedSources",
        (
          SELECT count(DISTINCT membership."knowledgeBaseId")::integer
          FROM "KnowledgeBaseSource" AS membership
          INNER JOIN "KnowledgeBase" AS base
            ON base.id = membership."knowledgeBaseId"
           AND base."ownerUserId" = membership."ownerUserId"
          WHERE membership."removedAt" IS NULL
            AND base."deletionRequestedAt" IS NULL
            AND base."trashedAt" IS NULL
            AND membership."sourceId" IN (
              SELECT failed."sourceId" FROM obligations AS failed WHERE failed.state = 'FAILED'
            )
        ) AS "failedBases",
        count(*) FILTER (WHERE NOT COALESCE(ready, false) AND state IS DISTINCT FROM 'FAILED')::integer
          AS "pendingProjections",
        count(*) FILTER (WHERE ready)::integer AS "readyProjections",
        (
          SELECT heartbeat."lastSeenAt"
          FROM "KnowledgeSearchWorkerHeartbeat" AS heartbeat
          WHERE heartbeat.id = 'installation'
        ) AS "workerLastSeenAt"
      FROM obligations
    `),
    backendStatePromise
  ]);
  const row = rows[0];
  if (!row || row.workerLastSeenAt !== null && !validDate(row.workerLastSeenAt)) {
    throw new Error("knowledge_search_health_invalid");
  }
  const expectedProjections = count(row.expectedProjections);
  const failedProjections = count(row.failedProjections);
  const pendingProjections = count(row.pendingProjections);
  const readyProjections = count(row.readyProjections);
  const failedSources = count(row.failedSources);
  const failedBases = count(row.failedBases);
  if (readyProjections + pendingProjections + failedProjections !== expectedProjections ||
    failedSources > failedProjections || (failedSources === 0) !== (failedProjections === 0) ||
    failedSources === 0 && failedBases !== 0) {
    throw new Error("knowledge_search_health_invalid");
  }
  const workerState = row.workerLastSeenAt === null
    ? "missing" as const
    : now.getTime() - row.workerLastSeenAt.getTime() >
        KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS
      ? "stale" as const
      : "healthy" as const;
  return Object.freeze({
    backendState,
    expectedProjections,
    failedBases,
    failedProjections,
    failedSources,
    pendingProjections,
    readyProjections,
    workerLastSeenAt: row.workerLastSeenAt?.toISOString() ?? null,
    workerState
  });
}
