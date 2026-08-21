import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminKnowledgeOperations,
  AdminKnowledgeOperationsAlert
} from "../../../contracts/adminKnowledge";
import { reconcileKnowledgeSourcePersistence } from "../../knowledge/sourcePersistence";

type OperationsClient = Pick<PrismaClient, "$queryRaw">;

type OperationsRow = Readonly<{
  activeUploads: number;
  blockedDeletionJobs: number;
  checkedAt: Date;
  degradedOperations24h: number;
  expiredUploads: number;
  failedArtifacts: number;
  items24h: number;
  needsAttentionUploads: number;
  noAnswerOperations24h: number;
  oldestDeletionSeconds: number | null;
  oldestQueuedSeconds: number | null;
  p50ReadyLatencyMs24h: number | null;
  p50RetrievalDurationMs24h: number | null;
  p95ReadyLatencyMs24h: number | null;
  p95RetrievalDurationMs24h: number | null;
  pendingArtifacts: number;
  pendingDeletionJobs: number;
  pendingDeletionObjects: number;
  processingArtifacts: number;
  readyArtifacts: number;
  retrievalOperations24h: number;
  settledUploads24h: number;
  uploadedBytes24h: bigint;
  warningArtifacts: number;
}>;

const QUEUE_STALLED_WARNING_SECONDS = 15 * 60;
const QUEUE_STALLED_CRITICAL_SECONDS = 60 * 60;
const RETRIEVAL_DEGRADED_MINIMUM_OPERATIONS = 10;
const RETRIEVAL_DEGRADED_WARNING_RATIO = 0.2;

function integer(value: bigint | number, code: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error(code);
  return converted;
}

function nullableRounded(value: number | null, code: string): number | null {
  if (value === null) return null;
  const rounded = Math.round(Number(value));
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error(code);
  return rounded;
}

function alerts(input: Readonly<{
  blockedDeletionJobs: number;
  degradedOperations24h: number;
  discrepancies: number;
  expiredUploads: number;
  failedArtifacts: number;
  oldestQueuedSeconds: number | null;
  pendingDeletionJobs: number;
  retrievalOperations24h: number;
}>): AdminKnowledgeOperationsAlert[] {
  const result: AdminKnowledgeOperationsAlert[] = [];
  if (input.discrepancies > 0) {
    result.push({ code: "knowledge_v1_reconciliation_incomplete", severity: "critical" });
  }
  if (input.blockedDeletionJobs > 0) {
    result.push({ code: "knowledge_deletion_blocked", severity: "critical" });
  }
  if (input.pendingDeletionJobs > 0) {
    result.push({ code: "knowledge_deletion_backlog", severity: "warning" });
  }
  if (input.oldestQueuedSeconds !== null &&
    input.oldestQueuedSeconds >= QUEUE_STALLED_WARNING_SECONDS) {
    result.push({
      code: "knowledge_ingestion_queue_stalled",
      severity: input.oldestQueuedSeconds >= QUEUE_STALLED_CRITICAL_SECONDS
        ? "critical"
        : "warning"
    });
  }
  if (input.failedArtifacts > 0) {
    result.push({ code: "knowledge_ingestion_failures", severity: "warning" });
  }
  if (input.expiredUploads > 0) {
    result.push({ code: "knowledge_upload_sessions_expired", severity: "warning" });
  }
  if (input.retrievalOperations24h >= RETRIEVAL_DEGRADED_MINIMUM_OPERATIONS &&
    input.degradedOperations24h / input.retrievalOperations24h >=
      RETRIEVAL_DEGRADED_WARNING_RATIO) {
    result.push({ code: "knowledge_retrieval_degraded", severity: "warning" });
  }
  return result.sort((left, right) =>
    (left.severity === right.severity
      ? left.code.localeCompare(right.code)
      : left.severity === "critical" ? -1 : 1));
}

