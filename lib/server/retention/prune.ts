import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "@/lib/server/uploads/storage";
import {
  createPrismaKnowledgeDeletionProcessor,
  drainKnowledgeDeletionJobs,
  type KnowledgeDeletionDrainSummary
} from "@/lib/server/knowledge/deletionProcessor";
import { DEFAULT_KNOWLEDGE_TRASH_RETENTION_DAYS } from "@/lib/server/knowledge/lifecyclePolicy";

export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const DEFAULT_ORPHAN_ATTACHMENT_RETENTION_DAYS = 7;
export const DEFAULT_AUTH_RETENTION_DAYS = 30;
export const DEFAULT_KNOWLEDGE_PAYLOAD_RETENTION_DAYS = 30;
export const DEFAULT_KNOWLEDGE_UPLOAD_SESSION_RETENTION_DAYS = 7;
export { DEFAULT_KNOWLEDGE_TRASH_RETENTION_DAYS };
export const DEFAULT_PRUNE_BATCH_SIZE = 1000;
export const DEFAULT_DELETION_JOB_LEASE_MINUTES = 15;

export const TERMINAL_MODEL_RUN_STATUSES = ["cancelled", "complete", "error"] as const;

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

export type KnowledgePayloadInspection = {
  matched: number;
  objects: number;
};

export type KnowledgePayloadStageResult = {
  jobsStaged: number;
  matched: number;
  objectsReleased: number;
  sharedObjects: number;
  versionsPurged: number;
};

export type KnowledgeTrashInspection = {
  bases: number;
  sources: number;
};

export type KnowledgeTrashStageResult = KnowledgeTrashInspection & {
  jobsStaged: number;
};

export type KnowledgeUploadSessionInspection = {
  items: number;
  multipartSessions: number;
};

