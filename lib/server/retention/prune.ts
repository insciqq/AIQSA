import { ARTIFACT_WRITE_LEASE_MS } from "../artifacts/lifecycle";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@/lib/server/uploads/storage";
import { createMcpHubOperationStore, type McpHubMaintenanceResult } from "../mcp/hubOperations";
import { WORKSPACE_ACTIVITY_RECEIPT } from "../runs/workspaceActivityPersistence";

export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const DEFAULT_ORPHAN_ATTACHMENT_RETENTION_DAYS = 7;
export const DEFAULT_AUTH_RETENTION_DAYS = 30;
export const DEFAULT_PRUNE_BATCH_SIZE = 1000;
export const DEFAULT_DELETION_JOB_LEASE_MINUTES = 15;

export const TERMINAL_MODEL_RUN_STATUSES = ["cancelled", "complete", "error"] as const;

// The latest context meter is the durable measurement of this run. Older
// meters and replay receipts may expire; all other output types fail closed.
// Selection and deletion share this predicate so even caller-supplied ids
// cannot remove the final meter, including a sole pre-answer measurement.
const expirableModelRunEventSql = Prisma.sql`(
  event."eventType" = ${WORKSPACE_ACTIVITY_RECEIPT}
  OR (
    event."eventType" = 'artifact'
    AND event."payload"->>'artifactType' = 'context_status'
    AND EXISTS (
      SELECT 1 FROM "ModelRunEvent" AS later
      WHERE later."modelRunId" = event."modelRunId"
        AND later."sequence" > event."sequence"
        AND later."eventType" = 'artifact'
        AND later."payload"->>'artifactType' = 'context_status'
    )
  )
)`;

export type AttachmentDeletionClaim = {
  claimToken: string;
  id: string;
  multipartUploadId: string | null;
  storageKey: string;
};

export type AttachmentInspection = {
  matched: number;
  shared: number;
};

export type AttachmentStageResult = {
  jobsStaged: number;
  matched: number;
  rowsDeleted: number;
  sharedRowsDeleted: number;
};

export type InboundMcpOAuthPruneCandidates = Readonly<{
  authorizationCodeIds: string[];
  clientIds: string[];
  grantIds: string[];
  tokenFamilyIds: string[];
}>;

export type InboundMcpOAuthPruneResult = Readonly<{
  authorizationCodes: number;
  clients: number;
  grants: number;
  tokenFamilies: number;
}>;