export function createAdminKnowledgeOperationsService(client: OperationsClient) {
  return {
    async read(): Promise<AdminKnowledgeOperations> {
      const [rows, reconciliation] = await Promise.all([
        client.$queryRaw<OperationsRow[]>(Prisma.sql`
          WITH artifact_stats AS (
            SELECT
              count(*) FILTER (WHERE "state" = 'pending')::integer AS "pendingArtifacts",
              count(*) FILTER (WHERE "state" = 'processing')::integer AS "processingArtifacts",
              count(*) FILTER (WHERE "state" = 'ready')::integer AS "readyArtifacts",
              count(*) FILTER (WHERE "state" = 'failed')::integer AS "failedArtifacts",
              count(*) FILTER (WHERE cardinality("warningCodes") > 0)::integer
                AS "warningArtifacts",
              CASE
                WHEN min("createdAt") FILTER (
                  WHERE "state" IN ('pending', 'processing')
                ) IS NULL THEN NULL
                ELSE GREATEST(0, EXTRACT(EPOCH FROM (
                  CURRENT_TIMESTAMP - min("createdAt") FILTER (
                    WHERE "state" IN ('pending', 'processing')
                  )
                )))::double precision
              END AS "oldestQueuedSeconds",
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY GREATEST(
                  0,
                  EXTRACT(EPOCH FROM ("readyAt" - "createdAt")) * 1000
                )
              ) FILTER (
                WHERE "state" = 'ready'
                  AND "readyAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              )::double precision AS "p50ReadyLatencyMs24h",
              percentile_cont(0.95) WITHIN GROUP (
                ORDER BY GREATEST(
                  0,
                  EXTRACT(EPOCH FROM ("readyAt" - "createdAt")) * 1000
                )
              ) FILTER (
                WHERE "state" = 'ready'
                  AND "readyAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              )::double precision AS "p95ReadyLatencyMs24h"
            FROM "KnowledgeSourceIndexArtifact"
          ), upload_stats AS (
            SELECT
              count(*) FILTER (WHERE "state" IN ('QUEUED', 'UPLOADING'))::integer
                AS "activeUploads",
              count(*) FILTER (
                WHERE "state" IN ('QUEUED', 'UPLOADING')
                  AND "sessionExpiresAt" < CURRENT_TIMESTAMP
              )::integer AS "expiredUploads",
              count(*) FILTER (WHERE "state" = 'NEEDS_ATTENTION')::integer
                AS "needsAttentionUploads",
              count(*) FILTER (
                WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              )::integer AS "items24h",
              count(*) FILTER (
                WHERE "settledAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              )::integer AS "settledUploads24h",
              COALESCE(sum("uploadedByteSize") FILTER (
                WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
              ), 0)::bigint AS "uploadedBytes24h"
            FROM "KnowledgeUploadItem"
          ), deletion_stats AS (
            SELECT
              count(*) FILTER (WHERE "state" <> 'SUCCEEDED')::integer
                AS "pendingDeletionJobs",
              count(*) FILTER (WHERE "state" = 'BLOCKED_REQUIRES_ADMIN')::integer
                AS "blockedDeletionJobs",
              CASE
                WHEN min("createdAt") FILTER (WHERE "state" <> 'SUCCEEDED') IS NULL THEN NULL
                ELSE GREATEST(0, EXTRACT(EPOCH FROM (
                  CURRENT_TIMESTAMP - min("createdAt") FILTER (
                    WHERE "state" <> 'SUCCEEDED'
                  )
                )))::double precision
              END AS "oldestDeletionSeconds"
            FROM "KnowledgeDeletionJob"
          ), deletion_object_stats AS (
            SELECT count(*) FILTER (WHERE "disposition" = 'PENDING')::integer
              AS "pendingDeletionObjects"
            FROM "KnowledgeDeletionObject"
          ), retrieval_stats AS (
            SELECT
              count(*)::integer AS "retrievalOperations24h",
              count(*) FILTER (
                WHERE run."failureCode" IS NOT NULL
                  OR run."outcome" IN (
                    'embedding_model_unavailable',
                    'budget_exhausted',
                    'base_indexing',
                    'source_location_unavailable'
                  )
                  OR cardinality(session."degradedFlags") > 0
              )::integer AS "degradedOperations24h",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY run."durationMs")::double precision
                AS "p50RetrievalDurationMs24h",
              percentile_cont(0.95) WITHIN GROUP (ORDER BY run."durationMs")::double precision
                AS "p95RetrievalDurationMs24h"
            FROM "KnowledgeRun" AS run
            LEFT JOIN "KnowledgeRetrievalSession" AS session
              ON session."id" = run."retrievalSessionId"
            WHERE run."createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
          ), grounding_stats AS (
            SELECT count(*) FILTER (WHERE "outcome" = 'insufficient_evidence')::integer
              AS "noAnswerOperations24h"
            FROM "KnowledgeGroundingResult"
            WHERE "createdAt" >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
          )
          SELECT
            CURRENT_TIMESTAMP AS "checkedAt",
            artifact_stats.*,
            upload_stats.*,
            deletion_stats.*,
            deletion_object_stats.*,
            retrieval_stats.*,
            grounding_stats.*
          FROM artifact_stats
          CROSS JOIN upload_stats
          CROSS JOIN deletion_stats
          CROSS JOIN deletion_object_stats
          CROSS JOIN retrieval_stats
          CROSS JOIN grounding_stats
        `),
        reconcileKnowledgeSourcePersistence(client)
      ]);
      const row = rows[0];
      if (!row) throw new Error("knowledge_operations_unavailable");
      const normalized = {
        activeUploads: integer(row.activeUploads, "knowledge_operations_count_invalid"),
        blockedDeletionJobs: integer(
          row.blockedDeletionJobs,
          "knowledge_operations_count_invalid"
        ),
        degradedOperations24h: integer(
          row.degradedOperations24h,
          "knowledge_operations_count_invalid"
        ),
        expiredUploads: integer(row.expiredUploads, "knowledge_operations_count_invalid"),
        failedArtifacts: integer(row.failedArtifacts, "knowledge_operations_count_invalid"),
        items24h: integer(row.items24h, "knowledge_operations_count_invalid"),
        needsAttentionUploads: integer(
          row.needsAttentionUploads,
          "knowledge_operations_count_invalid"
        ),
        noAnswerOperations24h: integer(
          row.noAnswerOperations24h,
          "knowledge_operations_count_invalid"
        ),
        oldestDeletionSeconds: nullableRounded(
          row.oldestDeletionSeconds,
          "knowledge_operations_duration_invalid"
        ),
        oldestQueuedSeconds: nullableRounded(
          row.oldestQueuedSeconds,
          "knowledge_operations_duration_invalid"
        ),
        p50ReadyLatencyMs24h: nullableRounded(
          row.p50ReadyLatencyMs24h,
          "knowledge_operations_duration_invalid"
        ),
        p50RetrievalDurationMs24h: nullableRounded(
          row.p50RetrievalDurationMs24h,
          "knowledge_operations_duration_invalid"
        ),
        p95ReadyLatencyMs24h: nullableRounded(
          row.p95ReadyLatencyMs24h,
          "knowledge_operations_duration_invalid"
        ),
        p95RetrievalDurationMs24h: nullableRounded(
          row.p95RetrievalDurationMs24h,
          "knowledge_operations_duration_invalid"
        ),
        pendingArtifacts: integer(row.pendingArtifacts, "knowledge_operations_count_invalid"),
        pendingDeletionJobs: integer(
          row.pendingDeletionJobs,
          "knowledge_operations_count_invalid"
        ),
        pendingDeletionObjects: integer(
          row.pendingDeletionObjects,
          "knowledge_operations_count_invalid"
        ),
        processingArtifacts: integer(
          row.processingArtifacts,
          "knowledge_operations_count_invalid"
        ),
        readyArtifacts: integer(row.readyArtifacts, "knowledge_operations_count_invalid"),
        retrievalOperations24h: integer(
          row.retrievalOperations24h,
          "knowledge_operations_count_invalid"
        ),
        settledUploads24h: integer(
          row.settledUploads24h,
          "knowledge_operations_count_invalid"
        ),
        uploadedBytes24h: integer(
          row.uploadedBytes24h,
          "knowledge_operations_count_invalid"
        ),
        warningArtifacts: integer(row.warningArtifacts, "knowledge_operations_count_invalid")
      };
      return {
        alerts: alerts({
          blockedDeletionJobs: normalized.blockedDeletionJobs,
          degradedOperations24h: normalized.degradedOperations24h,
          discrepancies: reconciliation.discrepancies,
          expiredUploads: normalized.expiredUploads,
          failedArtifacts: normalized.failedArtifacts,
          oldestQueuedSeconds: normalized.oldestQueuedSeconds,
          pendingDeletionJobs: normalized.pendingDeletionJobs,
          retrievalOperations24h: normalized.retrievalOperations24h
        }),
        checkedAt: row.checkedAt.toISOString(),
        deletion: {
          blockedJobs: normalized.blockedDeletionJobs,
          oldestPendingSeconds: normalized.oldestDeletionSeconds,
          pendingJobs: normalized.pendingDeletionJobs,
          pendingObjects: normalized.pendingDeletionObjects
        },
        ingestion: {
          activeUploads: normalized.activeUploads,
          expiredUploads: normalized.expiredUploads,
          failedArtifacts: normalized.failedArtifacts,
          items24h: normalized.items24h,
          needsAttentionUploads: normalized.needsAttentionUploads,
          oldestQueuedSeconds: normalized.oldestQueuedSeconds,
          p50ReadyLatencyMs24h: normalized.p50ReadyLatencyMs24h,
          p95ReadyLatencyMs24h: normalized.p95ReadyLatencyMs24h,
          pendingArtifacts: normalized.pendingArtifacts,
          processingArtifacts: normalized.processingArtifacts,
          readyArtifacts: normalized.readyArtifacts,
          settledUploads24h: normalized.settledUploads24h,
          uploadedBytes24h: normalized.uploadedBytes24h,
          warningArtifacts: normalized.warningArtifacts
        },
        migration: {
          discrepancies: reconciliation.discrepancies,
          mappedArtifacts: reconciliation.mappedGenerationCandidates,
          mappedDocuments: reconciliation.mappedDocuments,
          mappedVersions: reconciliation.mappedVersions,
          v1Artifacts: reconciliation.v1GenerationCandidates,
          v1Documents: reconciliation.v1Documents,
          v1Versions: reconciliation.v1Versions
        },
        retrieval: {
          degradedOperations24h: normalized.degradedOperations24h,
          noAnswerOperations24h: normalized.noAnswerOperations24h,
          operations24h: normalized.retrievalOperations24h,
          p50DurationMs24h: normalized.p50RetrievalDurationMs24h,
          p95DurationMs24h: normalized.p95RetrievalDurationMs24h
        }
      };
    }
  };
}