export type KnowledgeUploadSessionStageResult = KnowledgeUploadSessionInspection & {
  itemsReleased: number;
  jobsStaged: number;
  multipartSessionsReleased: number;
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
  claimAttachmentDeletionJobs(input: {
    claimableBefore: Date;
    limit: number;
    now: Date;
  }): Promise<AttachmentDeletionClaim[]>;
  completeAttachmentDeletionJob(input: { claimToken: string; id: string }): Promise<boolean>;
  deleteAuthFlowTokens(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deleteAuthSessions(input: { cutoff: Date; ids: string[] }): Promise<number>;
  deletePrunableInboundMcpOAuth(input: {
    candidates: InboundMcpOAuthPruneCandidates;
    cutoff: Date;
  }): Promise<InboundMcpOAuthPruneResult>;
  deleteModelRunEvents(ids: string[]): Promise<number>;
  findClaimableAttachmentDeletionJobIds(input: {
    claimableBefore: Date;
    limit: number;
  }): Promise<string[]>;
  findPrunableAuthFlowTokenIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableAuthSessionIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  findPrunableInboundMcpOAuth(input: {
    cutoff: Date;
    limit: number;
  }): Promise<InboundMcpOAuthPruneCandidates>;
  findPrunableModelRunEventIds(input: { cutoff: Date; limit: number }): Promise<string[]>;
  inspectOrphanedAttachments(input: { cutoff: Date; limit: number }): Promise<AttachmentInspection>;
  inspectStaleKnowledgePayloads(input: {
    cutoff: Date;
    limit: number;
  }): Promise<KnowledgePayloadInspection>;
  inspectExpiredKnowledgeTrash(input: {
    cutoff: Date;
    limit: number;
  }): Promise<KnowledgeTrashInspection>;
  inspectExpiredKnowledgeUploadSessions(input: {
    cutoff: Date;
    limit: number;
  }): Promise<KnowledgeUploadSessionInspection>;
  drainKnowledgeDeletionJobs(input: {
    leaseMinutes: number;
    limit: number;
    now: Date;
  }): Promise<KnowledgeDeletionDrainSummary>;
  finalizeKnowledgeDeletionJobs(input: { now: Date }): Promise<number>;
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
  stageStaleKnowledgePayloads(input: {
    cutoff: Date;
    limit: number;
    now: Date;
  }): Promise<KnowledgePayloadStageResult>;
  stageExpiredKnowledgeTrash(input: {
    cutoff: Date;
    limit: number;
    now: Date;
  }): Promise<KnowledgeTrashStageResult>;
  stageExpiredKnowledgeUploadSessions(input: {
    cutoff: Date;
    limit: number;
    now: Date;
  }): Promise<KnowledgeUploadSessionStageResult>;
};

export type PruneRetentionOptions = {
  authRetentionDays?: number;
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  dryRun?: boolean;
  eventRetentionDays?: number;
  knowledgePayloadRetentionDays?: number;
  knowledgeTrashRetentionDays?: number;
  knowledgeUploadSessionRetentionDays?: number;
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
  knowledgeJobs: KnowledgeDeletionDrainSummary & Readonly<{
    finalizedAfterObjectDeletion: number;
  }>;
  passes: number;
}>;

type RetentionCount = {
  deleted: number;
  matched: number;
};

export type PruneRetentionSummary = {
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
  dryRun: boolean;
  eventCutoff: string;
  inboundMcpOAuth: {
    authorizationCodes: RetentionCount;
    clients: RetentionCount;
    grants: RetentionCount;
    tokenFamilies: RetentionCount;
  };
  knowledgePayloadCutoff: string;
  knowledgePayloads: {
    jobsStaged: number;
    matched: number;
    objects: number;
    objectsReleased: number;
    sharedObjects: number;
    versionsPurged: number;
  };
  knowledgeTrash: {
    basesMatched: number;
    basesStaged: number;
    deletionJobs: KnowledgeDeletionDrainSummary & { finalizedAfterObjectDeletion: number };
    jobsStaged: number;
    sourcesMatched: number;
    sourcesStaged: number;
  };
  knowledgeTrashCutoff: string;
  knowledgeUploadSessionCutoff: string;
  knowledgeUploadSessions: {
    itemsMatched: number;
    itemsReleased: number;
    jobsStaged: number;
    multipartSessionsMatched: number;
    multipartSessionsReleased: number;
  };
  modelRunEvents: RetentionCount;
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

type LockedKnowledgeUploadSession = {
  batchId: string;
  id: string;
  multipartUploadId: string | null;
  storageKey: string;
};

function cutoffDate(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function deletionJobClaimableBefore(now: Date, leaseMinutes: number): Date {
  return new Date(now.getTime() - leaseMinutes * 60 * 1000);
}

export async function drainDeletionObligations(input: Readonly<{
  batchSize?: number;
  deletionJobLeaseMinutes?: number;
  maxPasses?: number;
  repository: RetentionRepository;
  storage: Pick<StorageAdapter, "deleteObject" | "directMultipartUpload">;
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
    knowledgeJobs: {
      blocked: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      finalizedAfterObjectDeletion: 0,
      waitingForObjects: 0
    },
    passes: 0
  };

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const now = new Date();
    const knowledge = await input.repository.drainKnowledgeDeletionJobs({
      leaseMinutes: deletionJobLeaseMinutes,
      limit: batchSize,
      now
    });
    const claims = await input.repository.claimAttachmentDeletionJobs({
      claimableBefore: deletionJobClaimableBefore(now, deletionJobLeaseMinutes),
      limit: batchSize,
      now
    });
    let completed = 0;
    let failed = 0;
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
        if (await input.repository.completeAttachmentDeletionJob({
          claimToken: claim.claimToken,
          id: claim.id
        })) completed += 1;
      } catch {
        failed += 1;
        await input.repository.releaseAttachmentDeletionJob({
          claimToken: claim.claimToken,
          errorCode: "object_delete_failed",
          id: claim.id,
          now
        });
      }
    }
    const finalized = await input.repository.finalizeKnowledgeDeletionJobs({ now });
    Object.assign(summary, {
      attachmentJobs: {
        claimed: summary.attachmentJobs.claimed + claims.length,
        completed: summary.attachmentJobs.completed + completed,
        failed: summary.attachmentJobs.failed + failed
      },
      knowledgeJobs: {
        blocked: summary.knowledgeJobs.blocked + knowledge.blocked,
        claimed: summary.knowledgeJobs.claimed + knowledge.claimed,
        completed: summary.knowledgeJobs.completed + knowledge.completed,
        failed: summary.knowledgeJobs.failed + knowledge.failed,
        finalizedAfterObjectDeletion:
          summary.knowledgeJobs.finalizedAfterObjectDeletion + finalized,
        waitingForObjects:
          summary.knowledgeJobs.waitingForObjects + knowledge.waitingForObjects
      },
      passes: pass
    });
    if (failed > 0 || knowledge.blocked > 0 || knowledge.failed > 0) return summary;
    if (knowledge.claimed === 0 && claims.length === 0 && finalized === 0) return summary;
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

function staleKnowledgePayloadWhere(cutoff: Date): Prisma.KnowledgeDocumentVersionWhereInput {
  return {
    currentFor: null,
    ingestCompletedAt: { lt: cutoff },
    ingestState: "failed",
    originalStorageKey: { not: null },
    payloadPurgedAt: null,
    visibleFromRevision: null
  };
}

function expiredKnowledgeUploadSessionWhere(cutoff: Date): Prisma.KnowledgeUploadItemWhereInput {
  return {
    sessionExpiresAt: { lt: cutoff },
    state: { in: ["QUEUED", "UPLOADING", "STORED", "NEEDS_ATTENTION"] },
    storageKey: { not: null }
  };
}

export function createPrismaRetentionRepository(prisma: PrismaClient): RetentionRepository {
  return {
    async claimAttachmentDeletionJobs({ claimableBefore, limit, now }) {
      const claimToken = randomUUID();
      const rows = await prisma.$transaction((tx) =>
        tx.$queryRaw<Array<{
          id: string;
          multipartUploadId: string | null;
          storageKey: string;
        }>>`
          WITH candidates AS (
            SELECT job."id"
            FROM "AttachmentDeletionJob" AS job
            WHERE (job."claimedAt" IS NULL OR job."claimedAt" < ${claimableBefore})
              AND NOT EXISTS (
                SELECT 1 FROM "Attachment" AS attachment
                WHERE attachment."storageKey" = job."storageKey"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeDocumentVersion" AS version
                WHERE version."originalStorageKey" = job."storageKey"
                  OR version."normalizedTextStorageKey" = job."storageKey"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeSourceVersion" AS version
                WHERE version."originalStorageKey" = job."storageKey"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeSourceIndexArtifact" AS artifact
                WHERE artifact."normalizedTextStorageKey" = job."storageKey"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeUploadItem" AS upload
                WHERE upload."storageKey" = job."storageKey"
              )
            ORDER BY job."createdAt", job."id"
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
        `
      );

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
        await tx.knowledgeDeletionObject.updateMany({
          data: { disposition: "DELETED", settledAt: new Date() },
          where: { disposition: "PENDING", storageKey: job.storageKey }
        });
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

      const result = await prisma.modelRunEvent.deleteMany({
        where: {
          id: {
            in: ids
          },
          modelRun: {
            status: {
              in: [...TERMINAL_MODEL_RUN_STATUSES]
            }
          }
        }
      });

      return result.count;
    },
    async findClaimableAttachmentDeletionJobIds({ claimableBefore, limit }) {
      const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT job."id"
        FROM "AttachmentDeletionJob" AS job
        WHERE (job."claimedAt" IS NULL OR job."claimedAt" < ${claimableBefore})
          AND NOT EXISTS (
            SELECT 1 FROM "Attachment" AS attachment
            WHERE attachment."storageKey" = job."storageKey"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeDocumentVersion" AS version
            WHERE version."originalStorageKey" = job."storageKey"
              OR version."normalizedTextStorageKey" = job."storageKey"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeSourceVersion" AS version
            WHERE version."originalStorageKey" = job."storageKey"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeSourceIndexArtifact" AS artifact
            WHERE artifact."normalizedTextStorageKey" = job."storageKey"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "KnowledgeUploadItem" AS upload
            WHERE upload."storageKey" = job."storageKey"
          )
        ORDER BY job."createdAt", job."id"
        LIMIT ${limit}
      `;

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
      const rows = await prisma.modelRunEvent.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true
        },
        take: limit,
        where: {
          createdAt: {
            lt: cutoff
          },
          modelRun: {
            status: {
              in: [...TERMINAL_MODEL_RUN_STATUSES]
            }
          }
        }
      });

      return rows.map((row) => row.id);
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
      const knowledgeReferences = await prisma.knowledgeDocumentVersion.findMany({
        select: { normalizedTextStorageKey: true, originalStorageKey: true },
        where: {
          OR: [
            { normalizedTextStorageKey: { in: storageKeys } },
            { originalStorageKey: { in: storageKeys } }
          ]
        }
      });
      for (const reference of knowledgeReferences) {
        if (reference.originalStorageKey) sharedKeys.add(reference.originalStorageKey);
        if (reference.normalizedTextStorageKey) sharedKeys.add(reference.normalizedTextStorageKey);
      }
      const sourceVersionReferences = await prisma.knowledgeSourceVersion.findMany({
        select: { originalStorageKey: true },
        where: { originalStorageKey: { in: storageKeys } }
      });
      for (const reference of sourceVersionReferences) {
        if (reference.originalStorageKey) sharedKeys.add(reference.originalStorageKey);
      }
      const sourceArtifactReferences = await prisma.knowledgeSourceIndexArtifact.findMany({
        select: { normalizedTextStorageKey: true },
        where: { normalizedTextStorageKey: { in: storageKeys } }
      });
      for (const reference of sourceArtifactReferences) {
        if (reference.normalizedTextStorageKey) sharedKeys.add(reference.normalizedTextStorageKey);
      }
      const uploadReferences = await prisma.knowledgeUploadItem.findMany({
        select: { storageKey: true },
        where: { storageKey: { in: storageKeys } }
      });
      for (const reference of uploadReferences) {
        if (reference.storageKey) sharedKeys.add(reference.storageKey);
      }

      return {
        matched: candidates.length,
        shared: candidates.filter((candidate) => sharedKeys.has(candidate.storageKey)).length
      };
    },
    async inspectStaleKnowledgePayloads({ cutoff, limit }) {
      const candidates = await prisma.knowledgeDocumentVersion.findMany({
        orderBy: [{ ingestCompletedAt: "asc" }, { id: "asc" }],
        select: { normalizedTextStorageKey: true, originalStorageKey: true },
        take: limit,
        where: staleKnowledgePayloadWhere(cutoff)
      });
      return {
        matched: candidates.length,
        objects: new Set(candidates.flatMap((candidate) => [
          ...(candidate.originalStorageKey ? [candidate.originalStorageKey] : []),
          ...(candidate.normalizedTextStorageKey ? [candidate.normalizedTextStorageKey] : [])
        ])).size
      };
    },
    async inspectExpiredKnowledgeTrash({ cutoff, limit }) {
      const [sources, bases] = await Promise.all([
        prisma.knowledgeSource.count({
          take: limit,
          where: { deletionRequestedAt: null, trashedAt: { lt: cutoff } }
        }),
        prisma.knowledgeBase.count({
          take: limit,
          where: { deletionRequestedAt: null, trashedAt: { lt: cutoff } }
        })
      ]);
      return { bases, sources };
    },
    async inspectExpiredKnowledgeUploadSessions({ cutoff, limit }) {
      const candidates = await prisma.knowledgeUploadItem.findMany({
        orderBy: [{ sessionExpiresAt: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
        select: { multipartUploadId: true },
        take: limit,
        where: expiredKnowledgeUploadSessionWhere(cutoff)
      });
      return {
        items: candidates.length,
        multipartSessions: candidates.filter(({ multipartUploadId }) => multipartUploadId !== null).length
      };
    },
    async drainKnowledgeDeletionJobs({ leaseMinutes, limit, now }) {
      return drainKnowledgeDeletionJobs({ client: prisma, leaseMinutes, limit, now });
    },
    async finalizeKnowledgeDeletionJobs({ now }) {
      return createPrismaKnowledgeDeletionProcessor(prisma).finalizeSettled(now);
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
    async stageExpiredKnowledgeTrash({ cutoff, limit, now }) {
      return prisma.$transaction(async (tx) => {
        const sources = await tx.knowledgeSource.findMany({
          orderBy: [{ trashedAt: "asc" }, { id: "asc" }],
          select: { id: true, ownerUserId: true },
          take: limit,
          where: { deletionRequestedAt: null, trashedAt: { lt: cutoff } }
        });
        const remaining = Math.max(0, limit - sources.length);
        const bases = remaining > 0
          ? await tx.knowledgeBase.findMany({
              orderBy: [{ trashedAt: "asc" }, { id: "asc" }],
              select: { id: true, ownerUserId: true },
              take: remaining,
              where: { deletionRequestedAt: null, trashedAt: { lt: cutoff } }
            })
          : [];
        let sourcesStaged = 0;
        let basesStaged = 0;
        for (const source of sources) {
          const updated = await tx.knowledgeSource.updateMany({
            data: { deletionRequestedAt: now, version: { increment: 1 } },
            where: { deletionRequestedAt: null, id: source.id, trashedAt: { lt: cutoff } }
          });
          if (updated.count !== 1) continue;
          await tx.knowledgeDeletionJob.create({
            data: { ownerUserId: source.ownerUserId, targetId: source.id, targetType: "SOURCE" }
          });
          sourcesStaged += 1;
        }
        for (const base of bases) {
          const updated = await tx.knowledgeBase.updateMany({
            data: { deletionRequestedAt: now, version: { increment: 1 } },
            where: { deletionRequestedAt: null, id: base.id, trashedAt: { lt: cutoff } }
          });
          if (updated.count !== 1) continue;
          await tx.knowledgeDeletionJob.create({
            data: { ownerUserId: base.ownerUserId, targetId: base.id, targetType: "BASE" }
          });
          basesStaged += 1;
        }
        return {
          bases: basesStaged,
          jobsStaged: sourcesStaged + basesStaged,
          sources: sourcesStaged
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
    async stageExpiredKnowledgeUploadSessions({ cutoff, limit, now }) {
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.$queryRaw<LockedKnowledgeUploadSession[]>`
          SELECT
            item."id",
            item."batchId",
            item."storageKey",
            item."multipartUploadId"
          FROM "KnowledgeUploadItem" AS item
          WHERE item."state" IN (
              'QUEUED'::"KnowledgeUploadItemState",
              'UPLOADING'::"KnowledgeUploadItemState",
              'STORED'::"KnowledgeUploadItemState",
              'NEEDS_ATTENTION'::"KnowledgeUploadItemState"
            )
            AND item."storageKey" IS NOT NULL
            AND item."sessionExpiresAt" < ${cutoff}
          ORDER BY item."sessionExpiresAt", item."updatedAt", item."id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        `;
        let itemsReleased = 0;
        let jobsStaged = 0;
        let multipartSessionsReleased = 0;
        const touchedBatchIds = new Set<string>();

        for (const candidate of candidates) {
          const existingJob = await tx.attachmentDeletionJob.findUnique({
            select: { id: true, multipartUploadId: true },
            where: { storageKey: candidate.storageKey }
          });
          if (!existingJob) {
            await tx.attachmentDeletionJob.create({
              data: {
                multipartUploadId: candidate.multipartUploadId,
                storageKey: candidate.storageKey
              }
            });
            jobsStaged += 1;
          } else if (!existingJob.multipartUploadId && candidate.multipartUploadId) {
            await tx.attachmentDeletionJob.update({
              data: { multipartUploadId: candidate.multipartUploadId },
              where: { id: existingJob.id }
            });
          }

          await tx.knowledgeUploadPart.deleteMany({ where: { uploadItemId: candidate.id } });
          const released = await tx.knowledgeUploadItem.updateMany({
            data: {
              errorCode: "knowledge_upload_session_expired",
              multipartUploadId: null,
              state: "NEEDS_ATTENTION",
              storageKey: null,
              uploadedByteSize: 0,
              updatedAt: now
            },
            where: {
              id: candidate.id,
              sessionExpiresAt: { lt: cutoff },
              state: { in: ["QUEUED", "UPLOADING", "STORED", "NEEDS_ATTENTION"] },
              storageKey: candidate.storageKey
            }
          });
          if (released.count !== 1) continue;
          itemsReleased += 1;
          if (candidate.multipartUploadId) multipartSessionsReleased += 1;
          touchedBatchIds.add(candidate.batchId);
        }

        if (touchedBatchIds.size > 0) {
          await tx.knowledgeUploadBatch.updateMany({
            data: { updatedAt: now },
            where: { id: { in: [...touchedBatchIds] } }
          });
        }

        return {
          items: candidates.length,
          itemsReleased,
          jobsStaged,
          multipartSessions: candidates.filter(({ multipartUploadId }) => multipartUploadId !== null).length,
          multipartSessionsReleased
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
          const knowledgeDocumentReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "KnowledgeDocumentVersion"
            WHERE "originalStorageKey" = ${storageKey} OR "normalizedTextStorageKey" = ${storageKey}
            FOR SHARE
          `;
          const knowledgeSourceVersionReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "KnowledgeSourceVersion"
            WHERE "originalStorageKey" = ${storageKey}
            FOR SHARE
          `;
          const knowledgeSourceArtifactReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "KnowledgeSourceIndexArtifact"
            WHERE "normalizedTextStorageKey" = ${storageKey}
            FOR SHARE
          `;
          const knowledgeUploadReferences = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "KnowledgeUploadItem"
            WHERE "storageKey" = ${storageKey}
            FOR SHARE
          `;
          if (
            remainingReferenceCount === 0 &&
            knowledgeDocumentReferences.length === 0 &&
            knowledgeSourceVersionReferences.length === 0 &&
            knowledgeSourceArtifactReferences.length === 0 &&
            knowledgeUploadReferences.length === 0
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
    },
    async stageStaleKnowledgePayloads({ cutoff, limit, now }) {
      return prisma.$transaction(async (tx) => {
        const candidates = await tx.knowledgeDocumentVersion.findMany({
          orderBy: [{ ingestCompletedAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            normalizedTextStorageKey: true,
            originalStorageKey: true
          },
          take: limit,
          where: staleKnowledgePayloadWhere(cutoff)
        });
        let jobsStaged = 0;
        let objectsReleased = 0;
        let sharedObjects = 0;
        let versionsPurged = 0;

        const candidateStorageKeys = [...new Set(candidates.flatMap((candidate) => [
          ...(candidate.originalStorageKey ? [candidate.originalStorageKey] : []),
          ...(candidate.normalizedTextStorageKey ? [candidate.normalizedTextStorageKey] : [])
        ]))].sort();
        for (const storageKey of candidateStorageKeys) {
          await tx.$queryRaw<Array<{ lock: string }>>`
            SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 260))::text AS "lock"
          `;
        }

        for (const candidate of candidates) {
          const rows = await tx.$queryRaw<Array<{
            normalizedTextStorageKey: string | null;
            originalStorageKey: string | null;
          }>>`
            SELECT "originalStorageKey", "normalizedTextStorageKey"
            FROM "KnowledgeDocumentVersion"
            WHERE "id" = ${candidate.id}
              AND "ingestState" = 'failed'::"KnowledgeDocumentIngestState"
              AND "ingestCompletedAt" < ${cutoff}
              AND "visibleFromRevision" IS NULL
              AND "payloadPurgedAt" IS NULL
              AND "originalStorageKey" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "KnowledgeDocument" AS document
                WHERE document."currentVersionId" = "KnowledgeDocumentVersion"."id"
              )
            FOR UPDATE
          `;
          const version = rows[0];
          if (!version?.originalStorageKey) continue;
          const storageKeys = [...new Set([
            version.originalStorageKey,
            ...(version.normalizedTextStorageKey ? [version.normalizedTextStorageKey] : [])
          ])].sort();

          await tx.usageEvent.deleteMany({
            where: { knowledgeDocumentVersionId: candidate.id }
          });
          await tx.knowledgeChunk.deleteMany({
            where: { documentVersionId: candidate.id }
          });

          for (const storageKey of storageKeys) {
            const attachmentReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "Attachment"
              WHERE "storageKey" = ${storageKey}
              FOR SHARE
            `;
            const knowledgeDocumentReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id"
              FROM "KnowledgeDocumentVersion"
              WHERE "id" <> ${candidate.id}
                AND ("originalStorageKey" = ${storageKey}
                  OR "normalizedTextStorageKey" = ${storageKey})
              FOR SHARE
            `;
            const knowledgeSourceVersionReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "KnowledgeSourceVersion"
              WHERE "originalStorageKey" = ${storageKey}
              FOR SHARE
            `;
            const knowledgeSourceArtifactReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "KnowledgeSourceIndexArtifact"
              WHERE "normalizedTextStorageKey" = ${storageKey}
              FOR SHARE
            `;
            const knowledgeUploadReferences = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "KnowledgeUploadItem"
              WHERE "storageKey" = ${storageKey}
              FOR SHARE
            `;
            if (
              attachmentReferences.length === 0 &&
              knowledgeDocumentReferences.length === 0 &&
              knowledgeSourceVersionReferences.length === 0 &&
              knowledgeSourceArtifactReferences.length === 0 &&
              knowledgeUploadReferences.length === 0
            ) {
              const existing = await tx.attachmentDeletionJob.findUnique({
                select: { id: true },
                where: { storageKey }
              });
              if (!existing) {
                await tx.attachmentDeletionJob.create({ data: { storageKey } });
                jobsStaged += 1;
              }
            } else {
              sharedObjects += 1;
            }
            objectsReleased += 1;
          }

          await tx.knowledgeDocumentVersion.update({
            data: {
              ingestChunkCount: null,
              ingestEmbeddedChunkCount: 0,
              normalizedTextByteSize: null,
              normalizedTextChecksum: null,
              normalizedTextStorageKey: null,
              originalStorageKey: null,
              payloadPurgedAt: now
            },
            where: { id: candidate.id }
          });
          versionsPurged += 1;
        }

        return {
          jobsStaged,
          matched: candidates.length,
          objectsReleased,
          sharedObjects,
          versionsPurged
        };
      });
    }
  };
}

function emptySummary(input: {
  authCutoff: Date;
  authFlowTokenIds: string[];
  authSessionIds: string[];
  deletionJobIds: string[];
  dryRun: boolean;
  eventCutoff: Date;
  eventIds: string[];
  inboundMcpOAuthCandidates: InboundMcpOAuthPruneCandidates;
  knowledgePayloadCutoff: Date;
  knowledgePayloadInspection: KnowledgePayloadInspection;
  knowledgeTrashCutoff: Date;
  knowledgeTrashInspection: KnowledgeTrashInspection;
  knowledgeUploadSessionCutoff: Date;
  knowledgeUploadSessionInspection: KnowledgeUploadSessionInspection;
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
    authCutoff: input.authCutoff.toISOString(),
    authFlowTokens: {
      deleted: 0,
      matched: input.authFlowTokenIds.length
    },
    authSessions: {
      deleted: 0,
      matched: input.authSessionIds.length
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
    knowledgePayloadCutoff: input.knowledgePayloadCutoff.toISOString(),
    knowledgePayloads: {
      jobsStaged: 0,
      matched: input.knowledgePayloadInspection.matched,
      objects: input.knowledgePayloadInspection.objects,
      objectsReleased: 0,
      sharedObjects: 0,
      versionsPurged: 0
    },
    knowledgeTrash: {
      basesMatched: input.knowledgeTrashInspection.bases,
      basesStaged: 0,
      deletionJobs: {
        blocked: 0,
        claimed: 0,
        completed: 0,
        failed: 0,
        finalizedAfterObjectDeletion: 0,
        waitingForObjects: 0
      },
      jobsStaged: 0,
      sourcesMatched: input.knowledgeTrashInspection.sources,
      sourcesStaged: 0
    },
    knowledgeTrashCutoff: input.knowledgeTrashCutoff.toISOString(),
    knowledgeUploadSessionCutoff: input.knowledgeUploadSessionCutoff.toISOString(),
    knowledgeUploadSessions: {
      itemsMatched: input.knowledgeUploadSessionInspection.items,
      itemsReleased: 0,
      jobsStaged: 0,
      multipartSessionsMatched: input.knowledgeUploadSessionInspection.multipartSessions,
      multipartSessionsReleased: 0
    },
    modelRunEvents: {
      deleted: 0,
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
  const knowledgePayloadRetentionDays = positiveInteger(
    options.knowledgePayloadRetentionDays,
    DEFAULT_KNOWLEDGE_PAYLOAD_RETENTION_DAYS
  );
  const knowledgeTrashRetentionDays = positiveInteger(
    options.knowledgeTrashRetentionDays,
    DEFAULT_KNOWLEDGE_TRASH_RETENTION_DAYS
  );
  const knowledgeUploadSessionRetentionDays = positiveInteger(
    options.knowledgeUploadSessionRetentionDays,
    DEFAULT_KNOWLEDGE_UPLOAD_SESSION_RETENTION_DAYS
  );
  const deletionJobLeaseMinutes = positiveInteger(
    options.deletionJobLeaseMinutes,
    DEFAULT_DELETION_JOB_LEASE_MINUTES
  );
  const dryRun = options.dryRun ?? true;
  const eventCutoff = cutoffDate(now, eventRetentionDays);
  const orphanAttachmentCutoff = cutoffDate(now, orphanAttachmentRetentionDays);
  const authCutoff = cutoffDate(now, authRetentionDays);
  const knowledgePayloadCutoff = cutoffDate(now, knowledgePayloadRetentionDays);
  const knowledgeTrashCutoff = cutoffDate(now, knowledgeTrashRetentionDays);
  const knowledgeUploadSessionCutoff = cutoffDate(now, knowledgeUploadSessionRetentionDays);
  const claimableBefore = deletionJobClaimableBefore(now, deletionJobLeaseMinutes);
  const [
    eventIds,
    orphanInspection,
    knowledgePayloadInspection,
    knowledgeTrashInspection,
    knowledgeUploadSessionInspection,
    authSessionIds,
    authFlowTokenIds,
    inboundMcpOAuthCandidates,
    initialDeletionJobIds
  ] = await Promise.all([
    options.repository.findPrunableModelRunEventIds({ cutoff: eventCutoff, limit: batchSize }),
    options.repository.inspectOrphanedAttachments({ cutoff: orphanAttachmentCutoff, limit: batchSize }),
    options.repository.inspectStaleKnowledgePayloads({ cutoff: knowledgePayloadCutoff, limit: batchSize }),
    options.repository.inspectExpiredKnowledgeTrash({ cutoff: knowledgeTrashCutoff, limit: batchSize }),
    options.repository.inspectExpiredKnowledgeUploadSessions({
      cutoff: knowledgeUploadSessionCutoff,
      limit: batchSize
    }),
    options.repository.findPrunableAuthSessionIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableAuthFlowTokenIds({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findPrunableInboundMcpOAuth({ cutoff: authCutoff, limit: batchSize }),
    options.repository.findClaimableAttachmentDeletionJobIds({ claimableBefore, limit: batchSize })
  ]);
  const summary = emptySummary({
    authCutoff,
    authFlowTokenIds,
    authSessionIds,
    deletionJobIds: initialDeletionJobIds,
    dryRun,
    eventCutoff,
    eventIds,
    inboundMcpOAuthCandidates,
    knowledgePayloadCutoff,
    knowledgePayloadInspection,
    knowledgeTrashCutoff,
    knowledgeTrashInspection,
    knowledgeUploadSessionCutoff,
    knowledgeUploadSessionInspection,
    orphanAttachmentCutoff,
    orphanInspection
  });

  if (dryRun) {
    return summary;
  }

  const [deletedEvents, deletedSessions, deletedFlowTokens, deletedInboundMcpOAuth] = await Promise.all([
    options.repository.deleteModelRunEvents(eventIds),
    options.repository.deleteAuthSessions({ cutoff: authCutoff, ids: authSessionIds }),
    options.repository.deleteAuthFlowTokens({ cutoff: authCutoff, ids: authFlowTokenIds }),
    options.repository.deletePrunableInboundMcpOAuth({
      candidates: inboundMcpOAuthCandidates,
      cutoff: authCutoff
    })
  ]);
  const stagedKnowledgeTrash = await options.repository.stageExpiredKnowledgeTrash({
    cutoff: knowledgeTrashCutoff,
    limit: batchSize,
    now
  });
  const knowledgeDeletionJobs = await options.repository.drainKnowledgeDeletionJobs({
    leaseMinutes: deletionJobLeaseMinutes,
    limit: batchSize,
    now
  });
  const stagedKnowledgeUploadSessions = await options.repository.stageExpiredKnowledgeUploadSessions({
    cutoff: knowledgeUploadSessionCutoff,
    limit: batchSize,
    now
  });
  // These stages can touch the same private object key. Keep them sequential so
  // each stage observes references released by the previous stage.
  const stagedAttachments = await options.repository.stageOrphanedAttachments({
    cutoff: orphanAttachmentCutoff,
    limit: batchSize
  });
  const stagedKnowledgePayloads = await options.repository.stageStaleKnowledgePayloads({
    cutoff: knowledgePayloadCutoff,
    limit: batchSize,
    now
  });
  const claimableDeletionJobIds = await options.repository.findClaimableAttachmentDeletionJobIds({
    claimableBefore,
    limit: batchSize
  });
  const claims = await options.repository.claimAttachmentDeletionJobs({
    claimableBefore,
    limit: batchSize,
    now
  });

  summary.modelRunEvents.deleted = deletedEvents;
  summary.authSessions.deleted = deletedSessions;
  summary.authFlowTokens.deleted = deletedFlowTokens;
  summary.inboundMcpOAuth.authorizationCodes.deleted = deletedInboundMcpOAuth.authorizationCodes;
  summary.inboundMcpOAuth.clients.deleted = deletedInboundMcpOAuth.clients;
  summary.inboundMcpOAuth.grants.deleted = deletedInboundMcpOAuth.grants;
  summary.inboundMcpOAuth.tokenFamilies.deleted = deletedInboundMcpOAuth.tokenFamilies;
  summary.knowledgePayloads = {
    jobsStaged: stagedKnowledgePayloads.jobsStaged,
    matched: stagedKnowledgePayloads.matched,
    objects: knowledgePayloadInspection.objects,
    objectsReleased: stagedKnowledgePayloads.objectsReleased,
    sharedObjects: stagedKnowledgePayloads.sharedObjects,
    versionsPurged: stagedKnowledgePayloads.versionsPurged
  };
  summary.knowledgeUploadSessions = {
    itemsMatched: stagedKnowledgeUploadSessions.items,
    itemsReleased: stagedKnowledgeUploadSessions.itemsReleased,
    jobsStaged: stagedKnowledgeUploadSessions.jobsStaged,
    multipartSessionsMatched: stagedKnowledgeUploadSessions.multipartSessions,
    multipartSessionsReleased: stagedKnowledgeUploadSessions.multipartSessionsReleased
  };
  summary.orphanedAttachments = {
    jobsStaged: stagedAttachments.jobsStaged,
    matched: stagedAttachments.matched,
    rowsDeleted: stagedAttachments.rowsDeleted,
    shared: stagedAttachments.sharedRowsDeleted
  };
  summary.attachmentDeletionJobs.matched = claimableDeletionJobIds.length;
  summary.attachmentDeletionJobs.claimed = claims.length;

  for (const claim of claims) {
    try {
      if (claim.multipartUploadId) {
        if (!options.storage.directMultipartUpload) {
          throw new Error("multipart_abort_unavailable");
        }
        await options.storage.directMultipartUpload.abortMultipartUpload({
          storageKey: claim.storageKey,
          uploadId: claim.multipartUploadId
        });
      }
      await options.storage.deleteObject(claim.storageKey);
      summary.attachmentDeletionJobs.objectsDeleted += 1;
      if (
        await options.repository.completeAttachmentDeletionJob({
          claimToken: claim.claimToken,
          id: claim.id
        })
      ) {
        summary.attachmentDeletionJobs.completed += 1;
      }
    } catch {
      summary.attachmentDeletionJobs.failedJobs.push({
        code: "object_delete_failed",
        id: claim.id
      });
      await options.repository.releaseAttachmentDeletionJob({
        claimToken: claim.claimToken,
        errorCode: "object_delete_failed",
        id: claim.id,
        now
      });
    }
  }

  const finalizedKnowledgeJobs = await options.repository.finalizeKnowledgeDeletionJobs({ now });
  summary.knowledgeTrash = {
    basesMatched: knowledgeTrashInspection.bases,
    basesStaged: stagedKnowledgeTrash.bases,
    deletionJobs: {
      ...knowledgeDeletionJobs,
      finalizedAfterObjectDeletion: finalizedKnowledgeJobs
    },
    jobsStaged: stagedKnowledgeTrash.jobsStaged,
    sourcesMatched: knowledgeTrashInspection.sources,
    sourcesStaged: stagedKnowledgeTrash.sources
  };

  return summary;
}