export type RetentionRepository = {
  maintainMcpHub(input: { cutoff: Date; dryRun: boolean; limit: number; now: Date }): Promise<McpHubMaintenanceResult>;
  claimAttachmentDeletionJobs(input: {
    claimableBefore: Date;
    limit: number;
    now: Date;
  }): Promise<AttachmentDeletionClaim[]>;
  completeAttachmentDeletionJob(input: { claimToken: string; id: string }): Promise<boolean>;
  deleteAuthFlowTokens(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deleteAuthSessions(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deleteConnectPairings(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deletePrunableInboundMcpOAuth(input: {
    candidates: InboundMcpOAuthPruneCandidates;
    cutoff: Date;
  }): Promise<InboundMcpOAuthPruneResult>;
  deleteModelRunEvents(ids: string[]): Promise<number>;
  findClaimableAttachmentDeletionJobIds(input: {
    now?: Date;
    claimableBefore: Date;
    limit: number;
  }): Promise<string[]>;
  findPrunableAuthFlowTokenIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableAuthSessionIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableConnectPairingIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableInboundMcpOAuth(input: {
    cutoff: Date;
    limit: number;
  }): Promise<InboundMcpOAuthPruneCandidates>;
  findPrunableModelRunEventIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  /** Aged terminal-run events that retention deliberately keeps as answer projections. */
  countExemptModelRunEvents(input: { cutoff: Date }): Promise<number>;
  inspectOrphanedAttachments(input: { cutoff: Date; limit: number }): Promise<AttachmentInspection>;
  releaseAttachmentDeletionJob(input: {
    claimToken: string;
    errorCode: "object_delete_failed";
    id: string;
    now: Date;
  }): Promise<boolean>;
  stageOrphanedAttachments(input: {
    cutoff: Date;
    limit: number;
  }): Promise<AttachmentStageResult>;
};

export type PruneRetentionOptions = {
  authRetentionDays?: number;
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  dryRun?: boolean;
  eventRetentionDays?: number;
  now?: Date;
  orphanAttachmentRetentionDays?: number;
  repository: RetentionRepository;
  storage: Pick<StorageAdapter, "deleteObject" | "directMultipartUpload">;
};

export type DeletionObligationDrainSummary = Readonly<{
  attachmentJobs: Readonly<{
    claimed: number;
    completed: number;
    failed: number;
  }>;
  exhausted: boolean;
  passes: number;
}>;

type RetentionCount = {
  deleted: number;
  matched: number;
};

export type PruneRetentionSummary = {
  mcpHub: McpHubMaintenanceResult;
  attachmentDeletionJobs: {
    claimed: number;
    completed: number;
    failedJobs: {
      code: "object_delete_failed";
      id: string;
    }[];
    matched: number;
    objectsDeleted: number;
  };
  authCutoff: string;
  authFlowTokens: RetentionCount;
  authSessions: RetentionCount;
  /** Expired AIQSA Connect pairings, whether pending, denied or consumed. */
  connectPairings: RetentionCount;
  dryRun: boolean;
  eventCutoff: string;
  inboundMcpOAuth: {
    authorizationCodes: RetentionCount;
    clients: RetentionCount;
    grants: RetentionCount;
    tokenFamilies: RetentionCount;
  };
  modelRunEvents: RetentionCount & {
    exempt: number;
  };
  orphanAttachmentCutoff: string;
  orphanedAttachments: {
    jobsStaged: number;
    matched: number;
    rowsDeleted: number;
    shared: number;
  };
};

type LockedAttachment = {
  createdAt: Date;
  id: string;
  messageId: string | null;
  savedAt: Date | null;
};

function cutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

export function deletionJobClaimableBefore(
  now: Date,
  leaseMinutes = DEFAULT_DELETION_JOB_LEASE_MINUTES
): Date {
  return new Date(now.getTime() - leaseMinutes * 60 * 1000);
}

/**
 * Whether the `"AttachmentDeletionJob" AS job` row is due: no live claim and no
 * reference that still protects its private object. Claims, the prune dry run
 * and operational health share this one predicate.
 */
export function dueAttachmentDeletionJobSql(input: Readonly<{
  claimableBefore: Date;
  now: Date;
}>): Prisma.Sql {
  const { claimableBefore, now } = input;
  const artifactWriteCutoff = new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS);
  return Prisma.sql`((job."claimedAt" IS NULL OR job."claimedAt" < ${claimableBefore})
    AND NOT EXISTS (
      SELECT 1 FROM "Attachment" AS attachment
      WHERE attachment."storageKey" = job."storageKey"
      UNION ALL SELECT 1 FROM "ChatPdfArtifact" AS pdf_artifact
      WHERE pdf_artifact."storageKey" = job."storageKey"
      UNION ALL SELECT 1 FROM "SkillRevisionFile" AS skill_file
      WHERE skill_file."storageKey" = job."storageKey"
      UNION ALL SELECT 1 FROM "ToolObservation" AS observation
      WHERE observation."storageKey" = job."storageKey" AND (
        observation."state" = 'READY' OR
        (observation."state" = 'STORING' AND observation."leaseExpiresAt" > ${now})
      )
      UNION ALL SELECT 1 FROM "ChatContinuationWorkspaceSeed" AS seed
      WHERE seed."storageKey" = job."storageKey" AND seed."status" IN ('CAPTURING','READY','TRANSFERRED','RESTORING','RESTORED')
      UNION ALL SELECT 1 FROM "WorkspaceCapturedFile" AS captured_file
      JOIN "WorkspaceSelectedCapture" AS capture ON capture."id" = captured_file."captureId"
      WHERE captured_file."storageKey" = job."storageKey" AND (
        (captured_file."storageState" = 'STORING' AND captured_file."storageLeaseExpiresAt" > ${now})
        OR (captured_file."storageState" = 'READY' AND capture."state" = 'CAPTURED' AND EXISTS (
          SELECT 1 FROM "WorkspaceCaptureReference" reference
          WHERE reference."captureId" = capture."id" AND reference."releasedAt" IS NULL
        ))
        OR EXISTS (SELECT 1 FROM "WorkspaceCaptureReadLease" lease
          WHERE lease."captureId" = capture."id" AND lease."expiresAt" > ${now})
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ArtifactBlob" AS blob JOIN "ArtifactVersionBlob" AS reference ON reference."blobId" = blob."id"
      JOIN "ArtifactVersion" AS blob_version ON blob_version."id" = reference."versionId"
      WHERE blob."storageKey" = job."storageKey"
        AND (blob_version."status" = 'READY' OR (blob_version."status" = 'PENDING' AND blob_version."createdAt" > ${artifactWriteCutoff}))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ArtifactRender" AS render WHERE render."renderedStorageKey" = job."storageKey"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ArtifactVersion" AS version
      JOIN "Artifact" AS artifact ON artifact."id" = version."artifactId"
      WHERE version."bundleStorageKey" = job."storageKey"
        AND (version."status" = 'READY' OR (version."status" = 'PENDING' AND version."createdAt" > ${artifactWriteCutoff}))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ArtifactPublication" AS publication
      WHERE publication."bundleStorageKey" = job."storageKey"
        AND (publication."status" = 'READY' OR (publication."status" = 'PENDING' AND publication."createdAt" > ${artifactWriteCutoff}))
    ))`;
}

type AttachmentDeletionStorage = Pick<StorageAdapter, "deleteObject" | "directMultipartUpload">;

export type AttachmentDeletionBatch = Readonly<{
  claimed: number;
  completed: number;
  failedJobIds: readonly string[];
  objectsDeleted: number;
}>;

/**
 * The object-deletion step every drain shares: claim due jobs under a lease,
 * abort a recorded multipart upload, delete the object and settle the job. A
 * failure releases the job for a later attempt with a value-free code.
 */
export async function processAttachmentDeletionJobs(input: Readonly<{
  claimableBefore: Date;
  limit: number;
  now: Date;
  repository: Pick<
    RetentionRepository,
    "claimAttachmentDeletionJobs" | "completeAttachmentDeletionJob" | "releaseAttachmentDeletionJob"
  >;
  storage: AttachmentDeletionStorage;
}>): Promise<AttachmentDeletionBatch> {
  const claims = await input.repository.claimAttachmentDeletionJobs({
    claimableBefore: input.claimableBefore,
    limit: input.limit,
    now: input.now
  });
  let completed = 0;
  let objectsDeleted = 0;
  const failedJobIds: string[] = [];
  for (const claim of claims) {
    try {
      if (claim.multipartUploadId) {
        if (!input.storage.directMultipartUpload) {
          throw new Error("multipart_abort_unavailable");
        }
        await input.storage.directMultipartUpload.abortMultipartUpload({
          storageKey: claim.storageKey,
          uploadId: claim.multipartUploadId
        });
      }
      await input.storage.deleteObject(claim.storageKey);
      objectsDeleted += 1;
      if (await input.repository.completeAttachmentDeletionJob({
        claimToken: claim.claimToken,
        id: claim.id
      })) completed += 1;
    } catch {
      failedJobIds.push(claim.id);
      await input.repository.releaseAttachmentDeletionJob({
        claimToken: claim.claimToken,
        errorCode: "object_delete_failed",
        id: claim.id,
        now: input.now
      });
    }
  }
  return { claimed: claims.length, completed, failedJobIds, objectsDeleted };
}

export const OBJECT_DELETION_PASS_BATCH_SIZE = 32;
export const OBJECT_DELETION_PASS_MAX_BATCHES = 4;

export type ObjectDeletionPassSummary = Readonly<{
  batches: number;
  claimed: number;
  completed: number;
  failed: number;
}>;

/**
 * One bounded background pass over due object-deletion jobs: prune's claim,
 * reference checks, storage deletion and settlement in small batches, without
 * the retention staging that stays with `npm run prune`. Claim leases keep it
 * safe beside a running prune. A batch with a failed deletion ends the pass.
 */
export async function runObjectDeletionPass(input: Readonly<{
  batchSize?: number;
  maxBatches?: number;
  now?: () => Date;
  repository: Pick<
    RetentionRepository,
    | "claimAttachmentDeletionJobs"
    | "completeAttachmentDeletionJob"
    | "releaseAttachmentDeletionJob"
  >;
  signal?: AbortSignal;
  storage: AttachmentDeletionStorage;
}>): Promise<ObjectDeletionPassSummary> {
  const batchSize = positiveInteger(input.batchSize, OBJECT_DELETION_PASS_BATCH_SIZE);
  const maxBatches = positiveInteger(input.maxBatches, OBJECT_DELETION_PASS_MAX_BATCHES);
  const clock = input.now ?? (() => new Date());
  let batches = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  while (batches < maxBatches && !input.signal?.aborted) {
    const now = clock();
    const batch = await processAttachmentDeletionJobs({
      claimableBefore: deletionJobClaimableBefore(now),
      limit: batchSize,
      now,
      repository: input.repository,
      storage: input.storage
    });
    batches += 1;
    claimed += batch.claimed;
    completed += batch.completed;
    failed += batch.failedJobIds.length;
    if (batch.failedJobIds.length > 0 || batch.claimed < batchSize) break;
  }
  return { batches, claimed, completed, failed };
}

export async function drainDeletionObligations(input: Readonly<{
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  maxPasses?: number;
  repository: RetentionRepository;
  storage: AttachmentDeletionStorage;
}>): Promise<DeletionObligationDrainSummary> {
  const batchSize = positiveInteger(input.batchSize, DEFAULT_PRUNE_BATCH_SIZE);
  const deletionJobLeaseMinutes = positiveInteger(
    input.deletionJobLeaseMinutes,
    DEFAULT_DELETION_JOB_LEASE_MINUTES
  );
  const maxPasses = positiveInteger(input.maxPasses, 100);
  const summary: DeletionObligationDrainSummary = {
    attachmentJobs: { claimed: 0, completed: 0, failed: 0 },
    exhausted: false,
    passes: 0
  };

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const now = new Date();
    const objects = await processAttachmentDeletionJobs({
      claimableBefore: deletionJobClaimableBefore(now, deletionJobLeaseMinutes),
      limit: batchSize,
      now,
      repository: input.repository,
      storage: input.storage
    });
    const failed = objects.failedJobIds.length;
    Object.assign(summary, {
      attachmentJobs: {
        claimed: summary.attachmentJobs.claimed + objects.claimed,
        completed: summary.attachmentJobs.completed + objects.completed,
        failed: summary.attachmentJobs.failed + failed
      },
      passes: pass
    });
    if (failed > 0) return summary;
    if (objects.claimed === 0) return summary;
  }

  Object.assign(summary, { exhausted: true });
  return summary;
}

function prunableAuthSessionWhere(cutoff: Date): Prisma.AuthSessionWhereInput {
  return {
    OR: [
      {
        revokedAt: {
          lt: cutoff
        }
      },
      {
        expiresAt: {
          lt: cutoff
        },
        revokedAt: null
      }
    ]
  };
}

function prunableAuthFlowTokenWhere(cutoff: Date): Prisma.AuthFlowTokenWhereInput {
  return {
    OR: [
      {
        consumedAt: {
          lt: cutoff
        }
      },
      {
        consumedAt: null,
        expiresAt: {
          lt: cutoff
        }
      }
    ]
  };
}

/**
 * Every pairing expires minutes after its creation, and approval, denial and
 * consumption all happen before that; past the cutoff it serves nobody.
 */
function prunableConnectPairingWhere(cutoff: Date): Prisma.ConnectPairingWhereInput {
  return { expiresAt: { lt: cutoff } };
}

function prunableInboundMcpAuthorizationCodeWhere(
  cutoff: Date
): Prisma.InboundMcpOAuthAuthorizationCodeWhereInput {
  return {
    OR: [
      { consumedAt: { lt: cutoff } },
      { consumedAt: null, expiresAt: { lt: cutoff } }
    ]
  };
}

function prunableInboundMcpTokenFamilyWhere(
  cutoff: Date
): Prisma.InboundMcpOAuthTokenFamilyWhereInput {
  return {
    OR: [
      { revokedAt: { lt: cutoff } },
      { inactivityExpiresAt: { lt: cutoff }, revokedAt: null }
    ]
  };
}

function prunableInboundMcpGrantWhere(
  cutoff: Date
): Prisma.InboundMcpOAuthGrantWhereInput {
  return {
    revokedAt: { lt: cutoff },
    state: "REVOKED"
  };
}

function prunableInboundMcpClientWhere(
  cutoff: Date
): Prisma.InboundMcpOAuthClientWhereInput {
  return {
    grants: { none: {} },
    OR: [
      { lastUsedAt: { lt: cutoff } },
      { createdAt: { lt: cutoff }, lastUsedAt: null }
    ]
  };
}

export function createPrismaRetentionRepository(prisma: PrismaClient): RetentionRepository {
  return {
    async claimAttachmentDeletionJobs({ claimableBefore, limit, now }) {
      const claimToken = randomUUID();
      const rows = await prisma.$transaction(async (tx) => {
        const claims = await tx.$queryRaw<Array<{
          id: string;
          multipartUploadId: string | null;
          storageKey: string;
        }>>(Prisma.sql`
          WITH candidates AS (
            SELECT job."id"
            FROM "AttachmentDeletionJob" AS job
            WHERE ${dueAttachmentDeletionJobSql({ claimableBefore, now })}
            ORDER BY job."attemptCount", job."createdAt", job."id"
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE "AttachmentDeletionJob" AS job
          SET
            "attemptCount" = job."attemptCount" + 1,
            "claimedAt" = ${now},
            "claimToken" = ${claimToken},
            "lastAttemptAt" = ${now},
            "lastErrorCode" = NULL,
            "updatedAt" = ${now}
          FROM candidates
          WHERE job."id" = candidates."id"
          RETURNING job."id", job."multipartUploadId", job."storageKey"
        `);
        const allowed = [];
        for (const claim of claims) {
          // Serialize a deduplication reference against retirement. Deleting
          // the orphan row forces any future writer to allocate a fresh key.
          const blobs = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ArtifactBlob" WHERE "storageKey" = ${claim.storageKey} FOR UPDATE`;
          if (blobs.length) await tx.artifactVersionBlob.deleteMany({ where: { blobId: { in: blobs.map(blob => blob.id) },
            version: { OR: [{ status: "FAILED" }, { status: "PENDING", createdAt: { lte: new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS) } }] } } });
          if (blobs.length && await tx.artifactVersionBlob.count({ where: { blobId: { in: blobs.map(blob => blob.id) } } })) {
            await tx.attachmentDeletionJob.updateMany({ where: { id: claim.id, claimToken }, data: { claimedAt: null, claimToken: null } });
            continue;
          }
          if (blobs.length) await tx.artifactBlob.deleteMany({ where: { id: { in: blobs.map(blob => blob.id) }, versions: { none: {} } } });
          allowed.push(claim);
        }
        return allowed;
      });

      return rows.map((row) => ({
        claimToken,
        id: row.id,
        multipartUploadId: row.multipartUploadId,
        storageKey: row.storageKey
      }));
    },
    async completeAttachmentDeletionJob(input) {
      return prisma.$transaction(async (tx) => {
        const jobs = await tx.$queryRaw<Array<{ storageKey: string }>>`
          SELECT "storageKey"
          FROM "AttachmentDeletionJob"
          WHERE "id" = ${input.id}
            AND "claimToken" = ${input.claimToken}
          FOR UPDATE
        `;
        const job = jobs[0];
        if (!job) return false;
        const deleted = await tx.attachmentDeletionJob.deleteMany({
          where: { claimToken: input.claimToken, id: input.id }
        });
        return deleted.count === 1;
      });
    },
    async deleteAuthFlowTokens({ cutoff, ids }) {
      if (ids.length === 0) {
        return 0;
      }

      const deleted = await prisma.authFlowToken.deleteMany({
        where: {
          ...prunableAuthFlowTokenWhere(cutoff),
          id: {
            in: ids
          }
        }
      });

      return deleted.count;
    },
    async deleteAuthSessions({ cutoff, ids }) {
      if (ids.length === 0) {
        return 0;
      }

      const deleted = await prisma.authSession.deleteMany({
        where: {
          ...prunableAuthSessionWhere(cutoff),
          id: {
            in: ids
          }
        }
      });

      return deleted.count;
    },
    async deleteConnectPairings({ cutoff, ids }) {
      if (ids.length === 0) {
        return 0;
      }

      const deleted = await prisma.connectPairing.deleteMany({
        where: { ...prunableConnectPairingWhere(cutoff), id: { in: ids } }
      });

      return deleted.count;
    },
    maintainMcpHub: (input) => createMcpHubOperationStore(prisma).maintain(input),
    deletePrunableInboundMcpOAuth({ candidates, cutoff }) {
      return prisma.$transaction(async (tx) => {
        const authorizationCodes = candidates.authorizationCodeIds.length === 0
          ? { count: 0 }
          : await tx.inboundMcpOAuthAuthorizationCode.deleteMany({
            where: {
              ...prunableInboundMcpAuthorizationCodeWhere(cutoff),
              id: { in: candidates.authorizationCodeIds }
            }
          });
        const tokenFamilies = candidates.tokenFamilyIds.length === 0
          ? { count: 0 }
          : await tx.inboundMcpOAuthTokenFamily.deleteMany({
            where: {
              ...prunableInboundMcpTokenFamilyWhere(cutoff),
              id: { in: candidates.tokenFamilyIds }
            }
          });
        const grants = candidates.grantIds.length === 0
          ? { count: 0 }
          : await tx.inboundMcpOAuthGrant.deleteMany({
            where: {
              ...prunableInboundMcpGrantWhere(cutoff),
              id: { in: candidates.grantIds }
            }
          });
        const clients = candidates.clientIds.length === 0
          ? { count: 0 }
          : await tx.inboundMcpOAuthClient.deleteMany({
            where: {
              ...prunableInboundMcpClientWhere(cutoff),
              id: { in: candidates.clientIds }
            }
          });

        return {
          authorizationCodes: authorizationCodes.count,
          clients: clients.count,
          grants: grants.count,
          tokenFamilies: tokenFamilies.count
        };
      });
    },
    async deleteModelRunEvents(ids) {
      if (ids.length === 0) {
        return 0;
      }

      return prisma.$executeRaw(Prisma.sql`
        DELETE FROM "ModelRunEvent" AS event
        USING "ModelRun" AS run
        WHERE event."modelRunId" = run."id"
          AND run."status"::text IN (${Prisma.join(TERMINAL_MODEL_RUN_STATUSES)})
          AND event."id" IN (${Prisma.join(ids)})
          AND ${expirableModelRunEventSql}
      `);
    },
    async findClaimableAttachmentDeletionJobIds({ claimableBefore, limit, now = new Date() }) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT job."id"
        FROM "AttachmentDeletionJob" AS job
        WHERE ${dueAttachmentDeletionJobSql({ claimableBefore, now })}
        ORDER BY job."attemptCount", job."createdAt", job."id"
        LIMIT ${limit}
      `);

      return rows.map((row) => row.id);
    },
    async findPrunableAuthFlowTokenIds({ cutoff, limit }) {
      const rows = await prisma.authFlowToken.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: prunableAuthFlowTokenWhere(cutoff)
      });

      return rows.map((row) => row.id);
    },
    async findPrunableAuthSessionIds({ cutoff, limit }) {
      const rows = await prisma.authSession.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: prunableAuthSessionWhere(cutoff)
      });

      return rows.map((row) => row.id);
    },
    async findPrunableConnectPairingIds({ cutoff, limit }) {
      const rows = await prisma.connectPairing.findMany({
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: limit,
        where: prunableConnectPairingWhere(cutoff)
      });

      return rows.map((row) => row.id);
    },
    async findPrunableInboundMcpOAuth({ cutoff, limit }) {
      const [authorizationCodes, tokenFamilies, grants, clients] = await Promise.all([
        prisma.inboundMcpOAuthAuthorizationCode.findMany({
          orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
          select: { id: true },
          take: limit,
          where: prunableInboundMcpAuthorizationCodeWhere(cutoff)
        }),
        prisma.inboundMcpOAuthTokenFamily.findMany({
          orderBy: [{ inactivityExpiresAt: "asc" }, { id: "asc" }],
          select: { id: true },
          take: limit,
          where: prunableInboundMcpTokenFamilyWhere(cutoff)
        }),
        prisma.inboundMcpOAuthGrant.findMany({
          orderBy: [{ revokedAt: "asc" }, { id: "asc" }],
          select: { id: true },
          take: limit,
          where: prunableInboundMcpGrantWhere(cutoff)
        }),
        prisma.inboundMcpOAuthClient.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
          take: limit,
          where: prunableInboundMcpClientWhere(cutoff)
        })
      ]);

      return {
        authorizationCodeIds: authorizationCodes.map((row) => row.id),
        clientIds: clients.map((row) => row.id),
        grantIds: grants.map((row) => row.id),
        tokenFamilyIds: tokenFamilies.map((row) => row.id)
      };
    },
    async findPrunableModelRunEventIds({ cutoff, limit }) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT event."id" FROM "ModelRunEvent" AS event
        JOIN "ModelRun" AS run ON run."id" = event."modelRunId"
        WHERE event."createdAt" < ${cutoff}
          AND run."status"::text IN (${Prisma.join(TERMINAL_MODEL_RUN_STATUSES)})
          AND ${expirableModelRunEventSql}
        ORDER BY event."createdAt" ASC, event."id" ASC
        LIMIT ${limit}
      `);
      return rows.map((row) => row.id);
    },
    async countExemptModelRunEvents({ cutoff }) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*) AS count FROM "ModelRunEvent" AS event
        JOIN "ModelRun" AS run ON run."id" = event."modelRunId"
        WHERE event."createdAt" < ${cutoff}
          AND run."status"::text IN (${Prisma.join(TERMINAL_MODEL_RUN_STATUSES)})
          AND NOT COALESCE(${expirableModelRunEventSql}, false)
      `);
      return Number(rows[0]?.count ?? 0);
    },
    async inspectOrphanedAttachments({ cutoff, limit }) {
      const candidates = await prisma.attachment.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          storageKey: true
        },
        take: limit,
        where: {
          createdAt: {
            lt: cutoff
          },
          messageId: null,
          savedAt: null
        }
      });

      if (candidates.length === 0) {
        return { matched: 0, shared: 0 };
      }

      const candidateIds = new Set(candidates.map((candidate) => candidate.id));
      const storageKeys = [...new Set(candidates.map((candidate) => candidate.storageKey))];
      const references = await prisma.attachment.findMany({
        select: {
          id: true,
          storageKey: true
        },
        where: {
          storageKey: {
            in: storageKeys
          }
        }
      });
      const sharedKeys = new Set(
        references.filter((reference) => !candidateIds.has(reference.id)).map((reference) => reference.storageKey)
      );
      const pdfReferences = await prisma.chatPdfArtifact.findMany({
        select: { storageKey: true }, where: { storageKey: { in: storageKeys } }
      });
      for (const reference of pdfReferences) sharedKeys.add(reference.storageKey);

      return {
        matched: candidates.length,
        shared: candidates.filter((candidate) => sharedKeys.has(candidate.storageKey)).length
      };
    },
    async releaseAttachmentDeletionJob(input) {
      const released = await prisma.attachmentDeletionJob.updateMany({
        data: {
          claimedAt: null,
          claimToken: null,
          lastAttemptAt: input.now,
          lastErrorCode: input.errorCode
        },
        where: {
          claimToken: input.claimToken,
          id: input.id
        }
      });

      return released.count === 1;
    },
    async stageOrphanedAttachments({ cutoff, limit }) {
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.attachment.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            storageKey: true
          },
          take: limit,
          where: {
            createdAt: {
              lt: cutoff
            },
            messageId: null,
            savedAt: null
          }
        });
        const candidatesByStorageKey = new Map<string, Set<string>>();

        for (const candidate of candidates) {
          const ids = candidatesByStorageKey.get(candidate.storageKey) ?? new Set<string>();
          ids.add(candidate.id);
          candidatesByStorageKey.set(candidate.storageKey, ids);
        }

        let jobsStaged = 0;
        let rowsDeleted = 0;
        let sharedRowsDeleted = 0;
        for (const storageKey of [...candidatesByStorageKey.keys()].sort()) {
          await tx.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 260))::text AS "lock"
          `;
          const references = await tx.$queryRaw<LockedAttachment[]>`
            SELECT "id", "messageId", "createdAt", "savedAt"
            FROM "Attachment"
            WHERE "storageKey" = ${storageKey}
            ORDER BY "id"
            FOR UPDATE
          `;
          const candidateIds = candidatesByStorageKey.get(storageKey) ?? new Set<string>();
          const deletableIds = references
            .filter(
              (reference) =>
                candidateIds.has(reference.id) &&
                reference.messageId === null &&
                reference.savedAt === null &&
                reference.createdAt < cutoff
            )
            .map((reference) => reference.id);

          if (deletableIds.length === 0) {
            continue;
          }

          const remainingReferenceCount = references.length - deletableIds.length;
          const pdfReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ChatPdfArtifact" WHERE "storageKey" = ${storageKey} FOR SHARE
          `;
          const artifactBlobReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT blob."id" FROM "ArtifactBlob" AS blob JOIN "ArtifactVersionBlob" AS reference ON reference."blobId" = blob."id"
            JOIN "ArtifactVersion" AS blob_version ON blob_version."id" = reference."versionId"
            WHERE blob."storageKey" = ${storageKey}
              AND (blob_version."status" = 'READY' OR (blob_version."status" = 'PENDING' AND blob_version."createdAt" > ${new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS)})) FOR SHARE
          `;
          const artifactRenderReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ArtifactRender" WHERE "renderedStorageKey" = ${storageKey} FOR SHARE
          `;
          const artifactVersionReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT version."id" FROM "ArtifactVersion" AS version
            JOIN "Artifact" AS artifact ON artifact."id" = version."artifactId"
            WHERE version."bundleStorageKey" = ${storageKey}
              AND (version."status" = 'READY' OR (version."status" = 'PENDING' AND version."createdAt" > ${new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS)}))
            FOR SHARE
          `;
          const artifactPublicationReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "ArtifactPublication"
            WHERE "bundleStorageKey" = ${storageKey} AND ("status" = 'READY' OR ("status" = 'PENDING' AND "createdAt" > ${new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS)}))
            FOR SHARE
          `;
          const skillFileReferences = await tx.$queryRaw<Array<{ revisionId: string }>>`
            SELECT "revisionId" FROM "SkillRevisionFile" WHERE "storageKey" = ${storageKey} FOR SHARE
          `;
          if (
            skillFileReferences.length === 0 &&
            remainingReferenceCount === 0 &&
            pdfReferences.length === 0
            && artifactVersionReferences.length === 0
            && artifactBlobReferences.length === 0 && artifactRenderReferences.length === 0
            && artifactPublicationReferences.length === 0
          ) {
            const existing = await tx.attachmentDeletionJob.findUnique({
              select: { id: true },
              where: { storageKey }
            });
            if (!existing) {
              await tx.attachmentDeletionJob.create({
                data: { storageKey }
              });
              jobsStaged += 1;
            }
          } else {
            sharedRowsDeleted += deletableIds.length;
          }

          const deleted = await tx.attachment.deleteMany({
            where: {
              createdAt: {
                lt: cutoff
              },
              id: {
                in: deletableIds
              },
              messageId: null,
              savedAt: null
            }
          });
          rowsDeleted += deleted.count;
        }

        return {
          jobsStaged,
          matched: candidates.length,
          rowsDeleted,
          sharedRowsDeleted
        };
      });
    }
  };
}

function emptySummary(input: {
  authCutoff: Date;
  authFlowTokenIds: string[];
  authSessionIds: string[];
  connectPairingIds: string[];
  deletionJobIds: string[];
  dryRun: boolean;
  eventCutoff: Date;
  eventIds: string[];
  exemptEventCount: number;
  inboundMcpOAuthCandidates: InboundMcpOAuthPruneCandidates;
  orphanAttachmentCutoff: Date;
  orphanInspection: AttachmentInspection;
}): PruneRetentionSummary {
  return {
    attachmentDeletionJobs: {
      claimed: 0,
      completed: 0,
      failedJobs: [],
      matched: input.deletionJobIds.length,
      objectsDeleted: 0
    },
    mcpHub: { dispatches: { expired: 0, removed: 0 }, discoveryAttempts: { expired: 0, removed: 0 } },
    authCutoff: input.authCutoff.toISOString(),
    authFlowTokens: {
      deleted: 0,
      matched: input.authFlowTokenIds.length
    },
    authSessions: {
      deleted: 0,
      matched: input.authSessionIds.length
    },
    connectPairings: {
      deleted: 0,
      matched: input.connectPairingIds.length
    },
    dryRun: input.dryRun,
    eventCutoff: input.eventCutoff.toISOString(),
    inboundMcpOAuth: {
      authorizationCodes: {
        deleted: 0,
        matched: input.inboundMcpOAuthCandidates.authorizationCodeIds.length
      },
      clients: {
        deleted: 0,
        matched: input.inboundMcpOAuthCandidates.clientIds.length
      },
      grants: {
        deleted: 0,
        matched: input.inboundMcpOAuthCandidates.grantIds.length
      },
      tokenFamilies: {
        deleted: 0,
        matched: input.inboundMcpOAuthCandidates.tokenFamilyIds.length
      }
    },
    modelRunEvents: {
      deleted: 0,
      exempt: input.exemptEventCount,
      matched: input.eventIds.length
    },
    orphanAttachmentCutoff: input.orphanAttachmentCutoff.toISOString(),
    orphanedAttachments: {
      jobsStaged: 0,
      matched: input.orphanInspection.matched,
      rowsDeleted: 0,
      shared: input.orphanInspection.shared
    }
  };
}

export async function pruneRetention(options: PruneRetentionOptions): Promise<PruneRetentionSummary> {
  const now = options.now ?? new Date();
  const batchSize = positiveInteger(options.batchSize, DEFAULT_PRUNE_BATCH_SIZE);
  const eventRetentionDays = positiveInteger(options.eventRetentionDays, DEFAULT_EVENT_RETENTION_DAYS);
  const orphanAttachmentRetentionDays = positiveInteger(
    options.orphanAttachmentRetentionDays,
    DEFAULT_ORPHAN_ATTACHMENT_RETENTION_DAYS
  );
  const authRetentionDays = positiveInteger(options.authRetentionDays, DEFAULT_AUTH_RETENTION_DAYS);
  const deletionJobLeaseMinutes = positiveInteger(
    options.deletionJobLeaseMinutes,
    DEFAULT_DELETION_JOB_LEASE_MINUTES
  );
  const dryRun = options.dryRun ?? true;
  const eventCutoff = cutoffDate(now, eventRetentionDays);
  const orphanAttachmentCutoff = cutoffDate(now, orphanAttachmentRetentionDays);
  const authCutoff = cutoffDate(now, authRetentionDays);
  const claimableBefore = deletionJobClaimableBefore(now, deletionJobLeaseMinutes);
  const [
    eventIds,
    exemptEventCount,
    orphanInspection,
    authSessionIds,
    authFlowTokenIds,
    connectPairingIds,
    inboundMcpOAuthCandidates,
    initialDeletionJobIds
  ] = await Promise.all([
    options.repository.findPrunableModelRunEventIds({ cutoff: eventCutoff, limit: batchSize }),
    options.repository.countExemptModelRunEvents({ cutoff: eventCutoff }),
    options.repository.inspectOrphanedAttachments({ cutoff: orphanAttachmentCutoff, limit: batchSize }),
    options.repository.findPrunableAuthSessionIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableAuthFlowTokenIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableConnectPairingIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableInboundMcpOAuth({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findClaimableAttachmentDeletionJobIds({ now, claimableBefore, limit: batchSize })
  ]);
  const summary = emptySummary({
    authCutoff,
    authFlowTokenIds,
    authSessionIds,
    connectPairingIds,
    deletionJobIds: initialDeletionJobIds,
    dryRun,
    eventCutoff,
    eventIds,
    exemptEventCount,
    inboundMcpOAuthCandidates,
    orphanAttachmentCutoff,
    orphanInspection
  });

  summary.mcpHub = await options.repository.maintainMcpHub({ cutoff: authCutoff, dryRun, limit: batchSize, now });
  if (dryRun) {
    return summary;
  }

  const [deletedEvents, deletedSessions, deletedFlowTokens, deletedConnectPairings, deletedInboundMcpOAuth] = await Promise.all([
    options.repository.deleteModelRunEvents(eventIds),
    options.repository.deleteAuthSessions({ cutoff: authCutoff, ids: authSessionIds }),
    options.repository.deleteAuthFlowTokens({ cutoff: authCutoff, ids: authFlowTokenIds }),
    options.repository.deleteConnectPairings({ cutoff: authCutoff, ids: connectPairingIds }),
    options.repository.deletePrunableInboundMcpOAuth({
      candidates: inboundMcpOAuthCandidates,
      cutoff: authCutoff
    })
  ]);
  const stagedAttachments = await options.repository.stageOrphanedAttachments({
    cutoff: orphanAttachmentCutoff,
    limit: batchSize
  });
  const claimableDeletionJobIds = await options.repository.findClaimableAttachmentDeletionJobIds({
    now,
    claimableBefore,
    limit: batchSize
  });
  const objectDeletion = await processAttachmentDeletionJobs({
    claimableBefore,
    limit: batchSize,
    now,
    repository: options.repository,
    storage: options.storage
  });

  summary.modelRunEvents.deleted = deletedEvents;
  summary.authSessions.deleted = deletedSessions;
  summary.authFlowTokens.deleted = deletedFlowTokens;
  summary.connectPairings.deleted = deletedConnectPairings;
  summary.inboundMcpOAuth.authorizationCodes.deleted = deletedInboundMcpOAuth.authorizationCodes;
  summary.inboundMcpOAuth.clients.deleted = deletedInboundMcpOAuth.clients;
  summary.inboundMcpOAuth.grants.deleted = deletedInboundMcpOAuth.grants;
  summary.inboundMcpOAuth.tokenFamilies.deleted = deletedInboundMcpOAuth.tokenFamilies;
  summary.orphanedAttachments = {
    jobsStaged: stagedAttachments.jobsStaged,
    matched: stagedAttachments.matched,
    rowsDeleted: stagedAttachments.rowsDeleted,
    shared: stagedAttachments.sharedRowsDeleted
  };
  summary.attachmentDeletionJobs = {
    claimed: objectDeletion.claimed,
    completed: objectDeletion.completed,
    failedJobs: objectDeletion.failedJobIds.map((id) => ({ code: "object_delete_failed" as const, id })),
    matched: claimableDeletionJobIds.length,
    objectsDeleted: objectDeletion.objectsDeleted
  };

  return summary;
}
